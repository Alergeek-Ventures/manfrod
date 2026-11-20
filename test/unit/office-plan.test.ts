import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficeDayPrediction } from "../../lib/office/presence.ts";

const slack = vi.hoisted(() => ({
  post: vi.fn(async (_endpoint: string, _body: Record<string, any>) => ({
    ok: true as const,
    body: { ts: "111.222", view: { id: "V1" } } as Record<string, any>,
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
  claimHeadsUp: vi.fn(async (_layoutId: string, dates: string[]) => dates),
  setHeadsUpTs: vi.fn(async () => undefined),
  releaseHeadsUp: vi.fn(async () => undefined),
  setUnpostedStatus: vi.fn(async (_layoutId: string, dates: string[]) => dates),
  withPlanLock: vi.fn(async (_layoutId: string, _date: string, run: (exec: unknown) => Promise<unknown>) => run(tx)),
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
const { renderPlanMessage, summarizeDay } = await vi.importActual<typeof import("../../lib/office/plan.ts")>("../../lib/office/plan.ts");

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

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T10:00:00Z"));
});

afterAll(() => vi.useRealTimers());

describe("summarizeDay", () => {
  const desk = (id: string, ownerUserId: string | null = null) => ({ id, label: id, ownerUserId, active: true });
  const person = (userId: string, status: string, source = "explicit_chat") => ({
    userId,
    name: userId,
    slackId: `U${userId}`,
    status,
    confidence: 1,
    sources: [source],
    reason: "",
  });
  const prediction = (people: ReturnType<typeof person>[], visits: Record<string, unknown>[] = []) =>
    ({
      date: DATE,
      layoutId: "layout-1",
      people,
      visits: visits.map((visit) => ({ startsOn: DATE, endsOn: DATE, guestNames: [], createdBy: null, ...visit })),
    }) as unknown as OfficeDayPrediction;
  const day = (
    pred: OfficeDayPrediction,
    reservations: Record<string, unknown>[] = [],
    threshold = 6,
    members = ["ala", "bob", "cyd", "dan", "olga"],
  ) =>
    summarizeDay({
      date: DATE,
      office: { layout: { crowdedThreshold: threshold }, desks: [desk("a"), desk("b"), desk("c"), desk("o1", "olga")] } as never,
      prediction: pred,
      reservations: reservations as never,
      memberIds: new Set(members),
    });

  it("is quiet with three people and free desks", () => {
    const result = day(prediction([person("ala", "office"), person("bob", "office"), person("olga", "office"), person("cyd", "remote")]));
    expect(result).toMatchObject({ demand: 2, supply: 3, expectedInOffice: 3, crowded: false, reasons: [] });
    expect([...result.away]).toEqual(["cyd"]);
  });

  it("treats only stated, leave, absence or a Firmowid session as away, never a habit", () => {
    const result = day(
      prediction([
        person("ala", "remote", "firmowid_habit"),
        person("bob", "remote", "reservation_habit"),
        person("cyd", "leave", "firmowid_leave"),
        person("dan", "remote", "firmowid_session"),
        person("olga", "leave", "absence"),
      ]),
    );
    expect([...result.away].sort()).toEqual(["cyd", "dan", "olga"]);
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

  it("is crowded with a visit of two guests and names them", () => {
    const result = day(prediction([person("ala", "office")], [{ id: "v1", note: "zespół z Wrocławia", guests: 2, userIds: ["ala"] }]));
    expect(result).toMatchObject({ crowded: true, visitExtraPeople: 2, crowdedWithoutVisits: false, expectedInOffice: 3 });
    expect(result.reasons).toContain("przyjeżdża: ala i 2 osoby z Wrocławia");
    expect(result.people.map((p) => [p.name, p.groups])).toEqual([
      ["ala", ["visit:v1"]],
      ["Gość z Wrocławia 1", ["visit:v1"]],
      ["Gość z Wrocławia 2", ["visit:v1"]],
    ]);
  });

  it("counts visiting non-members as extra people but not locals", () => {
    const locals = day(
      prediction([person("ala", "office"), person("bob", "office")], [{ id: "v1", note: "my", guests: 0, userIds: ["ala", "bob"] }]),
    );
    expect(locals).toMatchObject({ visitExtraPeople: 0, crowded: false });
    const client = day(prediction([person("ala", "office")], [{ id: "v2", note: "klient", guests: 1, userIds: [] }]));
    expect(client).toMatchObject({ visitExtraPeople: 1, crowded: false });
    const wroclaw = day(
      prediction(
        [person("ala", "office"), person("wro1", "office", "visit"), person("wro2", "office", "visit")],
        [{ id: "v3", note: "Wrocław", guests: 0, userIds: ["wro1", "wro2"] }],
      ),
    );
    expect(wroclaw).toMatchObject({ visitExtraPeople: 2, crowded: true });
  });

  it("seats a named guest who says they are coming once, not as a guest too", () => {
    const trial = { id: "v1", note: "okres próbny", guests: 2, guestNames: ["Odul", "Mariusz"], userIds: ["staszek"] };
    const people = [person("staszek", "office", "visit"), { ...person("mariusz", "office"), name: "Mariusz Ciastoń" }];
    const result = day(prediction(people, [trial]), [], 6, ["staszek"]);
    expect(result.people.map((p) => p.name)).toEqual(["staszek", "Mariusz Ciastoń", "Odul (gość)"]);
    expect(result.expectedInOffice).toBe(3);
    expect(result.visits[0].summary).toBe("staszek, Odul i Mariusz");
    expect(result.people.at(-1)?.key).toBe("guest:v1:odul (gość)");
  });

  it("does not seat a guest twice when that person booked a desk by name", () => {
    const result = day(
      prediction([person("ala", "office")], [{ id: "v1", note: "goście", guests: 1, guestNames: ["Odul"], userIds: [] }]),
      [{ deskId: "a", userId: null, guestName: "Odul", name: "Odul", source: "manual" }],
    );
    expect(result.people.map((p) => p.name)).toEqual(["ala", "Odul"]);
    expect(result.expectedInOffice).toBe(2);
  });

  it("treats a long stay as people in the office, not a visit, and suggests membership", () => {
    const result = day(
      prediction(
        [person("ala", "office"), person("odul", "office", "visit"), person("mariusz", "office", "visit")],
        [{ id: "v1", note: "okres próbny", guests: 0, userIds: ["odul", "mariusz"], startsOn: DATE, endsOn: "2026-12-01" }],
      ),
    );
    expect(result).toMatchObject({ crowded: false, visitExtraPeople: 0, expectedInOffice: 3 });
    expect(result.longStays).toEqual([
      "odul i mariusz są w biurze do 1.12. Jeśli to na dłużej, admin może dodać te osoby do osób biura w edytorze biura.",
    ]);
  });

  it("puts the seated headcount and a computed reason above the stable intro", () => {
    const evaluation = day(
      prediction([person("ala", "office"), person("bob", "office")], [{ id: "v1", note: "goście", guests: 2, userIds: [] }]),
    );
    const seat = (key: string, name: string, userId: string | null) => ({
      deskId: key,
      label: key,
      key,
      userId,
      guestName: null,
      name,
      reason: "cluster",
    });
    const result = {
      assignments: [seat("A", "ala", "ala"), seat("B", "bob", "bob"), seat("C", "Gość 1", null)],
      overflow: [{ key: "g2", userId: null, guestName: "Gość 2", name: "Gość 2", groups: [] }],
      displaced: [],
      freeDeskIds: [],
    };
    const plan = { date: DATE, version: 2, requestedBy: "UNAT" };
    const message = renderPlanMessage({ evaluation, result, plan } as never, "Przyjeżdżają goście.");
    expect(message.blocks[0].text.text).toBe(
      "*W środę 18.11: 4 osoby w biurze (w tym 2 gości).*\nPrzyjeżdża: 2 osoby; 4 osoby bez własnego biurka, a wolnych biurek bez właściciela jest 3. Przyjeżdżają goście.",
    );

    const calm = day(prediction([person("ala", "office")]));
    const requested = renderPlanMessage(
      { evaluation: calm, result: { ...result, assignments: [seat("A", "ala", "ala")], overflow: [] }, plan } as never,
      "",
    );
    expect(requested.blocks[0].text.text).toBe("*W środę 18.11: 1 osoba w biurze.*\nPlan na prośbę <@UNAT>.");
  });

  it("is crowded at the threshold", () => {
    expect(day(prediction([person("ala", "office"), person("olga", "office")]), [], 2).reasons).toEqual(["~2 osoby w biurze (próg: 2)"]);
  });
});

describe("desk-plan cron", () => {
  const calm = { crowded: false, crowdedWithoutVisits: false, expectedInOffice: 3, reasons: [] };

  it("does nothing without a plan channel", async () => {
    layout.loadOffice.mockResolvedValue(office(null));
    expect(await runDeskPlan(TODAY)).toEqual({ skipped: "no_plan_channel" });
    expect(await runDeskPlanHeadsUp(TODAY)).toEqual({ skipped: "no_plan_channel" });
    expect(plan.evaluateDay).not.toHaveBeenCalled();
  });

  it("skips the run when the holiday calendar can't be read", async () => {
    holidays.publicHolidayDates.mockResolvedValueOnce(null as never);
    expect(await runDeskPlan(TODAY)).toEqual({ skipped: "no_holidays" });
    holidays.publicHolidayDates.mockResolvedValueOnce(null as never);
    expect(await runDeskPlanHeadsUp(TODAY)).toEqual({ skipped: "no_holidays" });
    expect(plan.evaluateDay).not.toHaveBeenCalled();
  });

  it("plans Monday on Friday and skips holidays", async () => {
    holidays.publicHolidayDates.mockResolvedValueOnce(new Set(["2026-11-23"]));
    plan.evaluateDay.mockResolvedValue(calm);
    expect(await runDeskPlan("2026-11-20")).toMatchObject({ date: "2026-11-24", action: "skip", expected: 3 });
    expect(plan.postPlan).not.toHaveBeenCalled();
  });

  it("posts a crowded day without a plan", async () => {
    plan.evaluateDay.mockResolvedValue({
      crowded: true,
      crowdedWithoutVisits: false,
      expectedInOffice: 9,
      reasons: ["przyjeżdża: Wrocław"],
    });
    plan.postPlan.mockResolvedValue({ ok: true });
    expect(await runDeskPlan(TODAY)).toMatchObject({ date: DATE, action: "post", ok: true });
    expect(plan.postPlan).toHaveBeenCalledWith(DATE, { today: TODAY });
  });

  it("posts a requested day even when calm", async () => {
    store.getPlan.mockResolvedValueOnce({ status: "requested" });
    plan.postPlan.mockResolvedValue({ ok: true });
    expect(await runDeskPlan(TODAY)).toMatchObject({ action: "post", requested: true });
    expect(plan.evaluateDay).not.toHaveBeenCalled();
  });

  it("after a decline posts only when crowded for other reasons", async () => {
    store.getPlan.mockResolvedValue({ status: "declined" });
    plan.evaluateDay.mockResolvedValueOnce({ ...calm, crowded: true });
    expect(await runDeskPlan(TODAY)).toMatchObject({ action: "skip" });
    plan.evaluateDay.mockResolvedValueOnce({ ...calm, crowded: true, crowdedWithoutVisits: true });
    plan.postPlan.mockResolvedValue({ ok: true });
    expect(await runDeskPlan(TODAY)).toMatchObject({ action: "post" });
  });

  it("refreshes a posted plan through refreshPlan and leaves one being posted alone", async () => {
    store.getPlan.mockResolvedValueOnce({ status: "posted" });
    plan.refreshPlan.mockResolvedValueOnce({ ok: true, updated: false });
    expect(await runDeskPlan(TODAY)).toEqual({ date: DATE, action: "refresh", updated: false });
    expect(plan.refreshPlan).toHaveBeenCalledWith(DATE, { today: TODAY });
    store.getPlan.mockResolvedValueOnce({ status: "posting" });
    expect(await runDeskPlan(TODAY)).toMatchObject({ action: "skip", reason: "posting" });
    expect(plan.postPlan).not.toHaveBeenCalled();
  });

  it("sends one heads-up for a multi-day visit, claimed before posting", async () => {
    presence.listVisits.mockResolvedValue([
      { id: "v1", startsOn: "2026-11-19", endsOn: "2026-11-20", note: "Odul i Mariusz będą w biurze od 2026-11-19" },
    ]);
    plan.evaluateDay.mockResolvedValue({
      crowded: true,
      expectedInOffice: 9,
      visits: [{ id: "v1", summary: "Odul i Mariusz", long: false }],
    });
    expect(await runDeskPlanHeadsUp(TODAY)).toMatchObject({ sent: [["2026-11-19", "2026-11-20"]] });
    expect(calls("chat.postMessage")).toHaveLength(1);
    const [message] = calls("chat.postMessage");
    expect(message.text).toBe("W czwartek 19.11 – piątek 20.11 ~9 osób (przyjeżdża: Odul i Mariusz). Przygotować plan biurek?");
    expect(message.blocks[1].elements[0].value).toBe("2026-11-19,2026-11-20");
    expect(store.claimHeadsUp.mock.invocationCallOrder[0]).toBeLessThan(slack.post.mock.invocationCallOrder[0]);
    expect(store.setHeadsUpTs).toHaveBeenCalledWith("layout-1", ["2026-11-19", "2026-11-20"], "111.222");
  });

  it("does not post when another run already claimed the dates, and releases a failed claim", async () => {
    presence.listVisits.mockResolvedValue([{ id: "v1", startsOn: "2026-11-19", endsOn: "2026-11-19", note: "Wrocław" }]);
    plan.evaluateDay.mockResolvedValue({ crowded: true, expectedInOffice: 9, visits: [] });
    store.claimHeadsUp.mockResolvedValueOnce([]);
    expect(await runDeskPlanHeadsUp(TODAY)).toMatchObject({ sent: [] });
    expect(calls("chat.postMessage")).toHaveLength(0);
    slack.post.mockResolvedValueOnce({ ok: false, error: "channel_not_found" } as never);
    expect(await runDeskPlanHeadsUp(TODAY)).toMatchObject({ sent: [] });
    expect(store.releaseHeadsUp).toHaveBeenCalledWith("layout-1", ["2026-11-19"]);
  });

  it("skips a heads-up for a visit that does not make the office crowded", async () => {
    presence.listVisits.mockResolvedValue([{ id: "v1", startsOn: "2026-11-19", endsOn: "2026-11-19", note: "klient" }]);
    plan.evaluateDay.mockResolvedValue({ crowded: false, expectedInOffice: 4 });
    expect(await runDeskPlanHeadsUp(TODAY)).toMatchObject({ sent: [] });
    expect(store.claimHeadsUp).not.toHaveBeenCalled();
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
    expect(calls("views.open")[0]).toMatchObject({ trigger_id: "trigger" });
    expect(slack.post.mock.calls[0][0]).toBe("views.open");
    const [open] = calls("views.update");
    expect(open.view_id).toBe("V1");
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
    expect(calls("views.update")[0].view.blocks[0].element.options).toEqual([
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

  it("tells the clicker when the modal can't be opened", async () => {
    slack.post.mockResolvedValueOnce({ ok: false, error: "expired_trigger_id" } as never);
    await actions.handlePlanAction(payload(PLAN_ACTION.swap, DATE));
    expect(calls("views.update")).toHaveLength(0);
    expect(calls("chat.postEphemeral")[0].text).toContain("Nie udało się otworzyć okna");
  });

  it("Przygotuj requests all the heads-up dates and posts the nearest one", async () => {
    plan.postPlan.mockResolvedValueOnce({ ok: true, permalink: "https://slack.test/p1", posted: true });
    await actions.handlePlanAction(payload(PLAN_ACTION.prepare, "2026-11-16,2026-11-19,2026-11-20"));
    expect(store.setUnpostedStatus).toHaveBeenCalledWith("layout-1", ["2026-11-19", "2026-11-20"], "requested", "Uala");
    expect(plan.postPlan).toHaveBeenCalledWith("2026-11-19", { today: TODAY });
    const closed = calls("chat.update")[0];
    expect(closed.blocks.some((block: any) => block.type === "actions")).toBe(false);
    expect(JSON.stringify(closed.blocks)).toContain("piątek 20.11");
  });

  it("Przygotuj refuses past dates", async () => {
    await actions.handlePlanAction(payload(PLAN_ACTION.prepare, "2026-11-16"));
    expect(plan.postPlan).not.toHaveBeenCalled();
    expect(calls("chat.postEphemeral")[0].text).toContain("minął");
  });

  it("Nie trzeba declines every date of the heads-up", async () => {
    await actions.handlePlanAction(payload(PLAN_ACTION.skip, "2026-11-19,2026-11-20"));
    expect(store.setUnpostedStatus).toHaveBeenCalledWith("layout-1", ["2026-11-19", "2026-11-20"], "declined");
    expect(calls("chat.update")).toHaveLength(1);
  });

  it("ignores unknown people", async () => {
    accounts.getUserBySlackId.mockResolvedValueOnce(null);
    await actions.handlePlanAction(payload(PLAN_ACTION.away, DATE));
    expect(presence.setPresence).not.toHaveBeenCalled();
  });
});
