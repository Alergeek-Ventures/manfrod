import { Client } from "pg";
import { databaseUrl } from "../db/index.ts";
import { logger } from "../log.ts";

type Subscriber = (payload: string) => void;

const log = logger("AuditListener");
const RECONNECT_DELAY_MS = 2_000;

const state = (
  globalThis as unknown as {
    manfrodAuditListener?: { subscribers: Set<Subscriber>; client: Client | null; connecting: Promise<void> | null };
  }
).manfrodAuditListener ?? { subscribers: new Set<Subscriber>(), client: null, connecting: null };
(globalThis as unknown as { manfrodAuditListener: typeof state }).manfrodAuditListener = state;

async function connect(): Promise<void> {
  const client = new Client({ connectionString: databaseUrl() });
  client.on("notification", (message) => {
    if (!message.payload) return;
    for (const subscriber of state.subscribers) subscriber(message.payload);
  });
  client.on("error", (error) => {
    log.warn(`AuditListener: connection error, reconnecting: ${error.message}`);
    reset(client);
  });
  client.on("end", () => reset(client));
  await client.connect();
  await client.query("LISTEN audit_events");
  state.client = client;
}

function reset(client: Client) {
  if (state.client !== client) return;
  state.client = null;
  void client.end().catch(() => {});
  if (state.subscribers.size > 0) setTimeout(() => void ensureConnected(), RECONNECT_DELAY_MS);
}

function ensureConnected(): Promise<void> {
  if (state.client) return Promise.resolve();
  state.connecting ??= connect().finally(() => {
    state.connecting = null;
  });
  return state.connecting;
}

export async function subscribeAuditEvents(subscriber: Subscriber): Promise<() => void> {
  state.subscribers.add(subscriber);
  await ensureConnected();
  return () => {
    state.subscribers.delete(subscriber);
    if (state.subscribers.size === 0 && state.client) {
      const client = state.client;
      state.client = null;
      void client.end().catch(() => {});
    }
  };
}
