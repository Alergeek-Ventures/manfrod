import { beforeEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({
  languageChannels: [] as (string | null)[],
  githubChannels: [] as (string | null)[],
  souls: 0,
  noteContext: [] as unknown[][],
  searches: [] as Record<string, unknown>[],
}));

vi.mock("../../lib/db/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/db/index.ts")>()),
  healthy: async () => true,
}));
vi.mock("../../lib/agent-settings.ts", () => ({
  languageInstructions: async (channel: string | null) => {
    seen.languageChannels.push(channel);
    return channel === "CCLIENT"
      ? "[Language]\nThis is an official channel shared with a client. Write in English."
      : "[Language]\nWrite in Polish.";
  },
}));
vi.mock("../../lib/github/prompt.ts", () => ({
  githubPrompt: async (channel: string | null) => {
    seen.githubChannels.push(channel);
    return "";
  },
}));
vi.mock("../../lib/memory/nodes.ts", () => ({
  getSoulAnchor: async () => {
    seen.souls += 1;
    return null;
  },
  getNodeLinksAccessible: async () => [],
}));
vi.mock("../../lib/secrets.ts", () => ({
  secretsPrompt: async () => "",
  runWithSecrets: (_use: unknown, input: unknown, run: (resolved: unknown) => Promise<unknown>) => run(input),
}));
vi.mock("../../lib/tasks/index.ts", () => ({ tasksPrompt: async () => "" }));
vi.mock("../../lib/accounts.ts", () => ({ getUser: async () => ({ id: "person", name: "Ala" }), isUuid: () => false }));
vi.mock("../../lib/memory/access.ts", () => ({ projectIdForChannel: async () => null, getActiveMapping: async () => null }));
vi.mock("../../lib/memory/search.ts", () => ({
  getNoteContext: async (...args: unknown[]) => {
    seen.noteContext.push(args);
    return "";
  },
  search: async (_user: unknown, _levels: unknown, _query: unknown, options: Record<string, unknown>) => {
    seen.searches.push(options);
    return [];
  },
  recordMemoryContext: () => undefined,
}));
vi.mock("../../agent/lib/notes.ts", () => ({
  PROJECT_DOC: "",
  noteDate: () => "",
  unknownProject: () => "",
  resolveProject: async () => ({ ok: true, id: null }),
}));

const ctxFor = (kind: string, attributes: Record<string, string>) => ({
  toolName: "search-notes",
  session: {
    id: "s1",
    auth: { current: { principalId: "person", attributes: { userId: "person", kind, ...attributes } }, initiator: null },
  },
  turn: { input: "book me a desk" },
});

type Resolver = { events: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> };

beforeEach(() => {
  seen.languageChannels = [];
  seen.githubChannels = [];
  seen.souls = 0;
  seen.noteContext = [];
  seen.searches = [];
});

const promptFor = async (kind: string, attributes: Record<string, string>) => {
  const instructions = (await import("../../agent/instructions/context.ts")).default as unknown as Resolver;
  return JSON.stringify(await instructions.events["turn.started"]({}, ctxFor(kind, attributes)));
};

describe("rehearsal system prompt", () => {
  it("uses the client channel's language, like the original turn", async () => {
    const prompt = await promptFor("rehearsal", { channelId: "CCLIENT" });
    expect(seen.languageChannels).toEqual(["CCLIENT"]);
    expect(seen.githubChannels).toEqual(["CCLIENT"]);
    expect(prompt).toContain("shared with a client");
    expect(prompt).toContain("This is a shared Slack channel, CCLIENT");
    expect(prompt).toContain("this channel belongs to no project, so there are no linear-* tools here");
    expect(seen.souls).toBe(0);
  });

  it("gets the DM context with the person's soul in a direct message", async () => {
    const prompt = await promptFor("rehearsal", { channelId: "D123" });
    expect(seen.languageChannels).toEqual(["D123"]);
    expect(seen.souls).toBe(1);
    expect(prompt).toContain("User: Ala");
  });

  it("keeps ordinary turns without a thread unchanged", async () => {
    await promptFor("slack", { channelId: "CCLIENT" });
    expect(seen.languageChannels).toEqual([null]);
  });
});

describe("memory searches in a rehearsal", () => {
  it("are not audited as the person's searches", async () => {
    const notes = (await import("../../agent/memory/notes.ts")).default as unknown as {
      provider: { recall: Record<string, (ctx: unknown) => Promise<unknown>> };
    };
    await notes.provider.recall["turn.started"](ctxFor("rehearsal", { channelId: "D123" }));
    await notes.provider.recall["turn.started"](ctxFor("slack", { channelId: "D123", threadTs: "1.0" }));
    expect(seen.noteContext.map((args) => [args[4], args[6]])).toEqual([
      [true, false],
      [true, true],
    ]);
    const { default: tool } = await import("../../agent/tools/search-notes.ts");
    const run = (tool as unknown as { execute: (input: unknown, ctx: unknown) => Promise<unknown> }).execute;
    await run({ query: "desk" }, ctxFor("rehearsal", { channelId: "C1" }));
    await run({ query: "desk" }, ctxFor("slack", { channelId: "C1" }));
    expect(seen.searches.map((options) => options.audit)).toEqual([false, true]);
  });
});
