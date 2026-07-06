import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

const pools = new Map();

// Tenant context for row-level security (V6 Epic 2.2). RLS policies read
// current_setting('app.tenant_id', true); when it is unset they return zero rows (fail
// closed). The context is entered per request by createJsonService (from the X-Tenant-Id
// header) and explicitly by non-request code paths (seeds, bootstraps, audit inserts,
// webhook processing) whose data tenant differs from — or exists without — a request.
const tenantStorage = new AsyncLocalStorage();

export function runWithTenant(tenantId, fn) {
  return tenantStorage.run(tenantId || null, fn);
}

export function currentTenantId() {
  return tenantStorage.getStore() || null;
}

async function setTenantConfig(client, tenantId) {
  // set_config(..., true) is transaction-local: it vanishes on COMMIT/ROLLBACK, so pooled
  // connections never leak a tenant across checkouts.
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [String(tenantId)]);
}

export function getPool(name) {
  if (pools.has(name)) return pools.get(name);
  const connectionString = process.env.DATABASE_URL || "postgres://127.0.0.1:5432/treasury_dev";
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX || 10),
    statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 5000),
    idle_in_transaction_session_timeout: Number(process.env.DB_IDLE_TX_TIMEOUT_MS || 5000)
  });
  pool.on("error", (error) => {
    // A pooled client that errors while idle (e.g. the connection was dropped) must not crash
    // the process -- pg's Pool emits 'error' for exactly this case and expects a handler.
    console.error(JSON.stringify({ at: new Date().toISOString(), event: "db_pool_error", pool: name, message: error.message }));
  });
  pools.set(name, pool);
  return pool;
}

export async function query(name, text, params) {
  const pool = getPool(name);
  const tenantId = currentTenantId();
  if (!tenantId) {
    return pool.query(text, params);
  }
  // A tenant context exists: run the statement inside a transaction so the
  // transaction-local app.tenant_id setting is visible to RLS policies.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await setTenantConfig(client, tenantId);
    const result = await client.query(text, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function withTransaction(name, fn, { tenantId } = {}) {
  const pool = getPool(name);
  const client = await pool.connect();
  const effectiveTenant = tenantId ?? currentTenantId();
  try {
    await client.query("BEGIN");
    if (effectiveTenant) {
      await setTenantConfig(client, effectiveTenant);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closeAllPools() {
  await Promise.all([...pools.values()].map((pool) => pool.end()));
  pools.clear();
}
