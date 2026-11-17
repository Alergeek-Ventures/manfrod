import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { db, tables } = await import("../../lib/db/index.ts");
const desks = await import("../../lib/desks.ts");
const layout = await import("../../lib/office/layout.ts");
const map = await import("../../lib/office/map.ts");
const { addDays, localToday } = await import("../../lib/time.ts");
const { eq, inArray } = await import("drizzle-orm");

const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
const label = `TEST-${suffix}`;
const date = addDays(localToday(), 21);
const userIds: string[] = [];
let deskId = "";

async function user(name: string) {
  const [created] = await db
    .insert(tables.users)
    .values({ slackId: `UTEST${suffix}${userIds.length}`, slackDmChannelId: `DTEST${suffix}${userIds.length}`, name })
    .returning();
  userIds.push(created.id);
  return created;
}

describe.skipIf(!enabled)("reserving owned desks", () => {
  let owner: Awaited<ReturnType<typeof user>>;
  let other: Awaited<ReturnType<typeof user>>;

  beforeAll(async () => {
    owner = await user(`Owner ${suffix}`);
    other = await user(`Other ${suffix}`);
    const desk = await layout.createDesk({ label, ownerUserId: owner.id, x: 0, y: 0 });
    deskId = desk.id;
  });

  afterAll(async () => {
    if (deskId) await db.delete(tables.desks).where(eq(tables.desks.id, deskId));
    if (userIds.length > 0) await db.delete(tables.users).where(inArray(tables.users.id, userIds));
  });

  it("refuses someone else while the owner has not said they are away", async () => {
    const result = await desks.reserveDesk(label, { userId: other.id }, date);
    expect(result).toEqual({ ok: false, error: "owned", owner: owner.name });
    expect((await map.loadMapState(date)).desks.find((desk) => desk.id === deskId)?.status).toBe("owner_present");
  });

  it("lets the owner book their own desk", async () => {
    const result = await desks.reserveDesk(label.toLowerCase(), { userId: owner.id }, date);
    expect(result.ok).toBe(true);
    expect(await desks.cancelReservation(owner.id, label, date)).toBe(true);
  });

  it("allows booking once the owner is away that day", async () => {
    await db.insert(tables.officePresence).values({ userId: owner.id, date, status: "remote", source: "chat" });
    expect((await map.loadMapState(date)).desks.find((desk) => desk.id === deskId)?.status).toBe("owner_away");
    const result = await desks.reserveDesk(label, { userId: other.id }, date, { note: "z planu", source: "plan" });
    expect(result.ok && result.reservation).toMatchObject({ userId: other.id, source: "plan", note: "z planu", name: other.name });
    const state = await map.loadMapState(date);
    expect(state.desks.find((desk) => desk.id === deskId)).toMatchObject({ status: "taken", fullName: other.name });
  });

  it("accepts an explicit away set and guests", async () => {
    await db.delete(tables.deskReservations).where(eq(tables.deskReservations.deskId, deskId));
    const refused = await desks.reserveDesk(label, { guestName: "Gość" }, date, { awayUserIds: new Set() });
    expect(refused.ok).toBe(false);
    const guest = await desks.reserveDesk(label, { guestName: "Gość" }, date, { awayUserIds: new Set([owner.id]) });
    expect(guest.ok && guest.reservation).toMatchObject({ userId: null, guestName: "Gość", name: "Gość" });
    const listed = await desks.listReservationsForDate(date);
    expect(listed.find((reservation) => reservation.deskId === deskId)).toMatchObject({ user: null, name: "Gość" });
  });

  it("does not let a second person take a booked desk", async () => {
    const result = await desks.reserveDesk(label, { userId: other.id }, date, { awayUserIds: new Set([owner.id]) });
    expect(result).toEqual({ ok: false, error: "taken" });
  });

  it("keeps a moved desk inside the grid", async () => {
    const office = await layout.getLayout();
    const moved = await layout.updateDesk(deskId, { x: 400, y: 400, rotation: 90 });
    expect(moved).toMatchObject({ x: office.width - 4, y: office.height - 6, width: 6, height: 4, rotation: 90 });
    await layout.updateDesk(deskId, { x: 0, y: 0, rotation: 0 });
  });

  it("refuses a date before today in Warsaw", async () => {
    const result = await desks.reserveDesk(label, { userId: owner.id }, addDays(localToday(), -1));
    expect(result).toEqual({ ok: false, error: "past_date" });
  });
});
