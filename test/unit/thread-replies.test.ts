import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Dispatcher } from "../../lib/slack/routing.ts";

type Body = Record<string, any>;

const slack = vi.hoisted(() => ({ thread: [] as Body[], kicked: false }));

const api = vi.hoisted(() => ({
  post: vi.fn(async (_endpoint: string, _body: Body) => ({ ok: true as const, body: {} as Body })),
  botIdentity: vi.fn(async () => ({ botId: "B0", userId: "UBOT", teamId: "T1", url: "https://x.slack.com/" })),
  fetchUserName: vi.fn(async (id: string) => (id === "U2" ? "Mirek" : null)),
  fetchUserInfo: vi.fn(async () => ({ name: "Mirek", email: null })),
  getChannelInfo: vi.fn(async (channel: string) => ({ id: channel, name: "onside", is_im: false, is_mpim: false })),
  listFullThread: vi.fn(async () => slack.thread),
  listMessages: vi.fn(async () => [] as Body[]),
  setStatus: vi.fn(async () => ({ ok: true })),
  addReaction: vi.fn(async () => ({ ok: true })),
}));

const kickQuery = {
  from: () => kickQuery,
  where: () => kickQuery,
  limit: async () => (slack.kicked ? [{ id: "k" }] : []),
};

vi.mock("../../lib/db/index.ts", async (original) => ({
  ...(await original<object>()),
  db: { select: () => kickQuery, delete: () => ({ where: async () => {} }) },
}));
vi.mock("../../lib/slack/api.ts", async (original) => ({ ...(await original<object>()), ...api }));
vi.mock("../../lib/accounts.ts", async (original) => ({
  ...(await original<object>()),
  getUserBySlackId: vi.fn(async (id: string) => ({ id: `user-${id}`, slackId: id, name: "Mirek", role: "" })),
  findOrCreateBySlackId: vi.fn(async (id: string) => ({ id: `user-${id}`, slackId: id, name: "Mirek", role: "" })),
}));
vi.mock("../../lib/memory/access.ts", async (original) => ({
  ...(await original<object>()),
  resolveAccess: vi.fn(async () => ({ readableLevels: ["internal"], writeAccess: ["internal"] })),
}));
vi.mock("../../lib/memory/messages.ts", async (original) => ({
  ...(await original<object>()),
  createMessage: vi.fn(async () => ({})),
  getRecentSessionMessages: vi.fn(async () => []),
  lastSessionMessageAt: vi.fn(async () => null),
}));
vi.mock("../../lib/memory/buffer.ts", async (original) => ({ ...(await original<object>()), push: vi.fn(async () => {}) }));
vi.mock("../../lib/memory/channel-detector.ts", async (original) => ({
  ...(await original<object>()),
  ensureMapping: vi.fn(async () => []),
}));
vi.mock("../../lib/agent/response-gate.ts", async (original) => ({
  ...(await original<object>()),
  decide: vi.fn(async () => ({ kind: "ignore" })),
}));
vi.mock("../../lib/events/index.ts", async (original) => ({ ...(await original<object>()), broadcast: vi.fn(async () => {}) }));
vi.mock("../../lib/inngest/client.ts", async (original) => ({ ...(await original<object>()), sendEvent: vi.fn(async () => {}) }));

const { isAllowed } = await import("../../lib/slack/thread-permission.ts");
const { handleMessage, inboundFromRaw } = await import("../../lib/slack/routing.ts");
const { broadcast } = await import("../../lib/events/index.ts");

const bot = { userId: "UBOT", botId: "B0" };
const dispatcher: Dispatcher = {
  send: vi.fn(async () => {}),
  isSubscribed: vi.fn(async () => true),
  reset: vi.fn(async () => {}),
};

let counter = 0;
const nextTs = () => `1810000${String(++counter).padStart(3, "0")}.000100`;

const received = () =>
  vi
    .mocked(broadcast)
    .mock.calls.filter(([type]) => type === "message_received")
    .map(([, payload]) => (payload as Body).meta.content as string);

beforeEach(() => {
  vi.clearAllMocks();
  slack.kicked = false;
});

describe("which threads Manfrod listens to without a mention", () => {
  it("listens in a thread that starts with its own post", async () => {
    const root = nextTs();
    slack.thread = [
      { ts: root, user: "UBOT", bot_id: "B0", text: "hej, w Linearze leży w Merged dłużej niż 2 dni" },
      { ts: nextTs(), user: "U2", text: "przestaw to na Done" },
    ];
    expect(await isAllowed(bot, "C1", root)).toBe(true);
  });

  it("listens in a thread that starts with a post its bot user sent without a user field", async () => {
    const root = nextTs();
    slack.thread = [{ ts: root, bot_id: "B0", text: "przypomnienie" }];
    expect(await isAllowed(bot, "C1", root)).toBe(true);
  });

  it("stays out of a thread people started among themselves", async () => {
    const root = nextTs();
    slack.thread = [
      { ts: root, user: "U3", text: "kto dziś w biurze?" },
      { ts: nextTs(), user: "UBOT", bot_id: "B0", text: "odpowiedź Manfroda w środku wątku" },
      { ts: nextTs(), user: "U2", text: "ja" },
    ];
    expect(await isAllowed(bot, "C1", root)).toBe(false);
  });

  it("ignores another bot's thread", async () => {
    const root = nextTs();
    slack.thread = [{ ts: root, bot_id: "BOTHER", user: "UOTHER", text: "deploy done" }];
    expect(await isAllowed(bot, "C1", root)).toBe(false);
  });

  it("still listens in a thread where it was mentioned", async () => {
    const root = nextTs();
    slack.thread = [
      { ts: root, user: "U3", text: "pytanie" },
      { ts: nextTs(), user: "U3", text: "<@UBOT> pomożesz?" },
    ];
    expect(await isAllowed(bot, "C1", root)).toBe(true);
  });

  it("stays out of its own thread once kicked", async () => {
    const root = nextTs();
    slack.kicked = true;
    slack.thread = [{ ts: root, user: "UBOT", bot_id: "B0", text: "przypomnienie" }];
    expect(await isAllowed(bot, "C1", root)).toBe(false);
  });
});

describe("a reply under Manfrod's own post", () => {
  it("is forwarded with the post it replies to", async () => {
    const root = nextTs();
    const ts = nextTs();
    slack.thread = [
      { ts: root, user: "UBOT", bot_id: "B0", text: "hej, w Linearze leży w Merged dłużej niż 2 dni: ONS-182" },
      { ts, user: "U2", text: "przestaw to na Done" },
    ];
    await handleMessage(
      inboundFromRaw({ type: "message", channel: "C1", user: "U2", text: "przestaw to na Done", ts, thread_ts: root }, "C1"),
      dispatcher,
    );
    const [content] = received();
    expect(content).toContain("first reply you see in this thread");
    expect(content).toContain("Manfrod: hej, w Linearze leży w Merged dłużej niż 2 dni: ONS-182");
    expect(content).toContain("[from: Mirek <U2>]\nprzestaw to na Done");
  });

  it("does not repeat the history on the next reply", async () => {
    const root = nextTs();
    const first = nextTs();
    const second = nextTs();
    slack.thread = [
      { ts: root, user: "UBOT", bot_id: "B0", text: "przypomnienie o ONS-182" },
      { ts: first, user: "U2", text: "zrobione" },
      { ts: second, user: "U2", text: "a ONS-183?" },
    ];
    await handleMessage(
      inboundFromRaw({ type: "message", channel: "C1", user: "U2", text: "zrobione", ts: first, thread_ts: root }, "C1"),
      dispatcher,
    );
    await handleMessage(
      inboundFromRaw({ type: "message", channel: "C1", user: "U2", text: "a ONS-183?", ts: second, thread_ts: root }, "C1"),
      dispatcher,
    );
    const [, next] = received();
    expect(next).toBe("[from: Mirek <U2>]\na ONS-183?");
  });

  it("is not forwarded from a thread people started among themselves", async () => {
    const root = nextTs();
    const ts = nextTs();
    slack.thread = [
      { ts: root, user: "U3", text: "kto dziś w biurze?" },
      { ts, user: "U2", text: "ja" },
    ];
    await handleMessage(inboundFromRaw({ type: "message", channel: "C1", user: "U2", text: "ja", ts, thread_ts: root }, "C1"), dispatcher);
    expect(received()).toEqual([]);
  });
});
