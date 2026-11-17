import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

vi.mock("../../lib/office/presence-firmowid.ts", () => ({
  fetchFirmowidSignals: async () => ({ sessionDays: null, leaveRequests: null }),
}));

const slack = vi.hoisted(() => ({
  fail: false,
  posted: 0,
  updates: [] as Record<string, any>[],
}));

vi.mock("../../lib/slack/api.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/slack/api.ts")>()),
  getPermalink: async () => "https://slack.test/p",
  post: async (endpoint: string, body: Record<string, any>) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (endpoint === "chat.postMessage") {
      if (slack.fail) return { ok: false, error: "channel_not_found" };
      slack.posted += 1;
      return { ok: true, body: { ts: `${1000 + slack.posted}.1` } };
    }
    if (endpoint === "chat.update") slack.updates.push(body);
    return { ok: true, body: {} };
  },
}));

vi.mock("../../lib/nudges/compose.ts", () => ({ decide: async () => null }));

const { db, tables } = await import("../../lib/db/index.ts");
const layout = await import("../../lib/office/layout.ts");
const { postPlan, preparePlan, refreshPlan } = await import("../../lib/office/plan.ts");
const { getPlan, planAwayUserIds, updatePlan } = await import("../../lib/office/plan-store.ts");
const { recordVisit } = await import("../../lib/office/presence-store.ts");
const desksLib = await import("../../lib/desks.ts");
const { addDays, localToday } = await import("../../lib/time.ts");
const { and, eq, inArray } = await import("drizzle-orm");

const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
const weekdayAhead = (days: number) => {
  let date = addDays(localToday(), days);
  while ([0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())) date = addDays(date, 1);
  return date;
};
const date = weekdayAhead(45);
const userIds: string[] = [];
const deskIds: string[] = [];
const visitIds: string[] = [];
let layoutId = "";
let originalChannel: string | null = null;

async function user(name: string) {
  const [created] = await db
    .insert(tables.users)
    .values({ slackId: `UPLAN${suffix}${userIds.length}`, slackDmChannelId: `DPLAN${suffix}${userIds.length}`, name: `${name} ${suffix}` })
    .returning();
  userIds.push(created.id);
  await db.insert(tables.officeMembers).values({ userId: created.id, layoutId });
  return created;
}

async function desk(label: string, x: number, ownerUserId: string | null = null) {
  const created = await layout.createDesk({ label: `${label}-${suffix}`, x, y: 30, ownerUserId });
  deskIds.push(created.id);
  return created;
}

describe.skipIf(!enabled)("preparePlan", () => {
  let owner: Awaited<ReturnType<typeof user>>;
  let returning: Awaited<ReturnType<typeof user>>;
  let ala: Awaited<ReturnType<typeof user>>;
  let bob: Awaited<ReturnType<typeof user>>;
  let cyd: Awaited<ReturnType<typeof user>>;
  let ownedAway: Awaited<ReturnType<typeof desk>>;
  let ownedBack: Awaited<ReturnType<typeof desk>>;
  let recent: Awaited<ReturnType<typeof desk>>;

  beforeAll(async () => {
    const current = await layout.getLayout();
    layoutId = current.id;
    originalChannel = current.planChannelId;
    owner = await user("Olga");
    returning = await user("Piotr");
    ala = await user("Ala");
    bob = await user("Bob");
    cyd = await user("Cyd");
    ownedAway = await desk("TO", 0, owner.id);
    ownedBack = await desk("TP", 8, returning.id);
    recent = await desk("TA", 16);
    await desk("TB", 24);
    await db.insert(tables.officePresence).values([
      { userId: owner.id, date, status: "remote", source: "chat" },
      { userId: returning.id, date, status: "office", source: "chat" },
      { userId: ala.id, date, status: "office", source: "chat" },
      { userId: bob.id, date, status: "office", source: "chat" },
      { userId: cyd.id, date, status: "office", source: "chat" },
    ]);
    await db.insert(tables.deskReservations).values([
      { deskId: recent.id, userId: ala.id, date: addDays(date, -7), source: "manual" },
      { deskId: ownedBack.id, userId: cyd.id, date, source: "manual" },
    ]);
    const visit = await recordVisit({ startsOn: date, endsOn: date, userIds: [], guests: 2, note: "zespół z Wrocławia", createdBy: null });
    if (visit.ok) visitIds.push(visit.visit.id);
  });

  afterAll(async () => {
    await db.delete(tables.deskPlans).where(and(eq(tables.deskPlans.layoutId, layoutId), eq(tables.deskPlans.date, date)));
    await db.delete(tables.deskReservations).where(and(eq(tables.deskReservations.date, date), eq(tables.deskReservations.source, "plan")));
    if (visitIds.length > 0) await db.delete(tables.officeVisits).where(inArray(tables.officeVisits.id, visitIds));
    if (deskIds.length > 0) await db.delete(tables.desks).where(inArray(tables.desks.id, deskIds));
    if (userIds.length > 0) await db.delete(tables.users).where(inArray(tables.users.id, userIds));
  });

  it("seats everyone, gives the owner's desk back and stores the away set", async () => {
    const prepared = await preparePlan(date);
    const seat = (key: string) => prepared.result.assignments.find((assignment) => assignment.key === key);
    expect(prepared.evaluation.crowded).toBe(true);
    expect(prepared.evaluation.reasons).toContain("przyjeżdża: zespół z Wrocławia");
    expect(seat(`user:${returning.id}`)).toMatchObject({ deskId: ownedBack.id, reason: "owner" });
    expect(seat(`user:${ala.id}`)).toMatchObject({ deskId: recent.id, reason: "recent" });
    expect(prepared.result.displaced.map((person) => person.key)).toEqual([`user:${cyd.id}`]);
    expect(seat(`user:${cyd.id}`)?.deskId).not.toBe(ownedBack.id);
    expect(seat(`user:${bob.id}`)).toBeDefined();
    expect(prepared.result.assignments.filter((assignment) => assignment.guestName?.startsWith("Gość z Wrocławia"))).toHaveLength(2);
    expect(prepared.plan.awayUserIds).toContain(owner.id);
    expect(prepared.changed).toBe(true);

    const rows = await db.select().from(tables.deskReservations).where(eq(tables.deskReservations.date, date));
    expect(rows.find((row) => row.deskId === ownedBack.id)).toBeUndefined();
    expect(rows.filter((row) => row.source === "plan").map((row) => row.userId ?? row.guestName)).toEqual(
      expect.arrayContaining([ala.id, bob.id, cyd.id]),
    );
  });

  it("is stable on a second run and serves the stored away set once posted", async () => {
    const first = await db.select().from(tables.deskReservations).where(eq(tables.deskReservations.date, date));
    const again = await preparePlan(date);
    expect(again.changed).toBe(false);
    const second = await db.select().from(tables.deskReservations).where(eq(tables.deskReservations.date, date));
    expect(second.map((row) => row.id).sort()).toEqual(first.map((row) => row.id).sort());

    expect(await planAwayUserIds(layoutId, date)).toBeNull();
    await updatePlan(layoutId, date, { status: "posted" });
    expect(await planAwayUserIds(layoutId, date)).toContain(owner.id);
    await db
      .update(tables.officePresence)
      .set({ status: "office" })
      .where(and(eq(tables.officePresence.userId, owner.id), eq(tables.officePresence.date, date)));
    expect(await planAwayUserIds(layoutId, date)).not.toContain(owner.id);
  });

  it("does not let a manual booking evict someone else's plan seat", async () => {
    const seat = (await db.select().from(tables.deskReservations).where(eq(tables.deskReservations.date, date))).find(
      (row) => row.source === "plan" && row.userId === bob.id,
    )!;
    const [label] = (await db.select().from(tables.desks).where(eq(tables.desks.id, seat.deskId))).map((row) => row.label);
    expect(await desksLib.reserveDesk(label, { userId: ala.id }, date, { awayUserIds: new Set([owner.id]) })).toEqual({
      ok: false,
      error: "taken",
    });
    const mine = (await db.select().from(tables.deskReservations).where(eq(tables.deskReservations.date, date))).find(
      (row) => row.userId === ala.id,
    );
    expect(mine?.source).toBe("plan");
  });

  it("merges a visit recorded twice by the same author", async () => {
    const first = await recordVisit({ startsOn: date, endsOn: date, userIds: [], guests: 1, note: "klient", createdBy: ala.id });
    const second = await recordVisit({
      startsOn: date,
      endsOn: addDays(date, 1),
      userIds: [],
      guests: 2,
      note: "klient",
      createdBy: ala.id,
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    visitIds.push(first.visit.id);
    expect(second).toMatchObject({ duplicate: true, visit: { id: first.visit.id, guests: 2, endsOn: addDays(date, 1) } });
  });
});

describe.skipIf(!enabled)("posting and refreshing a plan", () => {
  const postDate = weekdayAhead(52);
  let planner: { id: string } | null = null;

  beforeAll(async () => {
    layoutId = (await layout.getLayout()).id;
    planner = await user("Planer");
    await db.insert(tables.officePresence).values({ userId: planner.id, date: postDate, status: "office", source: "chat" });
    await db.update(tables.officeLayouts).set({ planChannelId: "CTESTPLAN" }).where(eq(tables.officeLayouts.id, layoutId));
  });

  afterAll(async () => {
    await db.update(tables.officeLayouts).set({ planChannelId: originalChannel }).where(eq(tables.officeLayouts.id, layoutId));
    await db.delete(tables.deskPlans).where(and(eq(tables.deskPlans.layoutId, layoutId), eq(tables.deskPlans.date, postDate)));
    await db
      .delete(tables.deskReservations)
      .where(and(eq(tables.deskReservations.date, postDate), eq(tables.deskReservations.source, "plan")));
    if (planner) await db.delete(tables.users).where(eq(tables.users.id, planner.id));
  });

  const planSeats = async () =>
    (await db.select().from(tables.deskReservations).where(eq(tables.deskReservations.date, postDate))).filter(
      (row) => row.source === "plan",
    );

  it("removes the plan and its seats when posting fails", async () => {
    slack.fail = true;
    const result = await postPlan(postDate);
    slack.fail = false;
    expect(result).toEqual({ ok: false, error: "channel_not_found" });
    expect(await getPlan(layoutId, postDate)).toBeNull();
    expect(await planSeats()).toEqual([]);
  });

  it("posts once when two posts race", async () => {
    const before = slack.posted;
    const results = await Promise.all([postPlan(postDate), postPlan(postDate)]);
    expect(slack.posted - before).toBe(1);
    expect(results.filter((result) => result.ok && result.posted)).toHaveLength(1);
    const plan = await getPlan(layoutId, postDate);
    expect(plan).toMatchObject({ status: "posted", messageTs: `${1000 + slack.posted}.1`, claimedAt: null });
    expect(plan?.reason).toMatch(/^W .+ \d+\.\d{2} ~/);
    expect((await planSeats()).some((row) => row.userId === planner!.id)).toBe(true);
  });

  it("survives concurrent refreshes and leaves the newest version in Slack", async () => {
    slack.updates.length = 0;
    const results = await Promise.all([1, 2, 3].map(() => refreshPlan(postDate, { force: true })));
    expect(results.every((result) => result.ok && result.updated)).toBe(true);
    const plan = await getPlan(layoutId, postDate);
    const last = slack.updates.at(-1)!;
    const image = last.blocks.find((block: any) => block.type === "image");
    expect(image.image_url).toContain(`v=${plan!.version}&`);
    expect(new Set((await planSeats()).map((row) => row.userId)).size).toBe((await planSeats()).length);
  });
});
