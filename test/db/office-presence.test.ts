import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { db, tables } = await import("../../lib/db/index.ts");
const { findOrCreateBySlackId } = await import("../../lib/accounts.ts");
const { cancelVisit, clearPresence, defaultLayoutId, listVisits, recordVisit, setPresence } =
  await import("../../lib/office/presence-store.ts");
const { loadAbsences, loadExplicit, loadMembers, loadReservationDates } = await import("../../lib/office/presence-sources.ts");

const person = () => findOrCreateBySlackId(`U${randomUUID().slice(0, 10)}`, `D${randomUUID().slice(0, 10)}`);

describe.skipIf(!enabled)("office presence store", () => {
  it("upserts and clears one statement per person and day", async () => {
    const user = await person();
    await setPresence(user.id, "2031-03-06", "remote", "chat", "u klienta");
    const updated = await setPresence(user.id, "2031-03-06", "office", "button");
    expect(updated).toMatchObject({ status: "office", source: "button", note: null });
    expect(await loadExplicit([user.id], "2031-03-06")).toHaveLength(1);
    expect(await clearPresence(user.id, "2031-03-06")).toBe(true);
    expect(await clearPresence(user.id, "2031-03-06")).toBe(false);
    expect(await loadExplicit([user.id], "2031-03-06")).toEqual([]);
  });

  it("records, lists and cancels visits on the default layout", async () => {
    const user = await person();
    const layoutId = await defaultLayoutId();
    expect(layoutId).not.toBeNull();
    expect(await recordVisit({ startsOn: "2031-03-07", endsOn: "2031-03-06", userIds: [], guests: 1, note: "x", createdBy: null })).toEqual(
      {
        ok: false,
        error: "invalid_dates",
      },
    );
    expect(await recordVisit({ startsOn: "2031-03-06", endsOn: "2031-03-06", userIds: [], guests: 0, note: "x", createdBy: null })).toEqual(
      {
        ok: false,
        error: "nobody",
      },
    );
    const recorded = await recordVisit({
      startsOn: "2031-03-05",
      endsOn: "2031-03-07",
      userIds: [user.id, user.id],
      guests: 4,
      note: "zespół z Wrocławia",
      createdBy: user.id,
    });
    if (!recorded.ok) throw new Error(recorded.error);
    expect(recorded.visit).toMatchObject({ layoutId, userIds: [user.id], guests: 4 });
    expect((await listVisits("2031-03-06", "2031-03-06")).map((visit) => visit.id)).toContain(recorded.visit.id);
    expect((await listVisits("2031-03-08", "2031-03-09")).map((visit) => visit.id)).not.toContain(recorded.visit.id);
    expect((await cancelVisit(recorded.visit.id))?.cancelledAt).toBeInstanceOf(Date);
    expect(await cancelVisit(recorded.visit.id)).toBeNull();
    expect((await listVisits("2031-03-06", "2031-03-06")).map((visit) => visit.id)).not.toContain(recorded.visit.id);
  });

  it("loads members, absences and manual reservations in batches", async () => {
    const [member, other] = await Promise.all([person(), person()]);
    const layoutId = (await defaultLayoutId())!;
    await db.insert(tables.officeMembers).values({ userId: member.id, layoutId });
    expect((await loadMembers(layoutId)).map((row) => row.userId)).toContain(member.id);

    await db.insert(tables.facts).values([
      { key: `absence:${member.id}:2031-03-05`, value: "2031-03-05..2031-03-07 — urlop", setByUserId: member.id },
      { key: `absence:${other.id}:2031-04-01`, value: "2031-04-01..2031-04-02 — urlop", setByUserId: other.id },
    ]);
    const absences = await loadAbsences([member.id, other.id], "2031-03-06");
    expect(absences.get(member.id)).toEqual(["2031-03-05..2031-03-07 — urlop"]);
    expect(absences.has(other.id)).toBe(false);

    const [desk] = await db
      .insert(tables.desks)
      .values({ label: `T-${randomUUID().slice(0, 8)}`, layoutId })
      .returning();
    await db.insert(tables.deskReservations).values([
      { deskId: desk.id, userId: member.id, date: "2031-02-27" },
      { deskId: desk.id, userId: member.id, date: "2031-03-06", source: "plan" },
      { deskId: desk.id, guestName: "Gość", date: "2031-03-05" },
    ]);
    const reservations = await loadReservationDates(layoutId, [member.id], "2031-01-01", "2031-03-06");
    expect(reservations.get(member.id)).toEqual(["2031-02-27"]);
  });
});
