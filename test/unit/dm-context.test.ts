import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Dispatcher } from "../../lib/slack/routing.ts";

type Body = Record<string, any>;

const api = vi.hoisted(() => ({
  post: vi.fn(async (_endpoint: string, _body: Body) => ({ ok: true as const, body: {} as Body })),
  botIdentity: vi.fn(async () => ({ botId: "B0", userId: "UBOT", teamId: "T1", url: "https://x.slack.com/" })),
  fetchUserName: vi.fn(async () => "Ala"),
  fetchUserInfo: vi.fn(async () => ({ name: "Ala", email: null })),
  getChannelInfo: vi.fn(async (channel: string) => ({ id: channel, name: "doublepass", is_im: channel.startsWith("D"), is_mpim: false })),
  listFullThread: vi.fn(async () => [] as Body[]),
  listMessages: vi.fn(async () => [] as Body[]),
  setStatus: vi.fn(async () => ({ ok: true })),
  addReaction: vi.fn(async () => ({ ok: true })),
}));

const accounts = vi.hoisted(() => ({
  getUser: vi.fn(async (_id: string) => ({ id: "user-U2", name: "Ala" }) as Body | null),
}));

vi.mock("../../lib/slack/api.ts", async (original) => ({ ...(await original<object>()), ...api }));
vi.mock("../../lib/accounts.ts", async (original) => ({
  ...(await original<object>()),
  getUser: accounts.getUser,
  getUserBySlackId: vi.fn(async (id: string) => ({ id: `user-${id}`, slackId: id, name: "Ala", role: "" })),
  findOrCreateBySlackId: vi.fn(async (id: string) => ({ id: `user-${id}`, slackId: id, name: "Ala", role: "" })),
}));
vi.mock("../../lib/memory/access.ts", async (original) => ({
  ...(await original<object>()),
  resolveAccess: vi.fn(async (userId: string, channel: string | null) =>
    channel?.startsWith("D")
      ? { readableLevels: [`private/${userId}`, "internal", "external/all"], writeAccess: [`private/${userId}`] }
      : { readableLevels: ["internal", "external/all"], writeAccess: ["internal"] },
  ),
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
vi.mock("../../lib/events/index.ts", async (original) => ({ ...(await original<object>()), broadcast: vi.fn(async () => {}) }));
vi.mock("../../lib/inngest/client.ts", async (original) => ({ ...(await original<object>()), sendEvent: vi.fn(async () => {}) }));

const { handleMessage, inboundFromRaw } = await import("../../lib/slack/routing.ts");
const { resolveAccess } = await import("../../lib/memory/access.ts");
const { currentContext } = await import("../../lib/agent/system-prompt.ts");
const { userContext } = await import("../../lib/slack/state.ts");

const sends: Body[] = [];
const dispatcher: Dispatcher = {
  send: vi.fn(async (_content, options) => {
    sends.push(options as Body);
  }),
  isSubscribed: vi.fn(async () => true),
  reset: vi.fn(async () => {}),
};

let counter = 0;
const nextTs = () => `1800000${String(++counter).padStart(3, "0")}.000100`;

beforeEach(() => {
  sends.length = 0;
  vi.clearAllMocks();
  userContext.put("U2", {});
});

describe("DM access", () => {
  it("resolves a DM with the DM channel so the person's private notes are readable", async () => {
    const ts = nextTs();
    await handleMessage(
      inboundFromRaw({ type: "message", channel: "D1", user: "U2", text: "moje prywatne notatki?", ts }, "D1"),
      dispatcher,
    );
    expect(resolveAccess).toHaveBeenCalledWith("user-U2", "D1");
    expect(sends.at(-1)?.auth.attributes.readableLevels).toContain("private/user-U2");
    expect(sends.at(-1)?.auth.attributes.writeAccess).toEqual(["private/user-U2"]);
  });

  it("treats a thread inside a DM as private too", async () => {
    const threadTs = nextTs();
    const ts = nextTs();
    await handleMessage(
      inboundFromRaw({ type: "message", channel: "D1", user: "U2", text: "a teraz?", ts, thread_ts: threadTs }, "D1"),
      dispatcher,
    );
    expect(resolveAccess).toHaveBeenCalledWith("user-U2", "D1");
    expect(sends.at(-1)?.auth.attributes.threadTs).toBe(threadTs);
    expect(sends.at(-1)?.auth.attributes.readableLevels).toContain("private/user-U2");
  });
});

describe("current context", () => {
  it("says a DM is private and its private notes may be listed", async () => {
    const context = await currentContext("user-U2", "D1:1800000000.000100", "D1");
    expect(context).toContain("private direct message (DM)");
    expect(context).toContain("not a channel");
    expect(context).toContain("private notes are readable here");
    expect(context).toContain("User: Ala");
    expect(context).not.toContain("shared channel");
  });

  it("says a DM is private even before a session exists", async () => {
    expect(await currentContext("user-U2", null, "D1")).toContain("private direct message (DM)");
  });

  it("still calls a channel thread shared", async () => {
    const context = await currentContext("user-U2", "C1:1800000000.000100", "C1");
    expect(context).toContain("shared channel thread");
    expect(context).not.toContain("private direct message");
  });

  it("still calls a channel without a session shared", async () => {
    const context = await currentContext("user-U2", null, "C1");
    expect(context).toContain("shared Slack channel");
    expect(context).not.toContain("private direct message");
  });
});

describe("viewing hint", () => {
  it("says the conversation is not in the channel the person is viewing", async () => {
    userContext.put("U2", { channel_id: "C9" });
    const description = await userContext.describe("U2", async () => "doublepass");
    expect(description).toContain("currently viewing #doublepass");
    expect(description).toContain("this conversation is not in that channel");
  });
});
