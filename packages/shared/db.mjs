import pg from "pg";

const pools = new Map();

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
  return pool.query(text, params);
}

export async function withTransaction(name, fn) {
  const pool = getPool(name);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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
