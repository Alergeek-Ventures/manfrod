import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Dispatcher } from "../../lib/slack/routing.ts";

type Body = Record<string, any>;

const slack = vi.hoisted(() => ({
  message: null as Body | null,
  users: new Map<string, Body>(),
  bots: new Set<string>(),
}));

const api = vi.hoisted(() => ({
  post: vi.fn(async (_endpoint: string, _body: Body) => ({ ok: true as const, body: {} as Body })),
  getThreadMessage: vi.fn(async (_channel: string, _threadTs: string, _ts: string) => slack.message),
  isBotUser: vi.fn(async (id: string) => slack.bots.has(id)),
  botIdentity: vi.fn(async () => ({ botId: "B0", userId: "UBOT", teamId: "T1", url: "https://x.slack.com/" })),
  fetchUserName: vi.fn(async (id: string) => (id === "U2" ? "Ala" : null)),
  fetchUserInfo: vi.fn(async (id: string) => ({ name: id === "U2" ? "Ala" : null, email: null })),
  getChannelInfo: vi.fn(async (channel: string) => ({ id: channel, name: "projekt", is_im: channel.startsWith("D"), is_mpim: false })),
  listFullThread: vi.fn(async () => [] as Body[]),
  listMessages: vi.fn(async () => [] as Body[]),
  setStatus: vi.fn(async () => ({ ok: true })),
  addReaction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../lib/slack/api.ts", async (original) => ({ ...(await original<object>()), ...api }));

const user = (slackId: string) => ({ id: `user-${slackId}`, slackId, name: slackId === "U2" ? "Ala" : slackId, role: "" });

vi.mock("../../lib/accounts.ts", async (original) => ({
  ...(await original<object>()),
  getUserBySlackId: vi.fn(async (id: string) => (slack.users.has(id) ? slack.users.get(id) : null)),
  findOrCreateBySlackId: vi.fn(async (id: string) => user(id)),
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
vi.mock("../../lib/events/index.ts", async (original) => ({ ...(await original<object>()), broadcast: vi.fn(async () => {}) }));
vi.mock("../../lib/inngest/client.ts", async (original) => ({ ...(await original<object>()), sendEvent: vi.fn(async () => {}) }));
vi.mock("../../lib/slack/thread-permission.ts", async (original) => ({
  ...(await original<object>()),
  allow: vi.fn(async () => {}),
  isAllowed: vi.fn(async () => true),
  isKicked: vi.fn(async () => false),
}));

const { cardToBlocks, CARD_LIMITS, parseElement } = await import("../../lib/slack/cards.ts");
const { answeredBlocks, clickTs, handleCardReply } = await import("../../lib/slack/card-actions.ts");
const { push: bufferPush } = await import("../../lib/memory/buffer.ts");

const sends: { content: unknown; options: Body }[] = [];
const dispatcher: Dispatcher = {
  send: vi.fn(async (content, options) => {
    sends.push({ content, options: options as Body });
  }),
  isSubscribed: vi.fn(async () => true),
  reset: vi.fn(async () => {}),
};

let counter = 0;
const nextTs = () => `1700000${String(++counter).padStart(3, "0")}.000100`;

const cardBlocks = () =>
  cardToBlocks([
    { type: "header", text: "Urlop" },
    {
      type: "buttons",
      buttons: [
        { text: "Szczegóły", reply: "Pokaż szczegóły" },
        { text: "Zatwierdź", reply: "Zatwierdź urlop", style: "primary" },
        { text: "Kalendarz", url: "https://calendar.example.com" },
      ],
    },
    { type: "context", text: "stopka" },
  ]).blocks;

const click = (overrides: Partial<Parameters<typeof handleCardReply>[0]> = {}) => ({
  actionId: "card_reply_1",
  value: "Zatwierdź urlop",
  label: "Zatwierdź",
  messageTs: nextTs(),
  slackUserId: "U2",
  channelId: "C1",
  threadTs: "1699999999.000100",
  ...overrides,
});

const updates = () => api.post.mock.calls.filter(([endpoint]) => endpoint === "chat.update").map(([, body]) => body);

beforeEach(() => {
  sends.length = 0;
  vi.clearAllMocks();
  slack.users = new Map([["U2", user("U2")]]);
  slack.bots = new Set(["UOTHERBOT"]);
  slack.message = { ts: "", text: "Urlop", blocks: cardBlocks() };
});

describe("reply buttons in the card catalog", () => {
  it("builds reply buttons with their reply as the value next to link buttons", () => {
    const [, actions] = cardBlocks();
    expect(actions).toEqual({
      type: "actions",
      elements: [
        { type: "button", action_id: "card_reply_0", text: { type: "plain_text", text: "Szczegóły" }, value: "Pokaż szczegóły" },
        {
          type: "button",
          action_id: "card_reply_1",
          style: "primary",
          text: { type: "plain_text", text: "Zatwierdź" },
          value: "Zatwierdź urlop",
        },
        { type: "button", action_id: "card_link_2", text: { type: "plain_text", text: "Kalendarz" }, url: "https://calendar.example.com/" },
      ],
    });
  });

  it.each([
    ["neither url nor reply", { text: "x" }],
    ["both url and reply", { text: "x", url: "https://a.io", reply: "y" }],
    ["an empty reply", { text: "x", reply: "  " }],
    ["an overlong reply", { text: "x", reply: "r".repeat(CARD_LIMITS.buttonReply + 1) }],
    ["an unknown style", { text: "x", reply: "y", style: "secondary" }],
  ])("rejects a button with %s", (_, button) => {
    expect(parseElement(JSON.stringify({ type: "buttons", buttons: [button] }))).toBeNull();
  });

  it("accepts a reply at the limit", () => {
    expect(
      parseElement(JSON.stringify({ type: "buttons", buttons: [{ text: "x", reply: "r".repeat(CARD_LIMITS.buttonReply) }] })),
    ).not.toBeNull();
  });
});

describe("answeredBlocks", () => {
  it("removes reply buttons, keeps link buttons and notes the choice in place", () => {
    const blocks = answeredBlocks(cardBlocks(), "note")!;
    expect(blocks.map((block) => block.type)).toEqual(["header", "actions", "context", "context"]);
    expect(blocks[1].elements.map((element: Body) => element.action_id)).toEqual(["card_link_2"]);
    expect(blocks[2].elements[0].text).toBe("note");
  });

  it("replaces an actions block that held only reply buttons", () => {
    const blocks = cardToBlocks([{ type: "buttons", buttons: [{ text: "Tak", reply: "tak" }] }]).blocks;
    expect(answeredBlocks(blocks, "note")).toEqual([{ type: "context", elements: [{ type: "mrkdwn", text: "note" }] }]);
  });

  it("returns null once no reply buttons are left", () => {
    expect(answeredBlocks(answeredBlocks(cardBlocks(), "note")!, "again")).toBeNull();
  });
});

describe("clickTs", () => {
  it("looks like a Slack ts and differs for clicks in the same millisecond", () => {
    const now = 1_700_000_000_123;
    const first = clickTs(now);
    expect(first).toMatch(/^1700000000\.123\d{3}$/);
    expect(clickTs(now)).not.toBe(first);
  });
});

describe("handleCardReply", () => {
  it("starts a turn in the card's thread as a mention from the person who clicked", async () => {
    const event = click();
    await handleCardReply(event, dispatcher);

    expect(sends).toHaveLength(1);
    const [{ content, options }] = sends;
    expect(content).toContain("from: Ala <U2>");
    expect(content).toMatch(/\nZatwierdź urlop$/);
    expect(content).not.toContain("<@UBOT>");
    expect(options.auth.principalId).toBe("user-U2");
    expect(options.auth.attributes).toMatchObject({
      slackUserId: "U2",
      channelId: "C1",
      threadTs: "1699999999.000100",
      kind: "slack",
    });
    expect(options.auth.attributes.messageTs).not.toBe(event.messageTs);
    expect(bufferPush).toHaveBeenCalledWith(
      "C1",
      "1699999999.000100",
      "projekt",
      expect.objectContaining({ user: "U2", text: "<@UBOT> Zatwierdź urlop" }),
    );
  });

  it("marks the card with who chose what and drops its reply buttons", async () => {
    const event = click();
    await handleCardReply(event, dispatcher);

    expect(api.getThreadMessage).toHaveBeenCalledWith("C1", "1699999999.000100", event.messageTs);
    const [update] = updates();
    expect(update).toMatchObject({ channel: "C1", ts: event.messageTs, text: "Urlop" });
    const actionIds = update.blocks
      .flatMap((block: Body) => (block.type === "actions" ? block.elements : []))
      .map((e: Body) => e.action_id);
    expect(actionIds).toEqual(["card_link_2"]);
    expect(JSON.stringify(update.blocks)).toContain(":point_right: <@U2>: Zatwierdź");
  });

  it("escapes the label in the note", async () => {
    await handleCardReply(click({ label: "<!channel> & co" }), dispatcher);
    expect(JSON.stringify(updates()[0].blocks)).toContain("&lt;!channel&gt; &amp; co");
  });

  it("handles a double click once", async () => {
    const event = click();
    await handleCardReply(event, dispatcher);
    await handleCardReply({ ...event, actionId: "card_reply_0", value: "Pokaż szczegóły" }, dispatcher);
    expect(sends).toHaveLength(1);
    expect(updates()).toHaveLength(1);
  });

  it("handles simultaneous clicks once", async () => {
    const event = click();
    await Promise.all([handleCardReply(event, dispatcher), handleCardReply(event, dispatcher)]);
    expect(sends).toHaveLength(1);
  });

  it("ignores a click on a card that was already answered, for example before a restart", async () => {
    slack.message = { ts: "", text: "Urlop", blocks: answeredBlocks(cardBlocks(), "note") };
    await handleCardReply(click(), dispatcher);
    expect(sends).toHaveLength(0);
    expect(updates()).toHaveLength(0);
  });

  it("still answers when the card cannot be read", async () => {
    slack.message = null;
    await handleCardReply(click(), dispatcher);
    expect(sends).toHaveLength(1);
    expect(updates()).toHaveLength(0);
  });

  it("ignores bots", async () => {
    await handleCardReply(click({ slackUserId: "UOTHERBOT" }), dispatcher);
    expect(sends).toHaveLength(0);
    expect(api.post).not.toHaveBeenCalled();
  });

  it("tells an unknown person to write a DM first without using up the card", async () => {
    const event = click({ slackUserId: "U9" });
    await handleCardReply(event, dispatcher);
    expect(sends).toHaveLength(0);
    expect(updates()).toHaveLength(0);
    expect(api.post).toHaveBeenCalledWith("chat.postEphemeral", expect.objectContaining({ channel: "C1", user: "U9" }));

    slack.users.set("U9", user("U9"));
    await handleCardReply(event, dispatcher);
    expect(sends).toHaveLength(1);
  });

  it("answers in a DM thread like a typed DM", async () => {
    await handleCardReply(click({ channelId: "D1", slackUserId: "U2" }), dispatcher);
    expect(sends).toHaveLength(1);
    expect(sends[0].content).toBe("Zatwierdź urlop");
    expect(sends[0].options.auth.attributes).toMatchObject({ slackUserId: "U2", channelId: "D1", threadTs: "1699999999.000100" });
    expect(api.botIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ["a link action", { actionId: "card_link_0" }],
    ["an empty reply", { value: "  " }],
    ["a missing reply", { value: undefined }],
    ["an overlong reply", { value: "r".repeat(CARD_LIMITS.buttonReply + 1) }],
    ["a missing message", { messageTs: undefined }],
  ])("ignores %s", async (_, overrides) => {
    await handleCardReply(click(overrides), dispatcher);
    expect(sends).toHaveLength(0);
    expect(api.post).not.toHaveBeenCalled();
  });
});
