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

const { cardToBlocks, CARD_LIMITS, parseElement, CARD_REPLY_ACTION_PREFIX } = await import("../../lib/slack/cards.ts");
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

const buttonsOf = (buttons: unknown[]) => JSON.stringify({ type: "buttons", buttons });

beforeEach(() => {
  sends.length = 0;
  vi.clearAllMocks();
  api.getThreadMessage.mockImplementation(async () => slack.message);
  api.post.mockImplementation(async () => ({ ok: true as const, body: {} as Body }));
  vi.mocked(dispatcher.send).mockImplementation(async (content, options) => {
    sends.push({ content, options: options as Body });
  });
  slack.users = new Map([["U2", user("U2")]]);
  slack.bots = new Set(["UOTHERBOT"]);
  slack.message = { ts: "", text: "Urlop", blocks: cardBlocks() };
});

describe("adversarial: card schema", () => {
  it("rejects more than five buttons even when they are mixed", () => {
    const six = Array.from({ length: 6 }, (_, i) => (i % 2 ? { text: `l${i}`, url: "https://a.io" } : { text: `r${i}`, reply: `r${i}` }));
    expect(parseElement(buttonsOf(six))).toBeNull();
    expect(parseElement(buttonsOf(six.slice(0, 5)))).not.toBeNull();
  });

  it.each([
    ["an empty reply", ""],
    ["a tab and newline reply", "\t\n "],
  ])("rejects %s", (_, reply) => {
    expect(parseElement(buttonsOf([{ text: "x", reply }]))).toBeNull();
  });

  it("rejects a button with url and reply, with url null, and with an empty url", () => {
    expect(parseElement(buttonsOf([{ text: "x", url: "https://a.io", reply: "y" }]))).toBeNull();
    expect(parseElement(buttonsOf([{ text: "x", url: null }]))).toBeNull();
    expect(parseElement(buttonsOf([{ text: "x", url: "" }]))).toBeNull();
    expect(parseElement(buttonsOf([{ text: "x", url: "", reply: "y" }]))).toBeNull();
  });

  it("trims the reply stored as the button value", () => {
    const element = parseElement(buttonsOf([{ text: "x", reply: "  tak  " }]))! as any;
    const [block] = cardToBlocks([element]).blocks as Body[];
    expect(block.elements[0].value).toBe("tak");
  });

  it("indexes action ids per button so reply and link ids never collide in one block", () => {
    const element = parseElement(
      buttonsOf([
        { text: "a", reply: "a" },
        { text: "b", url: "https://a.io" },
        { text: "c", reply: "c" },
      ]),
    )!;
    const ids = (cardToBlocks([element]).blocks as Body[])[0].elements.map((e: Body) => e.action_id);
    expect(ids).toEqual(["card_reply_0", "card_link_1", "card_reply_2"]);
    expect(new Set(ids).size).toBe(3);
  });

  it("does not put url or value on the wrong kind of button", () => {
    const element = parseElement(
      buttonsOf([
        { text: "a", reply: "a" },
        { text: "b", url: "https://a.io" },
      ]),
    )!;
    const [reply, link] = (cardToBlocks([element]).blocks as Body[])[0].elements;
    expect(reply.url).toBeUndefined();
    expect(link.value).toBeUndefined();
  });

  it("truncates an overlong label to 75 characters", () => {
    const element = parseElement(buttonsOf([{ text: "ż".repeat(200), reply: "a" }]))! as any;
    expect((cardToBlocks([element]).blocks as Body[])[0].elements[0].text.text.length).toBeLessThanOrEqual(CARD_LIMITS.buttonText);
  });

  it("keeps a broadcast mention in a reply value as-is because it is never rendered", () => {
    const element = parseElement(buttonsOf([{ text: "a", reply: "<!channel> hi <@U1>" }]))! as any;
    expect((cardToBlocks([element]).blocks as Body[])[0].elements[0].value).toBe("<!channel> hi <@U1>");
  });

  it("exports the reply prefix used by the click router", () => {
    expect(CARD_REPLY_ACTION_PREFIX).toBe("card_reply_");
  });
});

describe("adversarial: answeredBlocks", () => {
  it("leaves non-button elements in an actions block untouched", () => {
    const blocks = [
      {
        type: "actions",
        elements: [
          { type: "button", action_id: "card_reply_0" },
          { type: "static_select", action_id: "card_reply_select" },
          { type: "button", action_id: "other" },
        ],
      },
    ];
    const result = answeredBlocks(blocks, "n")!;
    expect(result[0].elements.map((e: Body) => e.action_id)).toEqual(["card_reply_select", "other"]);
  });

  it("puts a single note for several button blocks and removes reply buttons from all", () => {
    const blocks = [
      ...cardToBlocks([{ type: "buttons", buttons: [{ text: "a", reply: "a" }] }]).blocks,
      ...cardToBlocks([{ type: "buttons", buttons: [{ text: "b", reply: "b" }] }]).blocks,
    ];
    const result = answeredBlocks(blocks, "n")!;
    expect(result).toHaveLength(1);
    expect(answeredBlocks(result, "m")).toBeNull();
  });

  it("returns null for blocks without actions and for malformed blocks", () => {
    expect(answeredBlocks([], "n")).toBeNull();
    expect(answeredBlocks([{ type: "actions" }, { type: "actions", elements: "x" }], "n")).toBeNull();
    expect(answeredBlocks([{ type: "actions", elements: [null, undefined] as any }], "n")).toBeNull();
  });

  it("does not mutate its input", () => {
    const blocks = cardBlocks();
    const copy = JSON.stringify(blocks);
    answeredBlocks(blocks, "n");
    expect(JSON.stringify(blocks)).toBe(copy);
  });
});

describe("adversarial: clickTs", () => {
  it("is unique for 999 clicks in one millisecond", () => {
    const now = 1_700_000_000_007;
    const seen = new Set(Array.from({ length: 999 }, () => clickTs(now)));
    expect(seen.size).toBe(999);
  });

  it("is unique and well-shaped for 900 rapid real-clock clicks", () => {
    const seen = new Set(Array.from({ length: 900 }, () => clickTs()));
    expect(seen.size).toBe(900);
    for (const ts of seen) expect(ts).toMatch(/^\d{10}\.\d{6}$/);
  });
});

describe("adversarial: forged and odd clicks", () => {
  it("accepts any card_reply_ id, taking the reply from the payload value", async () => {
    await handleCardReply(click({ actionId: "card_reply_x", value: "totally different" }), dispatcher);
    expect(sends).toHaveLength(1);
    expect(sends[0].content).toMatch(/\ntotally different$/);
  });

  it("ignores ids that merely contain the prefix", async () => {
    await handleCardReply(click({ actionId: "xcard_reply_1" }), dispatcher);
    await handleCardReply(click({ actionId: "card_reply" }), dispatcher);
    await handleCardReply(click({ actionId: "" }), dispatcher);
    expect(sends).toHaveLength(0);
  });

  it("ignores a click on a message that has no reply buttons", async () => {
    slack.message = { ts: "", text: "plain", blocks: [{ type: "section", text: { type: "mrkdwn", text: "hi" } }] };
    await handleCardReply(click(), dispatcher);
    expect(sends).toHaveLength(0);
    expect(updates()).toHaveLength(0);
  });

  it("ignores a click on a message without blocks", async () => {
    slack.message = { ts: "", text: "plain" };
    await handleCardReply(click(), dispatcher);
    expect(sends).toHaveLength(0);
  });

  it("ignores a click with an empty user id", async () => {
    await handleCardReply(click({ slackUserId: "" }), dispatcher);
    expect(sends).toHaveLength(0);
  });

  it("ignores USLACKBOT", async () => {
    slack.bots.add("USLACKBOT");
    await handleCardReply(click({ slackUserId: "USLACKBOT" }), dispatcher);
    expect(sends).toHaveLength(0);
  });

  it("ignores the bot's own user id when it is flagged as a bot", async () => {
    slack.bots.add("UBOT");
    await handleCardReply(click({ slackUserId: "UBOT" }), dispatcher);
    expect(sends).toHaveLength(0);
  });

  it("trims whitespace around the value and still accepts exactly 200 characters after trimming", async () => {
    await handleCardReply(click({ value: `  ${"a".repeat(200)}  ` }), dispatcher);
    expect(sends).toHaveLength(1);
  });

  it("does not let an overlong click consume the card", async () => {
    const event = click({ value: "r".repeat(201) });
    await handleCardReply(event, dispatcher);
    await handleCardReply({ ...event, value: "ok" }, dispatcher);
    expect(sends).toHaveLength(1);
  });

  it("passes a broadcast mention in the value to the model as plain text, not to Slack", async () => {
    await handleCardReply(click({ value: "<!channel> ping" }), dispatcher);
    expect(sends).toHaveLength(1);
    const posted = api.post.mock.calls.filter(([endpoint]) => endpoint === "chat.postMessage");
    expect(posted).toHaveLength(0);
  });

  it("escapes a user mention in the label of the note", async () => {
    await handleCardReply(click({ label: "<@U999|x> <https://evil|click>" }), dispatcher);
    const text = JSON.stringify(updates()[0].blocks);
    expect(text).not.toContain("<@U999");
    expect(text).not.toContain("<https://evil");
  });

  it("falls back to the reply when the label is missing and escapes it", async () => {
    await handleCardReply(click({ label: undefined, value: "<!here> x" }), dispatcher);
    const text = JSON.stringify(updates()[0].blocks);
    expect(text).toContain("&lt;!here&gt; x");
  });

  it("falls back to the card text when the card message has no text", async () => {
    slack.message = { ts: "", blocks: cardBlocks() };
    await handleCardReply(click(), dispatcher);
    expect(updates()[0].text).toBe("Zatwierdź urlop");
  });
});

describe("adversarial: double and concurrent clicks", () => {
  it("handles ten simultaneous clicks by different people once", async () => {
    slack.users = new Map(Array.from({ length: 10 }, (_, i) => [`U${i}`, user(`U${i}`)]));
    const messageTs = nextTs();
    await Promise.all(Array.from({ length: 10 }, (_, i) => handleCardReply(click({ messageTs, slackUserId: `U${i}` }), dispatcher)));
    expect(sends).toHaveLength(1);
    expect(updates()).toHaveLength(1);
  });

  it("handles clicks on different cards independently", async () => {
    await Promise.all([handleCardReply(click(), dispatcher), handleCardReply(click(), dispatcher)]);
    expect(sends).toHaveLength(2);
    const stamps = sends.map((s) => s.options.auth.attributes.messageTs);
    expect(new Set(stamps).size).toBe(2);
  });

  it("treats the same message ts in different channels as different cards", async () => {
    const messageTs = nextTs();
    await handleCardReply(click({ messageTs, channelId: "C1" }), dispatcher);
    await handleCardReply(click({ messageTs, channelId: "C2" }), dispatcher);
    expect(sends).toHaveLength(2);
  });

  it("gives every rapid click a distinct synthetic ts", async () => {
    await Promise.all(Array.from({ length: 50 }, () => handleCardReply(click(), dispatcher)));
    expect(sends).toHaveLength(50);
    expect(new Set(sends.map((s) => s.options.auth.attributes.messageTs)).size).toBe(50);
  });

  it("ignores a click when the card was answered by another instance first (buttons already gone)", async () => {
    slack.message = { ts: "", text: "x", blocks: answeredBlocks(cardBlocks(), "n") };
    const event = click();
    await handleCardReply(event, dispatcher);
    expect(sends).toHaveLength(0);
  });
});

describe("adversarial: Slack failures", () => {
  it("still handles the click when chat.update reports an error", async () => {
    api.post.mockImplementation(async (endpoint: string) =>
      endpoint === "chat.update" ? ({ ok: false, error: "message_not_found" } as any) : { ok: true as const, body: {} },
    );
    await handleCardReply(click(), dispatcher);
    expect(sends).toHaveLength(1);
  });

  it("still handles the click when getThreadMessage returns null", async () => {
    slack.message = null;
    await handleCardReply(click(), dispatcher);
    expect(sends).toHaveLength(1);
  });
});

describe("adversarial: DM versus channel", () => {
  it("does not check the account or rewrite text for a DM and keeps the plain reply", async () => {
    slack.users = new Map();
    await handleCardReply(click({ channelId: "D9", slackUserId: "U2" }), dispatcher);
    expect(api.botIdentity).not.toHaveBeenCalled();
  });

  it("marks the card in a DM too", async () => {
    await handleCardReply(click({ channelId: "D9" }), dispatcher);
    expect(updates()).toHaveLength(1);
  });

  it("falls back to a mention event when the bot identity is unknown in a channel", async () => {
    api.botIdentity.mockResolvedValueOnce(null as any);
    await handleCardReply(click(), dispatcher);
    expect(sends).toHaveLength(1);
    expect(sends[0].content).not.toContain("<@UBOT>");
  });

  it("treats a group (G) and mpim channel as a channel, requiring an account", async () => {
    slack.users = new Map();
    await handleCardReply(click({ channelId: "G1", slackUserId: "U9" }), dispatcher);
    expect(sends).toHaveLength(0);
    expect(updates()).toHaveLength(0);
  });

  it("does not use up the card for an unknown person who clicks first", async () => {
    const messageTs = nextTs();
    await handleCardReply(click({ messageTs, slackUserId: "U9" }), dispatcher);
    await handleCardReply(click({ messageTs, slackUserId: "U2" }), dispatcher);
    expect(sends).toHaveLength(1);
    expect(sends[0].options.auth.attributes.slackUserId).toBe("U2");
  });
});
