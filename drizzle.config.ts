import { defineConfig } from "drizzle-kit";

const url = (process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:35232/manfrod").replace(/^ecto:/, "postgres:");

export default defineConfig({
  dialect: "postgresql",
  out: "./db/drizzle",
  schema: "./db/drizzle/schema.ts",
  dbCredentials: { url },
  extensionsFilters: ["postgis"],
  tablesFilter: ["!oban_*", "!schema_migrations", "!ts_schema_migrations"],
  introspect: { casing: "camel" },
});
