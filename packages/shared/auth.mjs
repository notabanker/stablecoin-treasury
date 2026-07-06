import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { insertAuditEvent } from "./audit.mjs";
import { query } from "./db.mjs";
import { httpError } from "./http.mjs";
import { DEFAULT_TENANT_ID } from "./tenant.mjs";

const DB = "identity";
const SESSION_TTL_HOURS = Number(process.env.SESSION_ABSOLUTE_TTL_HOURS || 24);
const SESSION_IDLE_TTL_MINUTES = Number(process.env.SESSION_IDLE_TTL_MINUTES || 0);
const SESSION_IDLE_BUMP_GRACE_MS = 60_000; // bump expires_at at most once per minute
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

// __Host- prefix: when SESSION_COOKIE_SECURE=true, use the Host-prefixed cookie names.
// The __Host- prefix requires Secure, Path=/, and no Domain — all already true in the
// cookie-building functions. The prefix is not used when SECURE is off (local dev).
let useHostPrefix = process.env.SESSION_COOKIE_SECURE === "true";
const SESSION_COOKIE_NAME = useHostPrefix ? "__Host-session" : "session";
const CSRF_COOKIE_NAME = useHostPrefix ? "__Host-csrf" : "csrf";

// Login rate limiter: keyed by (ip, email). Failed attempts increment; successful login clears.
const LOGIN_WINDOW_MS = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 60000);
const LOGIN_MAX_FAILURES = Number(process.env.LOGIN_RATE_LIMIT_MAX || 5);
const LOGIN_LOCKOUT_MS = Number(process.env.LOGIN_LOCKOUT_MS || 300000);
const loginFailures = new Map();
let loginCleanupTimer = null;

function loginBucket(ip, email) {
  const key = `${ip}|${String(email || "").toLowerCase()}`;
  const now = Date.now();
  let bucket = loginFailures.get(key);
  if (!bucket || bucket.windowStart + LOGIN_WINDOW_MS <= now) {
    bucket = { count: 0, windowStart: now, lockedUntil: 0 };
    loginFailures.set(key, bucket);
    loginCleanupTimer ||= setInterval(() => {
      const t = Date.now();
      for (const [k, b] of loginFailures) {
        if (b.windowStart + LOGIN_WINDOW_MS <= t && b.lockedUntil <= t) loginFailures.delete(k);
      }
      if (loginFailures.size === 0) { clearInterval(loginCleanupTimer); loginCleanupTimer = null; }
    }, Math.max(LOGIN_WINDOW_MS, 30000)).unref();
  }
  return { key, bucket, now };
}

export function checkLoginRateLimit(ip, email) {
  const { bucket } = loginBucket(ip, email);
  if (bucket.lockedUntil > Date.now()) {
    return { allowed: false, retryAfterMs: bucket.lockedUntil - Date.now() };
  }
  return { allowed: true };
}

export function recordLoginFailure(ip, email) {
  const { bucket, now } = loginBucket(ip, email);
  bucket.count += 1;
  if (bucket.count >= LOGIN_MAX_FAILURES) {
    bucket.lockedUntil = now + LOGIN_LOCKOUT_MS;
    return { lockedOut: true, lockoutUntil: bucket.lockedUntil };
  }
  return { lockedOut: false, failures: bucket.count };
}

export function clearLoginFailures(ip, email) {
  loginFailures.delete(`${ip}|${String(email || "").toLowerCase()}`);
}

export async function emitSecurityAudit({ tenantId = DEFAULT_TENANT_ID, actor, action, object, detail } = {}) {
  try {
    await insertAuditEvent("operations", {
      id: randomBytes(8).toString("hex"),
      tenantId,
      actor,
      action,
      object,
      detail: detail || "",
      at: new Date()
    });
  } catch (error) {
    // Fail-open by design: an audit insert failure must never block login/logout.
    // A dropped event is a MISSING row, not a chain break — the hash chain proves the
    // integrity of recorded events, not the completeness of events that failed to record.
    // Log loudly so operators can spot systematic drops.
    console.error(JSON.stringify({
      at: new Date().toISOString(),
      event: "security_audit_insert_failed",
      action,
      message: error.message
    }));
  }
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(String(password), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM
  }).toString("base64url");
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash}`;
}

export function verifyPassword(password, hash) {
  if (String(hash || "").startsWith("scrypt$")) {
    return verifyScryptPassword(password, hash);
  }
  return timingSafeStringEqual(legacySha256(password), hash);
}

function generateToken() {
  return randomBytes(32).toString("hex");
}

export async function createSession(userId, tenantId = DEFAULT_TENANT_ID) {
  const token = generateToken();
  const csrfToken = randomBytes(16).toString("hex");
  const now = Date.now();
  const absoluteExpiresAt = now + SESSION_TTL_HOURS * 3600_000;
  const idleExpiresAt = SESSION_IDLE_TTL_MINUTES > 0
    ? now + SESSION_IDLE_TTL_MINUTES * 60_000
    : absoluteExpiresAt;
  const expiresAt = new Date(Math.min(idleExpiresAt, absoluteExpiresAt)).toISOString();
  await query(
    DB,
    `INSERT INTO identity.sessions (user_id, tenant_id, token, csrf_token, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, tenantId, token, csrfToken, expiresAt]
  );
  return { token, csrfToken, expiresAt };
}

export async function destroySession(token) {
  await query(DB, "DELETE FROM identity.sessions WHERE token = $1", [token]);
}

export async function authenticateUser(email, password) {
  // Emails are unique per tenant, not globally: the same email may exist in two
  // tenants with different passwords, so the password decides which user matches.
  const users = await resolveUsersByEmail(email);
  let matching = null;
  for (const row of users) {
    if (verifyPassword(password, row.password_hash)) {
      matching = row;
      break;
    }
  }
  if (!matching) return null;
  if (needsPasswordRehash(matching.password_hash)) {
    await query(DB, "UPDATE identity.users SET password_hash = $1 WHERE id = $2", [hashPassword(password), matching.id]);
  }
  return {
    id: matching.id,
    email: matching.email,
    displayName: matching.display_name,
    tenantId: matching.tenant_id,
    roles: await loadRoles(matching.id)
  };
}

async function resolveUsersByEmail(email) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const { rows } = await query(
    DB,
    `SELECT *
       FROM identity.users
      WHERE lower(email) = $1
        AND status = 'active'
      ORDER BY tenant_id
      LIMIT 2`,
    [normalizedEmail]
  );
  return rows;
}

// Resolve a user by email without password verification, for tenant-scoped audit
// attribution on failed logins. Returns the raw DB row (including password_hash —
// callers must never expose it) or null if no active user matches. If the same
// email exists in multiple tenants, the lowest tenant_id wins deterministically.
export async function resolveUserByEmail(email) {
  const rows = await resolveUsersByEmail(email);
  return rows[0] || null;
}

export function needsPasswordRehash(hash) {
  return !String(hash || "").startsWith(`scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$`);
}

function verifyScryptPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6) return false;
  const [, nRaw, rRaw, pRaw, salt, expectedHash] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p) || !salt || !expectedHash) {
    return false;
  }
  try {
    const actual = scryptSync(String(password), salt, SCRYPT_KEYLEN, { N: n, r, p, maxmem: SCRYPT_MAXMEM }).toString("base64url");
    return timingSafeStringEqual(actual, expectedHash);
  } catch {
    return false;
  }
}

function legacySha256(password) {
  return createHash("sha256").update(String(password)).digest("hex");
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function validateSession(token) {
  if (!token) return null;
  const { rows } = await query(
    DB,
    `SELECT s.*, u.email, u.display_name, u.tenant_id
     FROM identity.sessions s
     JOIN identity.users u ON s.user_id = u.id
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token]
  );
  if (!rows[0]) return null;
  const session = rows[0];

  // Idle timeout: if SESSION_IDLE_TTL_MINUTES is set (> 0), bump expires_at
  // forward on each validation, but at most once per SESSION_IDLE_BUMP_GRACE_MS
  // to avoid write amplification. Never exceed created_at + absolute TTL.
  if (SESSION_IDLE_TTL_MINUTES > 0) {
    const now = Date.now();
    const expiresMs = new Date(session.expires_at).getTime();
    const idleDeadline = now + SESSION_IDLE_TTL_MINUTES * 60_000;
    if (idleDeadline > expiresMs + SESSION_IDLE_BUMP_GRACE_MS) {
      const absCap = new Date(session.created_at).getTime() + SESSION_TTL_HOURS * 3600_000;
      const newExpires = new Date(Math.min(idleDeadline, absCap));
      if (newExpires.getTime() > expiresMs) {
        await query(DB, "UPDATE identity.sessions SET expires_at = $1 WHERE token = $2",
          [newExpires.toISOString(), token]);
        session.expires_at = newExpires.toISOString();
      }
    }
  }

  return {
    userId: session.user_id,
    email: session.email,
    displayName: session.display_name,
    tenantId: session.tenant_id,
    csrfToken: session.csrf_token || "",
    roles: await loadRoles(session.user_id),
    sessionToken: token
  };
}

export function verifyCsrf(sessionUser, headerToken, { authSource } = {}) {
  // Bearer-auth users can't read the csrf cookie; skip CSRF for them.
  if (authSource === "bearer") return true;
  // Cookie-authenticated MUST have a non-empty csrfToken and present a matching header.
  if (!sessionUser?.csrfToken) return false;
  return String(headerToken || "") === String(sessionUser.csrfToken);
}

export function sessionCookieHeader(token, expiresAt, { httpOnly = true } = {}) {
  const secure = process.env.SESSION_COOKIE_SECURE === "true";
  const maxAge = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
  let cookie = `${SESSION_COOKIE_NAME}=${token}; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
  if (httpOnly) cookie += "; HttpOnly";
  if (secure) cookie += "; Secure";
  return cookie;
}

export function csrfCookieHeader(token, expiresAt) {
  const secure = process.env.SESSION_COOKIE_SECURE === "true";
  const maxAge = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
  let cookie = `${CSRF_COOKIE_NAME}=${token}; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
  if (secure) cookie += "; Secure";
  return cookie;
}

export function sessionCookieName() {
  return SESSION_COOKIE_NAME;
}

export function csrfCookieName() {
  return CSRF_COOKIE_NAME;
}

// CSRF-protected requireAuth: for cookie-authenticated sessions, require a matching
// X-Csrf-Token header on mutating requests (POST/PUT/PATCH/DELETE). Bearer-authenticated
// requests skip CSRF validation (they can't read the cookie anyway).
export function requireAuthWithCsrf(routeHandler, opts = {}) {
  return requireAuth(async (context) => {
    const isCookieAuth = AUTH_REQUIRED && context.user?._authSource === "cookie";
    const isMutation = !["GET", "HEAD", "OPTIONS"].includes(context.method);
    if (isCookieAuth && isMutation) {
      const headerToken = context.headers["x-csrf-token"] || "";
      if (!verifyCsrf(context.user, headerToken, { authSource: "cookie" })) {
        throw httpError(403, "CSRF token mismatch", "csrf_invalid");
      }
    }
    return routeHandler(context);
  }, opts);
}

const AUTH_REQUIRED = process.env.AUTH_REQUIRED === "true";

export function requireAuth(routeHandler, { optional = false } = {}) {
  return async (context) => {
    const token = extractToken(context.headers);
    const authSource = context.headers["cookie"]?.includes("session=") ? "cookie"
      : context.headers["authorization"]?.startsWith("Bearer ") ? "bearer"
      : null;
    const user = token ? await validateSession(token) : null;
    if (user) user._authSource = authSource;

    if (!AUTH_REQUIRED) {
      context.user = user || {
        userId: "00000000-0000-0000-0000-000000000000",
        displayName: "System",
        email: "system",
        roles: ["System"],
        tenantId: DEFAULT_TENANT_ID
      };
      context.tenantId = context.user.tenantId || DEFAULT_TENANT_ID;
      return routeHandler(context);
    }

    if (!user && !optional) {
      throw httpError(401, "Authentication required", "unauthorized");
    }

    context.user = user || { userId: "anon", displayName: "Guest", tenantId: DEFAULT_TENANT_ID };
    context.tenantId = user ? user.tenantId : DEFAULT_TENANT_ID;

    return routeHandler(context);
  };
}

export async function hasPermission(userId, tenantId, permission) {
  if (!AUTH_REQUIRED) return true; // Auth not enforced, grant all permissions
  const { rows } = await query(
    DB,
    `SELECT 1
     FROM identity.user_roles ur
     JOIN identity.role_permissions rp ON ur.role_id = rp.role_id
     JOIN identity.roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1
       AND r.tenant_id = $2
       AND rp.permission = $3
     LIMIT 1`,
    [userId, tenantId, permission]
  );
  return rows.length > 0;
}

async function loadRoles(userId) {
  const { rows } = await query(
    DB,
    `SELECT r.name
       FROM identity.user_roles ur
       JOIN identity.roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1
      ORDER BY r.name`,
    [userId]
  );
  return rows.map((row) => row.name);
}

export function requirePermission(permission) {
  return (handler) => requireAuthWithCsrf(async (context) => {
    if (!AUTH_REQUIRED) return handler(context);

    const user = context.user;
    if (!user || !user.userId) {
      throw httpError(401, "Authentication required", "unauthorized");
    }

    const allowed = await hasPermission(user.userId, user.tenantId, permission);
    if (!allowed) {
      throw httpError(403, `Missing required permission: ${permission}`, "forbidden");
    }

    return handler(context);
  });
}

function extractToken(headers) {
  // Prefer Authorization: Bearer <token> header
  const authHeader = headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Accept both plain and __Host- prefixed session cookie names
  const cookieHeader = headers["cookie"];
  if (cookieHeader) {
    const cookies = parseCookies(cookieHeader);
    return cookies["__Host-session"] || cookies["session"] || null;
  }

  return null;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }
  return cookies;
}
