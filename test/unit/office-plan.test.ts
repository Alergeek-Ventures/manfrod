import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficeDayPrediction } from "../../lib/office/presence.ts";

const slack = vi.hoisted(() => ({
  post: vi.fn(async (_endpoint: string, _body: Record<string, any>) => ({
    ok: true as const,
    body: { ts: "111.222" } as Record<string, any>,
  })),
  openDm: vi.fn(async (slackId: string) => `D-${slackId}`),
  getPermalink: vi.fn(async () => "https://slack.test/p1"),
}));
const plan = vi.hoisted(() => ({
  evaluateDay: vi.fn(),
  postPlan: vi.fn(),
  refreshPlan: vi.fn(),
}));
const store = vi.hoisted(() => ({
  getPlan: vi.fn(),
  listPlans: vi.fn(async () => [] as { date: string }[]),
  savePlan: vi.fn(async () => ({})),
  updatePlan: vi.fn(async () => ({})),
  planAwayUserIds: vi.fn(async () => new Set<string>()),
}));
const layout = vi.hoisted(() => ({ loadOffice: vi.fn(), getLayout: vi.fn(async () => ({ id: "layout-1" })) }));
const presence = vi.hoisted(() => ({ listVisits: vi.fn(async () => [] as unknown[]), setPresence: vi.fn(async () => ({})) }));
const desks = vi.hoisted(() => ({ cancelReservationsForDate: vi.fn(async () => [] as string[]), reserveDesk: vi.fn() }));
const accounts = vi.hoisted(() => ({ getUser: vi.fn(), getUserBySlackId: vi.fn() }));
const map = vi.hoisted(() => ({ loadMapState: vi.fn() }));
const holidays = vi.hoisted(() => ({ publicHolidayDates: vi.fn(async () => new Set<string>()) }));
const tx = vi.hoisted(() => ({
  deleted: 0,
  inserted: [] as unknown[],
  delete: vi.fn(() => ({ where: vi.fn(async () => (tx.deleted += 1)) })),
  insert: vi.fn(() => ({ values: vi.fn(async (rows: unknown[]) => tx.inserted.push(...rows)) })),
}));

vi.mock("../../lib/slack/api.ts", () => slack);
vi.mock("../../lib/office/plan.ts", () => plan);
vi.mock("../../lib/office/plan-store.ts", () => store);
vi.mock("../../lib/office/layout.ts", () => layout);
vi.mock("../../lib/office/presence.ts", () => presence);
vi.mock("../../lib/desks.ts", () => desks);
vi.mock("../../lib/accounts.ts", () => accounts);
vi.mock("../../lib/office/map.ts", () => map);
vi.mock("../../lib/holidays.ts", () => holidays);
vi.mock("../../lib/db/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/db/index.ts")>()),
  db: { transaction: async (run: (t: typeof tx) => Promise<void>) => run(tx) },
}));

const { runDeskPlan, runDeskPlanHeadsUp } = await import("../../lib/office/plan-cron.ts");
const actions = await import("../../lib/office/plan-actions.ts");
const { PLAN_ACTION, PLAN_CALLBACK, encodeSwap } = await import("../../lib/office/plan-message.ts");
const { summarizeDay } = await vi.importActual<typeof import("../../lib/office/plan.ts")>("../../lib/office/plan.ts");

const TODAY = "2026-11-17";
const DATE = "2026-11-18";

const office = (planChannelId: string | null = "C123", threshold = 6) => ({
  layout: { id: "layout-1", planChannelId, crowdedThreshold: threshold },
  desks: [] as Record<string, unknown>[],
});

const user = (id: string) => ({ id, slackId: `U${id}`, name: `Name ${id}` });

const mapDesk = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: id.toUpperCase(),
  equipment: [],
  status: "free",
  ownerUserId: null,
  fullName: null,
  reservation: null,
  ...extra,
});

const calls = (endpoint: string) => slack.post.mock.calls.filter(([name]) => name === endpoint).map(([, body]) => body);

beforeEach(() => {
  vi.clearAllMocks();
  tx.deleted = 0;
  tx.inserted = [];
  layout.loadOffice.mockResolvedValue(office());
  store.getPlan.mockResolvedValue(null);
  plan.refreshPlan.mockResolvedValue({ ok: true, updated: true, plan: null, prepared: null });
});

describe("summarizeDay", () => {
  const desk = (id: string, ownerUserId: string | null = null) => ({ id, label: id, ownerUserId, active: true });
  const person = (userId: string, status: string) => ({
    userId,
    name: userId,
    slackId: `U${userId}`,
    status,
    confidence: 1,
    sources: [],
    reason: "",
  });
  const prediction = (people: ReturnType<typeof person>[], visits: Record<string, unknown>[] = [], guests = 0) =>
    ({
      date: DATE,
      layoutId: "layout-1",
      people,
      visits,
      guests,
      expectedInOffice: people.filter((p) => p.status === "office").length + guests,
    }) as unknown as OfficeDayPrediction;
  const day = (pred: OfficeDayPrediction, reservations: Record<string, unknown>[] = [], threshold = 6) =>
    summarizeDay({
      date: DATE,
      office: { layout: { crowdedThreshold: threshold }, desks: [desk("a"), desk("b"), desk("c"), desk("o1", "olga")] } as never,
      prediction: pred,
      reservations: reservations as never,
      stated: [],
    });

  it("is quiet with three people and free desks", () => {
    const result = day(prediction([person("ala", "office"), person("bob", "office"), person("olga", "office"), person("cyd", "remote")]));
    expect(result).toMatchObject({ demand: 2, supply: 3, expectedInOffice: 3, crowded: false, reasons: [] });
    expect([...result.away]).toEqual(["cyd"]);
  });

  it("is crowded when owners' desks are needed", () => {
    const result = day(prediction([person("ala", "office"), person("bob", "office"), person("cyd", "office"), person("dan", "office")]));
    expect(result).toMatchObject({ demand: 4, supply: 3, crowded: true });
  });

  it("counts manual reservations as seated and their desks as taken", () => {
    const result = day(prediction([person("ala", "office"), person("bob", "office")]), [
      { deskId: "a", userId: "ala", guestName: null, source: "manual" },
      { deskId: "b", userId: "zed", guestName: null, source: "plan" },
    ]);
    expect(result).toMatchObject({ demand: 1, supply: 2, crowded: false });
  });

  it("is crowded with a visit and names its guests", () => {
    const result = day(prediction([person("ala", "office")], [{ id: "v1", note: "zespół z Wrocławia", guests: 2, userIds: ["ala"] }], 2));
    expect(result.crowded).toBe(true);
    expect(result.reasons).toContain("przyjeżdża: zespół z Wrocławia");
    expect(result.people.map((p) => [p.name, p.groups])).toEqual([
      ["ala", ["visit:v1"]],
      ["Gość z Wrocławia 1", ["visit:v1"]],
      ["Gość z Wrocławia 2", ["visit:v1"]],
    ]);
  });

  it("is crowded at the threshold", () => {
    expect(day(prediction([person("ala", "office"), person("olga", "office")]), [], 2).reasons).toEqual(["~2 osoby w biurze (próg: 2)"]);
  });
});

describe("desk-plan cron", () => {
  it("does nothing without a plan channel", async () => {
    layout.loadOffice.mockResolvedValue(office(null));
    expect(await runDeskPlan(TODAY)).toEqual({ skipped: "no_plan_channel" });
    expect(await runDeskPlanHeadsUp(TODAY)).toEqual({ skipped: "no_plan_channel" });
    expect(plan.evaluateDay).not.toHaveBeenCalled();
  });

  it("plans Monday on Friday and skips holidays", async () => {
    holidays.publicHolidayDates.mockResolvedValueOnce(new Set(["2026-11-23"]));
    plan.evaluateDay.mockResolvedValue({ crowded: false, expectedInOffice: 3 });
    expect(await runDeskPlan("2026-11-20")).toEqual({ date: "2026-11-24", action: "skip", expected: 3 });
    expect(plan.postPlan).not.toHaveBeenCalled();
  });

  it("posts a crowded day without a plan", async () => {
    const evaluation = { crowded: true, expectedInOffice: 9, reasons: ["przyjeżdża: Wrocław"] };
    plan.evaluateDay.mockResolvedValue(evaluation);
    plan.postPlan.mockResolvedValue({ ok: true });
    expect(await runDeskPlan(TODAY)).toMatchObject({ date: DATE, action: "post", ok: true });
    expect(plan.postPlan).toHaveBeenCalledWith(DATE, { today: TODAY, evaluation });
  });

  it("refreshes a posted plan only through refreshPlan and respects a decline", async () => {
    store.getPlan.mockResolvedValueOnce({ status: "posted" });
    plan.refreshPlan.mockResolvedValueOnce({ ok: true, updated: false });
    expect(await runDeskPlan(TODAY)).toEqual({ date: DATE, action: "refresh", updated: false });
    expect(plan.refreshPlan).toHaveBeenCalledWith(DATE, { today: TODAY });
    store.getPlan.mockResolvedValueOnce({ status: "declined" });
    expect(await runDeskPlan(TODAY)).toMatchObject({ action: "skip", reason: "declined" });
    expect(plan.evaluateDay).not.toHaveBeenCalled();
  });

  it("sends one heads-up per visit date that has no plan row", async () => {
    presence.listVisits.mockResolvedValue([{ startsOn: "2026-11-19", endsOn: "2026-11-19", note: "zespół z Wrocławia" }]);
    plan.evaluateDay.mockResolvedValue({ expectedInOffice: 9, visitNotes: ["zespół z Wrocławia"] });
    expect(await runDeskPlanHeadsUp(TODAY)).toMatchObject({ sent: ["2026-11-19"] });
    const [message] = calls("chat.postMessage");
    expect(message).toMatchObject({
      channel: "C123",
      text: "W czwartek ~9 osób (przyjeżdża: zespół z Wrocławia). Przygotować plan biurek?",
    });
    expect(message.blocks[1].elements.map((element: any) => element.action_id)).toEqual([PLAN_ACTION.prepare, PLAN_ACTION.skip]);
    expect(store.savePlan).toHaveBeenCalledWith("layout-1", "2026-11-19", { status: "heads_up", channelId: "C123", headsUpTs: "111.222" });

    store.listPlans.mockResolvedValueOnce([{ date: "2026-11-19" }]);
    expect(await runDeskPlanHeadsUp(TODAY)).toMatchObject({ sent: [] });
  });
});

describe("plan interactions", () => {
  const payload = (actionId: string, value: string, extra: Record<string, unknown> = {}) => ({
    type: "block_actions",
    user: { id: "Uala" },
    trigger_id: "trigger",
    channel: { id: "C123" },
    message: { ts: "900.1", text: "W czwartek ~9 osób" },
    actions: [{ action_id: actionId, value }],
    ...extra,
  });

  beforeEach(() => {
    accounts.getUserBySlackId.mockImplementation(async (slackId: string) => user(slackId.slice(1)));
    accounts.getUser.mockImplementation(async (id: string) => user(id));
  });

  it("Nie będę marks the clicker remote, frees their desk and refreshes the plan", async () => {
    desks.cancelReservationsForDate.mockResolvedValueOnce(["A2"]);
    await actions.handlePlanAction(payload(PLAN_ACTION.away, DATE));
    expect(presence.setPresence).toHaveBeenCalledWith("ala", DATE, "remote", "button");
    expect(desks.cancelReservationsForDate).toHaveBeenCalledWith("ala", DATE);
    expect(plan.refreshPlan).toHaveBeenCalledWith(DATE, { force: true });
    expect(calls("chat.postEphemeral")[0]).toMatchObject({ channel: "C123", user: "Uala" });
    expect(calls("chat.postEphemeral")[0].text).toContain("Biurko A2 jest wolne");
  });

  it("Jednak będę marks the clicker in the office and tells them their desk", async () => {
    plan.refreshPlan.mockResolvedValueOnce({
      ok: true,
      updated: true,
      plan: null,
      prepared: { result: { assignments: [{ userId: "ala", label: "B3" }] } },
    });
    await actions.handlePlanAction(payload(PLAN_ACTION.coming, DATE));
    expect(presence.setPresence).toHaveBeenCalledWith("ala", DATE, "office", "button");
    expect(calls("chat.postEphemeral")[0].text).toContain("*B3*");
  });

  it("Zmień biurko opens a modal with free desks and the submission books the chosen one", async () => {
    map.loadMapState.mockResolvedValue({
      desks: [
        mapDesk("a1"),
        mapDesk("o1", { status: "owner_away", ownerUserId: "olga" }),
        mapDesk("t1", { status: "taken", reservation: { userId: "bob" } }),
      ],
    });
    await actions.handlePlanAction(payload(PLAN_ACTION.change, DATE));
    const [open] = calls("views.open");
    expect(open.trigger_id).toBe("trigger");
    expect(open.view.callback_id).toBe(PLAN_CALLBACK.change);
    expect(open.view.blocks[0].element.options.map((option: any) => option.value)).toEqual(["A1", "O1"]);

    desks.reserveDesk.mockResolvedValueOnce({ ok: true, reservation: { desk: { label: "O1" } } });
    await actions.handlePlanSubmission({
      type: "view_submission",
      user: { id: "Uala" },
      view: {
        callback_id: PLAN_CALLBACK.change,
        private_metadata: open.view.private_metadata,
        state: { values: { choice: { value: { selected_option: { value: "O1" } } } } },
      },
    });
    expect(desks.reserveDesk).toHaveBeenCalledWith("O1", { userId: "ala" }, DATE, { awayUserIds: new Set() });
    expect(plan.refreshPlan).toHaveBeenCalledWith(DATE, { force: true });
  });

  it("Zamień się asks the other person by DM and accepting swaps both desks", async () => {
    const state = {
      desks: [
        mapDesk("a1", { status: "taken", fullName: "Name ala", reservation: { userId: "ala" } }),
        mapDesk("o1", { status: "owner_present", ownerUserId: "bob", fullName: "Name bob" }),
      ],
    };
    map.loadMapState.mockResolvedValue(state);
    await actions.handlePlanAction(payload(PLAN_ACTION.swap, DATE));
    expect(calls("views.open")[0].view.blocks[0].element.options).toEqual([
      { text: { type: "plain_text", text: "Name bob (O1)" }, value: "bob" },
    ]);

    const started = await actions.requestSwap(user("ala") as never, user("bob") as never, DATE);
    expect(started.ok).toBe(true);
    const dm = calls("chat.postMessage")[0];
    expect(dm.channel).toBe("D-Ubob");
    const accept = dm.blocks[1].elements[0];
    expect(accept.action_id).toBe(PLAN_ACTION.swapAccept);

    await actions.handlePlanAction(payload(PLAN_ACTION.swapAccept, accept.value, { user: { id: "Uala" }, channel: { id: "D-Uala" } }));
    expect(tx.inserted).toEqual([]);

    await actions.handlePlanAction(payload(PLAN_ACTION.swapAccept, accept.value, { user: { id: "Ubob" }, channel: { id: "D-Ubob" } }));
    expect(tx.inserted).toEqual([
      { deskId: "o1", userId: "ala", date: DATE, source: "manual", note: "zamiana" },
      { deskId: "a1", userId: "bob", date: DATE, source: "manual", note: "zamiana" },
    ]);
    expect(plan.refreshPlan).toHaveBeenCalledWith(DATE, { force: true });
    expect(calls("chat.update").at(-1)).toMatchObject({ channel: "D-Ubob", ts: "900.1" });
  });

  it("refuses a stale swap", async () => {
    map.loadMapState.mockResolvedValue({ desks: [mapDesk("a1", { status: "taken", reservation: { userId: "ala" } })] });
    const value = encodeSwap({ date: DATE, from: "ala", to: "bob", fromDesk: "a1", toDesk: "o1" });
    await actions.handlePlanAction(payload(PLAN_ACTION.swapAccept, value, { user: { id: "Ubob" } }));
    expect(tx.inserted).toEqual([]);
    expect(calls("chat.update")[0].blocks[1].elements[0].text).toContain("nieaktualna");
  });

  it("Przygotuj posts the plan and Nie trzeba declines it", async () => {
    plan.postPlan.mockResolvedValueOnce({ ok: true, permalink: "https://slack.test/p1", posted: true });
    await actions.handlePlanAction(payload(PLAN_ACTION.prepare, "2026-11-19"));
    expect(plan.postPlan).toHaveBeenCalledWith("2026-11-19");
    expect(calls("chat.update")[0].blocks.some((block: any) => block.type === "actions")).toBe(false);

    store.getPlan.mockResolvedValueOnce({ status: "heads_up" });
    await actions.handlePlanAction(payload(PLAN_ACTION.skip, "2026-11-19"));
    expect(store.updatePlan).toHaveBeenCalledWith("layout-1", "2026-11-19", { status: "declined" });
  });

  it("ignores unknown people", async () => {
    accounts.getUserBySlackId.mockResolvedValueOnce(null);
    await actions.handlePlanAction(payload(PLAN_ACTION.away, DATE));
    expect(presence.setPresence).not.toHaveBeenCalled();
  });
});
