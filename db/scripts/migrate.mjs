import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
const connectionString = process.env.DATABASE_URL || "postgres://127.0.0.1:5432/treasury_dev";

export async function runMigrations(connString = connectionString, { quiet = false } = {}) {
  const client = new pg.Client({ connectionString: connString });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort();

    const { rows: applied } = await client.query("SELECT filename FROM public.schema_migrations");
    const appliedSet = new Set(applied.map((row) => row.filename));

    for (const file of files) {
      if (appliedSet.has(file)) continue;
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO public.schema_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
        if (!quiet) console.log(`applied ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${error.message}`);
      }
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
