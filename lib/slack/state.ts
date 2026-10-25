class TtlMap<K, V> {
  private entries = new Map<K, { value: V; at: number }>();

  constructor(private readonly ttlMs: number | ((value: V) => number)) {}

  private ttlFor(value: V): number {
    return typeof this.ttlMs === "number" ? this.ttlMs : this.ttlMs(value);
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at >= this.ttlFor(entry.value)) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    this.entries.set(key, { value, at: Date.now() });
    if (this.entries.size > 10_000) this.sweep();
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  keys(): K[] {
    this.sweep();
    return [...this.entries.keys()];
  }

  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.at >= this.ttlFor(entry.value)) this.entries.delete(key);
    }
  }
}

const globalState = globalThis as unknown as { manfrodSlackState?: Record<string, unknown> };
globalState.manfrodSlackState ??= {};

export function shared<T>(name: string, create: () => T): T {
  const store = globalState.manfrodSlackState!;
  if (!(name in store)) store[name] = create();
  return store[name] as T;
}

export { TtlMap };

const dedup = shared("eventDedup", () => new TtlMap<string, true>(5 * 60 * 1000));

export function firstDelivery(key: string): boolean {
  if (dedup.has(key)) return false;
  dedup.set(key, true);
  return true;
}

const seenStore = shared("threadSeen", () => new TtlMap<string, Set<string>>(24 * 60 * 60 * 1000));

export const threadSeen = {
  mark(sessionKey: string, tsList: string[]) {
    const current = seenStore.get(sessionKey) ?? new Set<string>();
    for (const ts of tsList) current.add(ts);
    seenStore.set(sessionKey, current);
  },
  seen(sessionKey: string): Set<string> {
    return seenStore.get(sessionKey) ?? new Set<string>();
  },
};

const contexts = shared("userContext", () => new TtlMap<string, Record<string, unknown>>(2 * 60 * 60 * 1000));

export const userContext = {
  put(slackUserId: string, appContext: unknown) {
    if (appContext && typeof appContext === "object" && Object.keys(appContext).length > 0) {
      contexts.set(slackUserId, appContext as Record<string, unknown>);
    } else {
      contexts.delete(slackUserId);
    }
  },
  get(slackUserId: string): Record<string, unknown> | null {
    return contexts.get(slackUserId) ?? null;
  },
  async describe(slackUserId: string, resolveChannelName: (channelId: string) => Promise<string | null>): Promise<string | null> {
    const appContext = contexts.get(slackUserId);
    const channelId = appContext?.channel_id;
    if (typeof channelId !== "string" || channelId.startsWith("D")) return null;
    const name = (await resolveChannelName(channelId)) ?? channelId;
    const thread = appContext?.thread_ts;
    if (thread) {
      return `The user is currently viewing a thread in #${name} (channel ${channelId}, thread_ts ${thread}). If they say "this", "tu" or "tego wątku" without naming anything, they most likely mean it.`;
    }
    return `The user is currently viewing #${name} (channel ${channelId}). If they say "this", "tu" or "tego kanału" without naming anything, they most likely mean it.`;
  },
};
