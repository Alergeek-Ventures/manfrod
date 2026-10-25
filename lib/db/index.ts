import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.ts";

pg.defaults.parseInputDatesAsUTC = true;
pg.types.setTypeParser(1114, (value) => new Date(`${value.replace(" ", "T")}Z`));

export type Db = NodePgDatabase<typeof schema>;

const globalCache = globalThis as unknown as { manfrodPool?: pg.Pool; manfrodDb?: Db };

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? "postgres://manfrod:qLmVMeXiYyy65ADb@localhost:35232/manfrod";
  return url.replace(/^ecto:\/\//, "postgres://");
}

export function pool(): pg.Pool {
  if (!globalCache.manfrodPool) {
    globalCache.manfrodPool = new pg.Pool({
      connectionString: databaseUrl(),
      max: Number(process.env.POOL_SIZE ?? 10),
    });
  }
  return globalCache.manfrodPool;
}

export const db: Db = new Proxy({} as Db, {
  get(_target, property) {
    if (!globalCache.manfrodDb) globalCache.manfrodDb = drizzle(pool(), { schema });
    return Reflect.get(globalCache.manfrodDb, property);
  },
});

export async function healthy(): Promise<boolean> {
  try {
    await pool().query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export * as tables from "./schema.ts";
