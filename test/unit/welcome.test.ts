import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  delayMinutes,
  historyCutoff,
  isOfficeMessage,
  memberVerdict,
  welcomeVerdict,
  type KnownUser,
  type WelcomeFacts,
} from "../../lib/welcome/rules.ts";
import type { WorkspaceMember } from "../../lib/slack/api.ts";

const OFFICE = "COFFICE";
const TEAM = "TTEAM";
const NOW = new Date("2026-11-25T10:00:00Z");
const ODUL = "U0CK4Q772J1";

const fullMember = (overrides: Partial<WorkspaceMember> = {}): WorkspaceMember => ({
  id: ODUL,
  handle: "odul",
  realName: "Odul",
  displayName: null,
  email: "odul@example.com",
  deleted: false,
  bot: false,
  restricted: false,
  ultraRestricted: false,
  stranger: false,
  teamId: TEAM,
  ...overrides,
});

const row = (insertedAt: string, overrides: Partial<KnownUser> = {}): KnownUser => ({
  slackId: ODUL,
  insertedAt: new Date(insertedAt),
  banned: false,
  ...overrides,
});

const facts = (overrides: Partial<WelcomeFacts> = {}): WelcomeFacts => ({
  user: null,
  talked: false,
  member: fullMember(),
  teamId: TEAM,
  postedBefore: false,
  now: NOW,
  ...overrides,
});

describe("welcomeVerdict", () => {
  it("welcomes someone Manfrod has never seen", () => {
    expect(welcomeVerdict(facts())).toEqual({ eligible: true });
  });

  it("welcomes someone whose users row was created by a visit edit a day ago and who never talked to Manfrod", () => {
    const odul = row("2026-11-24T12:00:00Z");
    expect(welcomeVerdict(facts({ user: odul }))).toEqual({ eligible: true });
    expect(welcomeVerdict(facts({ user: odul, now: new Date("2026-12-05T10:00:00Z") }))).toEqual({ eligible: true });
    expect(historyCutoff(odul, NOW).toISOString()).toBe("2026-11-10T12:00:00.000Z");
  });

  it("skips an employee Manfrod has known for months, even if they never talked to it", () => {
    expect(welcomeVerdict(facts({ user: row("2026-06-01T08:00:00Z") }))).toEqual({
      eligible: false,
      final: true,
      reason: "known_too_long",
    });
  });

  it("skips someone who already talked to Manfrod", () => {
    expect(welcomeVerdict(facts({ user: row("2026-11-24T12:00:00Z"), talked: true }))).toMatchObject({ reason: "talked_to_manfrod" });
  });

  it("skips someone who wrote in the office channel long before Manfrod knew them", () => {
    expect(welcomeVerdict(facts({ postedBefore: true }))).toMatchObject({ final: true, reason: "posted_before" });
  });

  it("skips bots, guests, external and deleted accounts", () => {
    expect(memberVerdict(fullMember({ bot: true }), TEAM)).toMatchObject({ reason: "bot" });
    expect(memberVerdict(fullMember({ id: "USLACKBOT", bot: true }), TEAM)).toMatchObject({ reason: "bot" });
    expect(memberVerdict(fullMember({ restricted: true }), TEAM)).toMatchObject({ reason: "guest" });
    expect(memberVerdict(fullMember({ ultraRestricted: true }), TEAM)).toMatchObject({ reason: "guest" });
    expect(memberVerdict(fullMember({ stranger: true }), TEAM)).toMatchObject({ reason: "external" });
    expect(memberVerdict(fullMember({ teamId: "TOTHER" }), TEAM)).toMatchObject({ reason: "external" });
    expect(memberVerdict(fullMember({ deleted: true }), TEAM)).toMatchObject({ reason: "deleted" });
  });

  it("skips system and banned users", () => {
    expect(welcomeVerdict(facts({ user: row(NOW.toISOString(), { slackId: "system:self-review" }) }))).toMatchObject({
      reason: "system_user",
    });
    expect(welcomeVerdict(facts({ user: row(NOW.toISOString(), { banned: true }) }))).toMatchObject({ reason: "banned" });
  });

  it("retries later instead of skipping for good when Slack can't tell", () => {
    expect(welcomeVerdict(facts({ member: null }))).toEqual({ eligible: false, final: false, reason: "slack_profile_unavailable" });
    expect(welcomeVerdict(facts({ postedBefore: null }))).toEqual({ eligible: false, final: false, reason: "history_unavailable" });
  });
});

describe("isOfficeMessage", () => {
  const message = (overrides: Record<string, unknown> = {}) => ({ channel: OFFICE, user: ODUL, subtype: null, ...overrides });

  it("only counts messages people write in the office channel", () => {
    expect(isOfficeMessage(message(), OFFICE)).toBe(true);
    expect(isOfficeMessage(message({ subtype: "thread_broadcast" }), OFFICE)).toBe(true);
    expect(isOfficeMessage(message({ channel: "CGENERAL" }), OFFICE)).toBe(false);
    expect(isOfficeMessage(message({ channel: "D123" }), OFFICE)).toBe(false);
    expect(isOfficeMessage(message({ subtype: "channel_join" }), OFFICE)).toBe(false);
    expect(isOfficeMessage(message({ user: null }), OFFICE)).toBe(false);
    expect(isOfficeMessage(message(), null)).toBe(false);
  });
});

describe("delayMinutes", () => {
  it("waits between 10 and 20 minutes", () => {
    expect(delayMinutes(() => 0)).toBe(10);
    expect(delayMinutes(() => 0.5)).toBe(15);
    expect(delayMinutes(() => 0.999_999)).toBe(20);
    for (let index = 0; index < 200; index++) expect(delayMinutes()).toBeGreaterThanOrEqual(10);
    for (let index = 0; index < 200; index++) expect(delayMinutes()).toBeLessThanOrEqual(20);
  });
});

const mocks = vi.hoisted(() => {
  const rows = new Map<string, { status: string; reason?: string | null; messageTs?: string }>();
  return {
    rows,
    store: {
      getWelcome: vi.fn(async (slackId: string) => rows.get(slackId) ?? null),
      claimWelcome: vi.fn(async ({ slackId, messageTs }: { slackId: string; messageTs: string }) => {
        if (rows.has(slackId)) return false;
        rows.set(slackId, { status: "scheduled", messageTs });
        return true;
      }),
      recordSkip: vi.fn(async (slackId: string, reason: string) => {
        if (!rows.has(slackId)) rows.set(slackId, { status: "skipped", reason });
      }),
      markSkipped: vi.fn(async (slackId: string, reason: string) => {
        if (rows.get(slackId)?.status === "scheduled") rows.set(slackId, { status: "skipped", reason });
      }),
      markSent: vi.fn(async (slackId: string) => void rows.set(slackId, { status: "sent" })),
      releaseWelcome: vi.fn(async (slackId: string) => {
        if (rows.get(slackId)?.status === "scheduled") rows.delete(slackId);
      }),
      talkedToManfrod: vi.fn(async (_userId: string) => false),
      welcomeEnabled: vi.fn(async () => true),
    },
    accounts: {
      getUserBySlackId: vi.fn(async (_slackId: string): Promise<Record<string, unknown> | null> => null),
      findOrCreateBySlackId: vi.fn(async (slackId: string, dm: string, name: string | null) => ({
        id: "user-new",
        slackId,
        slackDmChannelId: dm,
        name,
        insertedAt: new Date(),
        banned: false,
      })),
    },
    slack: {
      fetchWorkspaceMember: vi.fn(async (_slackId: string): Promise<WorkspaceMember | null> => null),
      botIdentity: vi.fn(async () => ({ botId: "B1", userId: "UBOT", teamId: "TTEAM", url: "https://x.slack.com/" })),
      historyPageBefore: vi.fn(async (..._args: unknown[]) => ({
        messages: [] as Record<string, unknown>[],
        nextCursor: null as string | null,
      })),
      openDm: vi.fn(async (_slackId: string) => "DNEW" as string | null),
    },
    sendEvent: vi.fn(async (..._args: unknown[]) => true),
    decide: vi.fn(async (..._args: unknown[]) => ({ send: true, reason: "new person", message: "hej, jestem Manfrod" }) as unknown),
    deliverProactive: vi.fn(async (..._args: unknown[]) => ({ ok: true }) as { ok: true } | { ok: false; error: string }),
  };
});

vi.mock("../../lib/welcome/store.ts", () => mocks.store);
vi.mock("../../lib/accounts.ts", () => mocks.accounts);
vi.mock("../../lib/slack/api.ts", () => mocks.slack);
vi.mock("../../lib/office/layout.ts", () => ({ getLayout: async () => ({ planChannelId: OFFICE }) }));
vi.mock("../../lib/inngest/client.ts", () => ({ EVENTS: { welcomeRequested: "manfrod/welcome.requested" }, sendEvent: mocks.sendEvent }));
vi.mock("../../lib/nudges/compose.ts", () => ({ decide: mocks.decide }));
vi.mock("../../lib/proactive.ts", () => ({ deliverProactive: mocks.deliverProactive }));
vi.mock("../../lib/agent-settings.ts", () => ({ internalLanguage: async () => "Polish" }));

const { deliverWelcome, noticeOfficeMessage } = await import("../../lib/welcome/index.ts");

const posted = (overrides: Record<string, unknown> = {}) => ({
  channel: OFFICE,
  ts: "1764064800.000100",
  user: ODUL,
  text: "hi, is anyone in the office today?",
  subtype: null,
  ...overrides,
});

const knownSince = (insertedAt: string) => ({
  id: "user-odul",
  slackId: ODUL,
  slackDmChannelId: "DODUL",
  name: "Odul",
  insertedAt: new Date(insertedAt),
  banned: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows.clear();
  mocks.store.welcomeEnabled.mockResolvedValue(true);
  mocks.store.talkedToManfrod.mockResolvedValue(false);
  mocks.accounts.getUserBySlackId.mockResolvedValue(null);
  mocks.slack.fetchWorkspaceMember.mockResolvedValue(fullMember());
  mocks.slack.historyPageBefore.mockResolvedValue({ messages: [], nextCursor: null });
  mocks.sendEvent.mockResolvedValue(true);
});

describe("noticeOfficeMessage", () => {
  it("schedules one welcome for a new person, 10 to 20 minutes out", async () => {
    expect(await noticeOfficeMessage(posted(), NOW, () => 0.3)).toBe("scheduled");
    expect(mocks.sendEvent).toHaveBeenCalledTimes(1);
    const [name, data, id] = mocks.sendEvent.mock.calls[0] as [string, Record<string, unknown>, string];
    expect(name).toBe("manfrod/welcome.requested");
    expect(id).toBe(`welcome-${ODUL}-1764064800.000100`);
    expect(data).toMatchObject({
      claimKey: `${ODUL}-1764064800.000100`,
      slackId: ODUL,
      channelId: OFFICE,
      delayMinutes: 13,
      text: "hi, is anyone in the office today?",
    });
  });

  it("schedules only once when the person posts several messages", async () => {
    const outcomes = await Promise.all([noticeOfficeMessage(posted(), NOW), noticeOfficeMessage(posted({ ts: "2" }), NOW)]);
    expect(await noticeOfficeMessage(posted({ ts: "3" }), NOW)).toBe("handled");
    expect(outcomes.filter((outcome) => outcome === "scheduled")).toHaveLength(1);
    expect(mocks.sendEvent).toHaveBeenCalledTimes(1);
  });

  it("ignores every channel other than the office channel", async () => {
    expect(await noticeOfficeMessage(posted({ channel: "CGENERAL" }), NOW)).toBe("ignored");
    expect(mocks.store.getWelcome).not.toHaveBeenCalled();
    expect(mocks.sendEvent).not.toHaveBeenCalled();
  });

  it("does nothing for someone already welcomed", async () => {
    mocks.rows.set(ODUL, { status: "sent" });
    expect(await noticeOfficeMessage(posted(), NOW)).toBe("handled");
    expect(mocks.accounts.getUserBySlackId).not.toHaveBeenCalled();
    expect(mocks.sendEvent).not.toHaveBeenCalled();
  });

  it("records an old employee as skipped and never asks Slack about them again", async () => {
    mocks.accounts.getUserBySlackId.mockResolvedValue(knownSince("2026-03-02T09:00:00Z"));
    expect(await noticeOfficeMessage(posted(), NOW)).toBe("known_too_long");
    expect(mocks.rows.get(ODUL)).toEqual({ status: "skipped", reason: "known_too_long" });
    expect(await noticeOfficeMessage(posted({ ts: "2" }), NOW)).toBe("handled");
    expect(mocks.slack.fetchWorkspaceMember).not.toHaveBeenCalled();
    expect(mocks.sendEvent).not.toHaveBeenCalled();
  });

  it("skips someone who already talked to Manfrod", async () => {
    mocks.accounts.getUserBySlackId.mockResolvedValue(knownSince("2026-11-24T12:00:00Z"));
    mocks.store.talkedToManfrod.mockResolvedValue(true);
    expect(await noticeOfficeMessage(posted(), NOW)).toBe("talked_to_manfrod");
    expect(mocks.sendEvent).not.toHaveBeenCalled();
  });

  it("schedules the odul case: users row from a visit edit a day ago, no conversations", async () => {
    mocks.accounts.getUserBySlackId.mockResolvedValue(knownSince("2026-11-24T12:00:00Z"));
    expect(await noticeOfficeMessage(posted(), NOW)).toBe("scheduled");
    const [, latest] = mocks.slack.historyPageBefore.mock.calls[0] as [string, string];
    expect(Number(latest)).toBe(Date.parse("2026-11-10T12:00:00Z") / 1000);
  });

  it("skips bots, guests and people from other workspaces", async () => {
    for (const [member, reason] of [
      [fullMember({ bot: true }), "bot"],
      [fullMember({ restricted: true }), "guest"],
      [fullMember({ ultraRestricted: true }), "guest"],
      [fullMember({ stranger: true, teamId: "TOTHER" }), "external"],
    ] as const) {
      mocks.rows.clear();
      mocks.slack.fetchWorkspaceMember.mockResolvedValueOnce(member);
      expect(await noticeOfficeMessage(posted(), NOW)).toBe(reason);
    }
    expect(mocks.sendEvent).not.toHaveBeenCalled();
  });

  it("skips someone who wrote in the office channel before Manfrod could know them", async () => {
    mocks.slack.historyPageBefore
      .mockResolvedValueOnce({ messages: [{ user: "UOTHER", ts: "1" }], nextCursor: "next" })
      .mockResolvedValueOnce({ messages: [{ user: ODUL, ts: "0.5", subtype: "channel_join" }], nextCursor: null });
    expect(await noticeOfficeMessage(posted(), NOW)).toBe("posted_before");
    expect(mocks.sendEvent).not.toHaveBeenCalled();
  });

  it("keeps nothing when Slack is unavailable, so a later message tries again", async () => {
    mocks.slack.historyPageBefore.mockResolvedValueOnce(null as never);
    expect(await noticeOfficeMessage(posted(), NOW)).toBe("history_unavailable");
    expect(mocks.rows.has(ODUL)).toBe(false);
  });

  it("releases the claim when the event can't be queued", async () => {
    mocks.sendEvent.mockResolvedValueOnce(false);
    expect(await noticeOfficeMessage(posted(), NOW)).toBe("queue_unavailable");
    expect(mocks.rows.has(ODUL)).toBe(false);
  });

  it("does nothing while the panel switch is off", async () => {
    mocks.store.welcomeEnabled.mockResolvedValue(false);
    expect(await noticeOfficeMessage(posted(), NOW)).toBe("disabled");
    expect(mocks.sendEvent).not.toHaveBeenCalled();
  });
});

describe("deliverWelcome", () => {
  const request = {
    claimKey: `${ODUL}-1`,
    slackId: ODUL,
    channelId: OFFICE,
    messageTs: "1",
    text: "czy ktoś jest dziś w biurze?",
    delayMinutes: 12,
  };

  it("drafts the welcome in the language of the office message and sends it as a DM", async () => {
    mocks.rows.set(ODUL, { status: "scheduled", messageTs: "1" });
    expect(await deliverWelcome(request, NOW)).toEqual({ slackId: ODUL, outcome: "sent" });
    const [brief] = mocks.decide.mock.calls[0] as [Record<string, string>];
    expect(brief.language).toContain("the language of their own message in the office channel");
    expect(brief.language).toContain("Polish");
    expect(brief.context).toContain("czy ktoś jest dziś w biurze?");
    expect(mocks.slack.openDm).toHaveBeenCalledWith(ODUL);
    expect(mocks.accounts.findOrCreateBySlackId).toHaveBeenCalledWith(ODUL, "DNEW", "Odul", "odul@example.com");
    const [userId, prompt, kind, title, titleInOwnLanguage] = mocks.deliverProactive.mock.calls[0] as unknown[];
    expect([userId, kind, title, titleInOwnLanguage]).toEqual(["user-new", "nudge_welcome", "hej, jestem Manfrod", true]);
    expect(prompt).toContain("hej, jestem Manfrod");
    expect(prompt).toContain("Keep its language exactly as it is");
    expect(mocks.rows.get(ODUL)).toEqual({ status: "sent" });
  });

  it("skips when the person talked to Manfrod during the wait", async () => {
    mocks.rows.set(ODUL, { status: "scheduled", messageTs: "1" });
    mocks.accounts.getUserBySlackId.mockResolvedValue(knownSince(NOW.toISOString()));
    mocks.store.talkedToManfrod.mockResolvedValue(true);
    expect(await deliverWelcome(request, NOW)).toEqual({ slackId: ODUL, outcome: "talked_to_manfrod" });
    expect(mocks.deliverProactive).not.toHaveBeenCalled();
    expect(mocks.rows.get(ODUL)).toEqual({ status: "skipped", reason: "talked_to_manfrod" });
  });

  it("ignores a run left over from an earlier, released claim", async () => {
    mocks.rows.set(ODUL, { status: "scheduled", messageTs: "2" });
    expect(await deliverWelcome(request, NOW)).toEqual({ slackId: ODUL, outcome: "not_scheduled" });
    expect(mocks.deliverProactive).not.toHaveBeenCalled();
  });

  it("never sends twice", async () => {
    mocks.rows.set(ODUL, { status: "sent" });
    expect(await deliverWelcome(request, NOW)).toEqual({ slackId: ODUL, outcome: "not_scheduled" });
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(mocks.deliverProactive).not.toHaveBeenCalled();
  });

  it("frees the claim when the DM could not be delivered", async () => {
    mocks.rows.set(ODUL, { status: "scheduled", messageTs: "1" });
    mocks.deliverProactive.mockResolvedValueOnce({ ok: false, error: "channel_not_found" });
    expect(await deliverWelcome(request, NOW)).toEqual({ slackId: ODUL, outcome: "channel_not_found" });
    expect(mocks.rows.has(ODUL)).toBe(false);
  });
});
