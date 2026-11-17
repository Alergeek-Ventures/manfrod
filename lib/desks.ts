import { and, asc, eq, gte, sql } from "drizzle-orm";
import { db, tables } from "./db/index.ts";
import type { Desk, DeskReservation, User } from "./db/schema.ts";
import { recordedAwayUserIds } from "./office/away.ts";
import { updateDesk } from "./office/layout.ts";
import { utcToday } from "./time.ts";

const { desks, deskReservations, users } = tables;

export type ReservationSource = "manual" | "plan";
export type ReservationWithDesk = DeskReservation & { desk: Desk; user: User | null; name: string };
export type DeskPerson = { userId: string } | { guestName: string };

export const reservationName = (reservation: Pick<DeskReservation, "guestName">, user: Pick<User, "name" | "email"> | null) =>
  user?.name ?? user?.email ?? reservation.guestName ?? "?";

export async function listDesks(opts: { includeInactive?: boolean } = {}): Promise<Desk[]> {
  const rows = await db
    .select()
    .from(desks)
    .where(opts.includeInactive ? undefined : eq(desks.active, true))
    .orderBy(asc(desks.label));
  return rows.sort((a, b) => a.label.localeCompare(b.label, "pl", { numeric: true }));
}

export async function getDeskByLabel(label: string): Promise<Desk | null> {
  const [desk] = await db
    .select()
    .from(desks)
    .where(sql`lower(${desks.label}) = lower(${label.trim()})`)
    .limit(1);
  return desk ?? null;
}

export function deactivateDesk(desk: Desk): Promise<Desk> {
  return updateDesk(desk.id, { active: false });
}

export type ReserveError =
  { error: "not_found" } | { error: "inactive" } | { error: "owned"; owner: string } | { error: "past_date" } | { error: "taken" };

export type ReserveOptions = {
  note?: string | null;
  source?: ReservationSource;
  awayUserIds?: ReadonlySet<string>;
};

export async function reserveDesk(
  label: string,
  person: DeskPerson,
  date: string,
  options: ReserveOptions = {},
): Promise<{ ok: true; reservation: ReservationWithDesk } | ({ ok: false } & ReserveError)> {
  const desk = await getDeskByLabel(label);
  if (!desk) return { ok: false, error: "not_found" };
  if (!desk.active) return { ok: false, error: "inactive" };
  if (date < utcToday()) return { ok: false, error: "past_date" };

  const userId = "userId" in person ? person.userId : null;
  if (desk.ownerUserId && desk.ownerUserId !== userId) {
    const away = options.awayUserIds ?? (await recordedAwayUserIds(date));
    if (!away.has(desk.ownerUserId)) {
      const [owner] = await db.select().from(users).where(eq(users.id, desk.ownerUserId)).limit(1);
      return { ok: false, error: "owned", owner: owner?.name ?? owner?.email ?? "?" };
    }
  }

  try {
    const reservation = await db.transaction(async (tx) => {
      if (userId) await tx.delete(deskReservations).where(and(eq(deskReservations.userId, userId), eq(deskReservations.date, date)));
      const [created] = await tx
        .insert(deskReservations)
        .values({
          deskId: desk.id,
          userId,
          guestName: "guestName" in person ? person.guestName.trim() : null,
          date,
          note: options.note ?? null,
          source: options.source ?? "manual",
        })
        .returning();
      return created;
    });
    const [user] = userId ? await db.select().from(users).where(eq(users.id, userId)).limit(1) : [];
    return { ok: true, reservation: { ...reservation, desk, user: user ?? null, name: reservationName(reservation, user ?? null) } };
  } catch {
    return { ok: false, error: "taken" };
  }
}

export async function cancelReservation(userId: string, label: string, date: string): Promise<boolean> {
  const desk = await getDeskByLabel(label);
  if (!desk) return false;
  const result = await db
    .delete(deskReservations)
    .where(and(eq(deskReservations.deskId, desk.id), eq(deskReservations.date, date), eq(deskReservations.userId, userId)));
  return (result.rowCount ?? 0) > 0;
}

export async function listReservationsForDate(date: string): Promise<ReservationWithDesk[]> {
  const rows = await db
    .select({ reservation: deskReservations, desk: desks, user: users })
    .from(deskReservations)
    .innerJoin(desks, eq(desks.id, deskReservations.deskId))
    .leftJoin(users, eq(users.id, deskReservations.userId))
    .where(eq(deskReservations.date, date))
    .orderBy(asc(deskReservations.insertedAt));
  return rows.map((row) => ({ ...row.reservation, desk: row.desk, user: row.user, name: reservationName(row.reservation, row.user) }));
}

export async function listUserReservations(userId: string): Promise<(DeskReservation & { desk: Desk })[]> {
  const rows = await db
    .select({ reservation: deskReservations, desk: desks })
    .from(deskReservations)
    .innerJoin(desks, eq(desks.id, deskReservations.deskId))
    .where(and(eq(deskReservations.userId, userId), gte(deskReservations.date, utcToday())))
    .orderBy(asc(deskReservations.date));
  return rows.map((row) => ({ ...row.reservation, desk: row.desk }));
}
