import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { db, tables } = await import("../../lib/db/index.ts");
const { findOrCreateBySlackId } = await import("../../lib/accounts.ts");
const { cancelVisit, clearPresence, defaultLayoutId, listVisits, recordVisit, setPresence, updateVisit } =
  await import("../../lib/office/presence-store.ts");
const { loadStatedOffice } = await import("../../lib/office/presence-sources.ts");
const { eq, inArray } = await import("drizzle-orm");
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

  it("keeps named guests, merges them into a duplicate and lets the visit be fixed", async () => {
    const [author, odul] = await Promise.all([person(), person()]);
    const visitIds: string[] = [];
    try {
      expect(
        await recordVisit({
          startsOn: "2031-05-06",
          endsOn: "2031-05-06",
          userIds: [],
          guests: 1,
          guestNames: ["A", "B"],
          note: "x",
          createdBy: null,
        }),
      ).toEqual({ ok: false, error: "invalid_guests" });
      const first = await recordVisit({
        startsOn: "2031-05-06",
        endsOn: "2031-05-07",
        userIds: [],
        guests: 2,
        guestNames: [" Odul ", "odul"],
        note: "Odul i Mariusz",
        createdBy: author.id,
      });
      if (!first.ok) throw new Error(first.error);
      visitIds.push(first.visit.id);
      expect(first.visit).toMatchObject({ guests: 2, guestNames: ["Odul"] });
      const merged = await recordVisit({
        startsOn: "2031-05-07",
        endsOn: "2031-05-08",
        userIds: [],
        guests: 2,
        guestNames: ["Mariusz", "Zenek"],
        note: "x",
        createdBy: author.id,
      });
      if (!merged.ok) throw new Error(merged.error);
      expect(merged).toMatchObject({ duplicate: true, visit: { id: first.visit.id, endsOn: "2031-05-08", guests: 3 } });
      expect(merged.visit.guestNames).toEqual(["Odul", "Mariusz", "Zenek"]);

      const fixed = await updateVisit(first.visit.id, { userIds: [odul.id], guestNames: [], guests: 0, startsOn: "2031-05-05" });
      expect(fixed).toMatchObject({
        ok: true,
        previous: { startsOn: "2031-05-06", guests: 3 },
        visit: { startsOn: "2031-05-05", endsOn: "2031-05-08", userIds: [odul.id], guests: 0, guestNames: [], note: "Odul i Mariusz" },
      });
      expect(await updateVisit(first.visit.id, { userIds: [] })).toEqual({ ok: false, error: "nobody" });
      expect(await updateVisit(first.visit.id, { endsOn: "2031-05-01" })).toEqual({ ok: false, error: "invalid_dates" });
      await cancelVisit(first.visit.id);
      expect(await updateVisit(first.visit.id, { guests: 1 })).toEqual({ ok: false, error: "not_found" });
    } finally {
      if (visitIds.length > 0) await db.delete(tables.officeVisits).where(inArray(tables.officeVisits.id, visitIds));
      await db.delete(tables.users).where(inArray(tables.users.id, [author.id, odul.id]));
    }
  });

  it("loads everyone who said they will be in the office", async () => {
    const user = await person();
    try {
      await setPresence(user.id, "2031-05-12", "office", "chat");
      await setPresence(user.id, "2031-05-13", "remote", "chat");
      expect((await loadStatedOffice("2031-05-12")).map((row) => row.userId)).toContain(user.id);
      expect((await loadStatedOffice("2031-05-13")).map((row) => row.userId)).not.toContain(user.id);
    } finally {
      await db.delete(tables.officePresence).where(eq(tables.officePresence.userId, user.id));
      await db.delete(tables.users).where(eq(tables.users.id, user.id));
    }
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
