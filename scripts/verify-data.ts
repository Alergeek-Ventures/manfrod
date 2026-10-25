import { sql } from "drizzle-orm";
import { db, pool } from "../lib/db/index.ts";
import { getConnection, listConnections } from "../lib/linear/index.ts";
import { search } from "../lib/memory/search.ts";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const record = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

const one = async <T = Record<string, any>>(query: ReturnType<typeof sql>): Promise<T> => (await db.execute(query)).rows[0] as T;

for (const table of [
  "users",
  "nodes",
  "links",
  "facts",
  "messages",
  "conversations",
  "projects",
  "channel_mappings",
  "recurring_reminders",
  "audit_events",
]) {
  const row = await one(sql`SELECT count(*)::int n FROM ${sql.identifier(table)}`);
  record(`count ${table}`, true, `${row.n} rows`);
}

const embeddings = await one(sql`
  SELECT count(*)::int total,
    count(*) FILTER (WHERE embedding IS NULL)::int missing,
    count(*) FILTER (WHERE embedding IS NOT NULL AND vector_dims(embedding) <> 1024)::int wrong_dims
  FROM nodes`);
record(
  "node embeddings",
  embeddings.wrong_dims === 0,
  `${embeddings.total} nodes, ${embeddings.missing} without embedding, ${embeddings.wrong_dims} with wrong dims`,
);

const access = await one(sql`SELECT count(*)::int n FROM nodes WHERE access IS NULL OR cardinality(access) = 0`);
record("node access arrays", access.n === 0, `${access.n} nodes without access levels`);

const orphanLinks = await one(sql`
  SELECT count(*)::int n FROM links l
  WHERE NOT EXISTS (SELECT 1 FROM nodes WHERE id = l.node_a_id) OR NOT EXISTS (SELECT 1 FROM nodes WHERE id = l.node_b_id)`);
record("link integrity", orphanLinks.n === 0, `${orphanLinks.n} links pointing at missing nodes`);

const souls = await one(sql`
  SELECT count(*) FILTER (WHERE soul_node_id IS NOT NULL)::int set,
    count(*) FILTER (WHERE soul_node_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM nodes WHERE id = users.soul_node_id))::int dangling
  FROM users`);
record("soul pointers", souls.dangling === 0, `${souls.set} users with a soul, ${souls.dangling} dangling`);

try {
  await db.execute(sql`SELECT id FROM nodes WHERE id @@@ paradedb.match('content'::paradedb.fieldname, 'test') LIMIT 1`);
  record("bm25 index", true, "paradedb.match query runs");
} catch (error) {
  record("bm25 index", false, (error as Error).message);
}

const sample = await one<{ content: string | null }>(
  sql`SELECT content FROM nodes WHERE embedding IS NOT NULL AND 'internal' = ANY(access) ORDER BY inserted_at DESC LIMIT 1`,
);
if (sample?.content && process.env.VOYAGE_API_KEY) {
  try {
    const found = await search(null, ["internal"], sample.content.slice(0, 200), { limit: 5, expandQuery: false, rerank: false });
    record("hybrid search", found.length > 0, `${found.length} results for a known note`);
  } catch (error) {
    record("hybrid search", false, (error as Error).message);
  }
} else {
  record("hybrid search", true, "skipped (no internal notes or VOYAGE_API_KEY)");
}

try {
  const connections = await listConnections();
  let decrypted = 0;
  for (const connection of connections) {
    if (connection.status === "connected" && (await getConnection(connection.projectId))?.apiKey) decrypted += 1;
  }
  record(
    "linear keys decrypt",
    true,
    `${decrypted}/${connections.filter((connection) => connection.status === "connected").length} connected keys decrypted`,
  );
} catch (error) {
  record("linear keys decrypt", false, `${(error as Error).message} — is LINEAR_ENCRYPTION_KEY the same as before?`);
}

const google = await one(sql`
  SELECT (SELECT count(*) FROM google_identities)::int identities,
    (SELECT count(*) FROM google_identities gi WHERE NOT EXISTS (
      SELECT 1 FROM account a WHERE a.provider_id = 'google' AND a.account_id = gi.google_sub AND a.user_id = gi.user_id))::int missing`);
record(
  "google accounts",
  google.missing === 0,
  `${google.identities} Google identities, ${google.missing} not carried over to Better Auth accounts`,
);

const jobs = await one(
  sql`SELECT count(*) FILTER (WHERE state = 'scheduled')::int scheduled, count(*) FILTER (WHERE state = 'scheduled' AND dispatched_at IS NULL)::int undispatched FROM jobs`,
);
record("scheduled jobs", true, `${jobs.scheduled} scheduled, ${jobs.undispatched} not yet handed to Inngest`);

const oban = await one<{ exists: string | null }>(sql`SELECT to_regclass('public.oban_jobs')::text AS exists`);
if (oban.exists) {
  const missing = await one(sql`
    SELECT count(*)::int n FROM oban_jobs o
    WHERE o.state IN ('available', 'scheduled', 'retryable')
      AND o.worker IN ('Manfrod.Workers.TriggerWorker', 'Manfrod.Workers.FirmowidSessionCheckWorker', 'Manfrod.Workers.FirmowidMorningSessionCheckWorker')
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = o.id)`);
  record("oban import", missing.n === 0, `${missing.n} pending Oban jobs not imported`);
}

const width = Math.max(...checks.map((check) => check.name.length));
for (const check of checks) console.log(`${check.ok ? "✓" : "✗"} ${check.name.padEnd(width)}  ${check.detail}`);
await pool().end();
process.exit(checks.every((check) => check.ok) ? 0 : 1);
