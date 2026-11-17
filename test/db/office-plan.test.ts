import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

vi.mock("../../lib/office/presence-firmowid.ts", () => ({
  fetchFirmowidSignals: async () => ({ sessionDays: null, leaveRequests: null }),
}));

const { db, tables } = await import("../../lib/db/index.ts");
const layout = await import("../../lib/office/layout.ts");
const { preparePlan } = await import("../../lib/office/plan.ts");
const { planAwayUserIds, updatePlan } = await import("../../lib/office/plan-store.ts");
const { recordVisit } = await import("../../lib/office/presence-store.ts");
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
    layoutId = (await layout.getLayout()).id;
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
});
