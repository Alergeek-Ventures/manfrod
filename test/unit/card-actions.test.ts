import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Dispatcher } from "../../lib/slack/routing.ts";

type Body = Record<string, any>;

const slack = vi.hoisted(() => ({
  message: null as Body | null,
  users: new Map<string, Body>(),
  bots: new Set<string>(),
  language: "pl",
  kicked: false,
  stream: undefined as { closed: boolean; ts: string | null } | undefined,
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
vi.mock("../../lib/agent-settings.ts", async (original) => ({
  ...(await original<object>()),
  channelLanguage: vi.fn(async () => ({ audience: "internal", code: slack.language, name: "Polish" })),
}));
vi.mock("../../lib/slack/stream.ts", async (original) => ({
  ...(await original<object>()),
  getStream: vi.fn(() => slack.stream),
}));

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
  isKicked: vi.fn(async () => slack.kicked),
}));

const { cardToBlocks, parseElement } = await import("../../lib/slack/cards.ts");
const { answeredBlocks, clickTs, handleCardReply, replyLabel } = await import("../../lib/slack/card-actions.ts");
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
        { text: "Szczegóły", reply: true },
        { text: "Zatwierdź", reply: true, style: "primary" },
        { text: "Kalendarz", url: "https://calendar.example.com" },
      ],
    },
    { type: "context", text: "stopka" },
  ]).blocks;

const click = (overrides: Partial<Parameters<typeof handleCardReply>[0]> = {}) => ({
  actionId: "card_reply_1",
  messageTs: nextTs(),
  slackUserId: "U2",
  channelId: "C1",
  threadTs: "1699999999.000100",
  ...overrides,
});

const updates = () => api.post.mock.calls.filter(([endpoint]) => endpoint === "chat.update").map(([, body]) => body);
const ephemerals = () => api.post.mock.calls.filter(([endpoint]) => endpoint === "chat.postEphemeral").map(([, body]) => body);

beforeEach(() => {
  sends.length = 0;
  vi.clearAllMocks();
  slack.users = new Map([["U2", user("U2")]]);
  slack.bots = new Set(["UOTHERBOT"]);
  slack.message = { ts: "", text: "Urlop", blocks: cardBlocks() };
  slack.language = "pl";
  slack.kicked = false;
  slack.stream = undefined;
});

describe("reply buttons in the card catalog", () => {
  it("builds reply buttons without a hidden value next to link buttons", () => {
    const [, actions] = cardBlocks();
    expect(actions).toEqual({
      type: "actions",
      elements: [
        { type: "button", action_id: "card_reply_0", text: { type: "plain_text", text: "Szczegóły" } },
        { type: "button", action_id: "card_reply_1", style: "primary", text: { type: "plain_text", text: "Zatwierdź" } },
        { type: "button", action_id: "card_link_2", text: { type: "plain_text", text: "Kalendarz" }, url: "https://calendar.example.com/" },
      ],
    });
  });

  it.each([
    ["neither url nor reply", { text: "x" }],
    ["both url and reply", { text: "x", url: "https://a.io", reply: true }],
    ["a separate reply text", { text: "Dzięki", reply: "run self-modify" }],
    ["reply set to false", { text: "x", reply: false }],
    ["an unknown style", { text: "x", reply: true, style: "secondary" }],
  ])("rejects a button with %s", (_, button) => {
    expect(parseElement(JSON.stringify({ type: "buttons", buttons: [button] }))).toBeNull();
  });

  it("accepts a reply button", () => {
    expect(parseElement(JSON.stringify({ type: "buttons", buttons: [{ text: "x", reply: true }] }))).not.toBeNull();
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
    const blocks = cardToBlocks([{ type: "buttons", buttons: [{ text: "Tak", reply: true }] }]).blocks;
    expect(answeredBlocks(blocks, "note")).toEqual([
      { type: "context", block_id: "card_reply_answered", elements: [{ type: "mrkdwn", text: "note" }] },
    ]);
  });

  it("returns null once no reply buttons are left", () => {
    expect(answeredBlocks(answeredBlocks(cardBlocks(), "note")!, "again")).toBeNull();
  });
});

describe("replyLabel", () => {
  it("reads the visible label of the clicked reply button", () => {
    expect(replyLabel(cardBlocks(), "card_reply_1")).toBe("Zatwierdź");
    expect(replyLabel(cardBlocks(), "card_reply_0")).toBe("Szczegóły");
  });

  it("finds nothing for a link button or an unknown id", () => {
    expect(replyLabel(cardBlocks(), "card_link_2")).toBeNull();
    expect(replyLabel(cardBlocks(), "card_reply_7")).toBeNull();
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
  it("sends the visible label, marked as a button click, as a mention from the person who clicked", async () => {
    const event = click();
    await handleCardReply(event, dispatcher);

    expect(sends).toHaveLength(1);
    const [{ content, options }] = sends;
    expect(content).toContain("from: Ala <U2>");
    expect(content).toMatch(/\n\[clicked card button\] Zatwierdź$/);
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
      expect.objectContaining({ user: "U2", text: "<@UBOT> [clicked card button] Zatwierdź" }),
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
    slack.message = {
      ts: "",
      text: "x",
      blocks: cardToBlocks([{ type: "buttons", buttons: [{ text: "<!channel> & co", reply: true }] }]).blocks,
    };
    await handleCardReply(click({ actionId: "card_reply_0" }), dispatcher);
    expect(JSON.stringify(updates()[0].blocks)).toContain("&lt;!channel&gt; &amp; co");
  });

  it("handles a double click once and tells the second clicker", async () => {
    const event = click();
    await handleCardReply(event, dispatcher);
    await handleCardReply({ ...event, actionId: "card_reply_0" }, dispatcher);
    expect(sends).toHaveLength(1);
    expect(updates()).toHaveLength(1);
    expect(ephemerals()).toEqual([expect.objectContaining({ user: "U2", text: "Ktoś już odpowiedział na tę kartę." })]);
  });

  it("handles simultaneous clicks once", async () => {
    const event = click();
    await Promise.all([handleCardReply(event, dispatcher), handleCardReply(event, dispatcher)]);
    expect(sends).toHaveLength(1);
  });

  it("tells the clicker a card was already answered, for example before a restart", async () => {
    slack.message = { ts: "", text: "Urlop", blocks: answeredBlocks(cardBlocks(), "note") };
    await handleCardReply(click(), dispatcher);
    expect(sends).toHaveLength(0);
    expect(updates()).toHaveLength(0);
    expect(ephemerals()).toEqual([expect.objectContaining({ text: "Ktoś już odpowiedział na tę kartę." })]);
  });

  it("does not answer and asks the clicker to type the reply when the card cannot be read", async () => {
    slack.message = null;
    const event = click();
    await handleCardReply(event, dispatcher);
    expect(sends).toHaveLength(0);
    expect(updates()).toHaveLength(0);
    expect(ephemerals()).toEqual([
      expect.objectContaining({
        channel: "C1",
        thread_ts: "1699999999.000100",
        user: "U2",
        text: expect.stringContaining("napisz odpowiedź"),
      }),
    ]);

    slack.message = { ts: "", text: "Urlop", blocks: cardBlocks() };
    await handleCardReply(event, dispatcher);
    expect(sends).toHaveLength(1);
  });

  it("tells the clicker to type the reply when the clicked button is not on the card", async () => {
    await handleCardReply(click({ actionId: "card_reply_9" }), dispatcher);
    expect(sends).toHaveLength(0);
    expect(ephemerals()).toEqual([expect.objectContaining({ text: expect.stringContaining("napisz odpowiedź") })]);
  });

  it("asks to wait while the card's message is still streaming and leaves the card untouched", async () => {
    const event = click();
    slack.stream = { closed: false, ts: event.messageTs };
    await handleCardReply(event, dispatcher);
    expect(sends).toHaveLength(0);
    expect(updates()).toHaveLength(0);
    expect(ephemerals()).toEqual([expect.objectContaining({ text: expect.stringContaining("Poczekaj") })]);

    slack.stream = { closed: true, ts: event.messageTs };
    await handleCardReply(event, dispatcher);
    expect(sends).toHaveLength(1);
  });

  it("handles a click while another message in the thread is streaming", async () => {
    slack.stream = { closed: false, ts: "1800000000.000100" };
    await handleCardReply(click(), dispatcher);
    expect(sends).toHaveLength(1);
  });

  it("ignores a click in a thread Manfrod was kicked from and hints at mentioning it", async () => {
    slack.kicked = true;
    await handleCardReply(click(), dispatcher);
    expect(sends).toHaveLength(0);
    expect(updates()).toHaveLength(0);
    expect(ephemerals()).toEqual([expect.objectContaining({ user: "U2", text: expect.stringContaining("@Manfrod") })]);
  });

  it("writes notices in the channel's language", async () => {
    slack.language = "en";
    slack.message = null;
    await handleCardReply(click(), dispatcher);
    expect(ephemerals()[0].text).toBe("I couldn't read this card — please type your reply in the thread.");
  });

  it("keeps the card and lets the next click through when the dispatch fails", async () => {
    const event = click();
    vi.mocked(dispatcher.send).mockRejectedValueOnce(new Error("eve down"));
    await expect(handleCardReply(event, dispatcher)).rejects.toThrow("eve down");
    expect(updates()).toHaveLength(0);

    await handleCardReply(event, dispatcher);
    expect(sends).toHaveLength(1);
    expect(updates()).toHaveLength(1);
  });

  it("tells a second clicker the card was answered when updating it failed", async () => {
    api.post.mockImplementation(async (endpoint: string) =>
      endpoint === "chat.update" ? ({ ok: false, error: "message_not_found" } as any) : { ok: true as const, body: {} },
    );
    slack.users.set("U3", user("U3"));
    const event = click();
    await handleCardReply(event, dispatcher);
    await handleCardReply({ ...event, slackUserId: "U3" }, dispatcher);
    expect(sends).toHaveLength(1);
    expect(ephemerals()).toEqual([expect.objectContaining({ user: "U3", text: "Ktoś już odpowiedział na tę kartę." })]);
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
    expect(sends[0].content).toBe("[clicked card button] Zatwierdź");
    expect(sends[0].options.auth.attributes).toMatchObject({ slackUserId: "U2", channelId: "D1", threadTs: "1699999999.000100" });
    expect(api.botIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ["a link action", { actionId: "card_link_0" }],
    ["a missing message", { messageTs: undefined }],
  ])("ignores %s", async (_, overrides) => {
    await handleCardReply(click(overrides), dispatcher);
    expect(sends).toHaveLength(0);
    expect(api.post).not.toHaveBeenCalled();
  });
});
