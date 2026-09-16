import pg from "pg";

// Shared Postgres helpers for integration tests: service-role connections and admin
// connections against a started stack's per-test database.

export const SERVICE_DB_PASSWORD = process.env.SERVICE_DB_PASSWORD || "service-dev-password";

function adminUrlParts(stack) {
  const admin = new URL(stack._env.DATABASE_URL);
  return { hostname: admin.hostname, port: admin.port || "5432", pathname: admin.pathname };
}

export function roleUrl(stack, role) {
  const { hostname, port, pathname } = adminUrlParts(stack);
  return `postgres://${role}:${SERVICE_DB_PASSWORD}@${hostname}:${port}${pathname}`;
}

export function adminClient(stack) {
  return new pg.Client({ connectionString: stack._env.DATABASE_URL });
}

export function roleClient(stack, role) {
  return new pg.Client({ connectionString: roleUrl(stack, role) });
}

// Open one connection, run fn(client), always close. Accepts a stack or a connection string.
export async function withDb(stackOrUrl, fn) {
  const connectionString = typeof stackOrUrl === "string" ? stackOrUrl : stackOrUrl._env.DATABASE_URL;
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

// Run a single statement with a service role, optionally inside the RLS tenant context that
// packages/shared/db.mjs sets for request-scoped queries.
export async function asRole(stack, role, tenantId, statement, params = []) {
  return withDb(roleUrl(stack, role), async (client) => {
    await client.query("BEGIN");
    try {
      if (tenantId) {
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      }
      const result = await client.query(statement, params);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
}
