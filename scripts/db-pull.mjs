import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const out = "db/drizzle";
const pull = spawnSync("drizzle-kit", ["pull"], { stdio: "inherit" });
if (pull.status !== 0) process.exit(pull.status ?? 1);

for (const entry of readdirSync(out)) {
  if (entry.endsWith(".sql") || entry === "meta") rmSync(path.join(out, entry), { recursive: true, force: true });
}

const schemaPath = path.join(out, "schema.ts");
let schema = readFileSync(schemaPath, "utf8")
  .replace(/timestamp\(("[^"]+"), \{ mode: 'string' \}\)/g, "timestamp($1, { mode: 'date' })")
  .replace(/timestamp\(("[^"]+"), \{ precision: (\d+), mode: 'string' \}\)/g, "timestamp($1, { precision: $2, mode: 'date' })")
  .replace(/timestamp\(\{ mode: 'string' \}\)/g, "timestamp({ mode: 'date' })")
  .replace(/bigserial\(\{ mode: "bigint" \}\)/g, 'bigserial({ mode: "number" })')
  .replace(/\t+foreignKey\(\{[\s\S]*?\}\)(\.on(Delete|Update)\("[^"]+"\))*,\n/g, "")
  .replace(/\.default\(\["RAY\['([^']+)'::character varyin"\]\)/g, ".default(sql`ARRAY['$1']::varchar[]`)")
  .replace(/\.default\(\["RAY"\]\)/g, ".default(sql`ARRAY[]::varchar[]`)")
  .replace(/\t\/\/ TODO: failed to parse database type 'bytea'\n\t(\w+): unknown\(("[^"]+")\)/g, "\t$1: bytea($2)");

if (schema.includes("bytea(")) {
  schema = schema.replace(
    'import { sql } from "drizzle-orm"',
    'import { sql } from "drizzle-orm"\nimport { bytea } from "../../lib/db/types.ts"',
  );
}

const leftovers = schema.match(/TODO: failed to parse[^\n]*/g);
if (leftovers) {
  console.error(`db:pull: unhandled column types:\n${[...new Set(leftovers)].join("\n")}`);
  process.exit(1);
}

writeFileSync(schemaPath, schema);
console.log("db:pull: schema written to db/drizzle/schema.ts");
