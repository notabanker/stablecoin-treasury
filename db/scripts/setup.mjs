import pg from "pg";
import { runMigrations } from "./migrate.mjs";

const adminUrl = process.env.DATABASE_ADMIN_URL || "postgres://127.0.0.1:5432/postgres";
const devDb = process.env.DEV_DB_NAME || "treasury_dev";
const testDb = process.env.TEST_DB_NAME || "treasury_test";

async function ensureDatabase(name) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (rows.length === 0) {
      // Database names can't be parameterized; `name` is developer-supplied config (env var),
      // not end-user input, so string interpolation here is not an injection vector.
      await client.query(`CREATE DATABASE "${name}"`);
      console.log(`created database ${name}`);
    } else {
      console.log(`database ${name} already exists`);
    }
  } finally {
    await client.end();
  }
}

function urlFor(name) {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

await ensureDatabase(devDb);
await ensureDatabase(testDb);
await runMigrations(urlFor(devDb));
await runMigrations(urlFor(testDb));
console.log("db:setup complete");
