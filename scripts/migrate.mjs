import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "db", "migrations");
const BASELINE = "0000_baseline";
const LAST_ECTO_MIGRATION = "20261015221309";

function connectionString() {
  const url =
    process.env.DATABASE_URL ?? "postgres://manfrod:qLmVMeXiYyy65ADb@localhost:35232/manfrod";
  return url.replace(/^ecto:\/\//, "postgres://");
}

export async function migrate({ log = console.log } = {}) {
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ts_schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamp without time zone NOT NULL DEFAULT timezone('UTC', now())
      )
    `);

    const ecto = await client.query("SELECT to_regclass('public.schema_migrations') AS t");
    if (ecto.rows[0].t !== null) {
      const { rows } = await client.query("SELECT max(version)::text AS version FROM schema_migrations");
      const version = rows[0].version;
      if (version !== null && version < LAST_ECTO_MIGRATION) {
        throw new Error(
          `database is at Ecto migration ${version}, expected ${LAST_ECTO_MIGRATION}. Deploy the latest Phoenix release (or run its migrations) before switching to this app.`,
        );
      }
    }

    const applied = new Set(
      (await client.query("SELECT version FROM ts_schema_migrations")).rows.map((row) => row.version),
    );

    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (applied.has(version)) continue;

      if (version === BASELINE) {
        const existing = await client.query("SELECT to_regclass('public.users') AS users");
        if (existing.rows[0].users !== null) {
          await client.query("INSERT INTO ts_schema_migrations (version) VALUES ($1)", [version]);
          log(`migrate: ${version} skipped, schema already present`);
          continue;
        }
      }

      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO ts_schema_migrations (version) VALUES ($1)", [version]);
        await client.query("COMMIT");
        log(`migrate: ${version} applied`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${version} failed: ${error.message}`, { cause: error });
      }
    }

    const reset = await client.query("DELETE FROM jobs WHERE kind = 'skill_trigger' AND state = 'scheduled'");
    if (reset.rowCount > 0) log(`migrate: reset ${reset.rowCount} pending skill trigger(s)`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
