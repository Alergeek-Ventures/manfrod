import { and, asc, eq, gte } from "drizzle-orm";
import { db, tables } from "./db/index.ts";
import type { Desk, DeskReservation, User } from "./db/schema.ts";
import { utcToday } from "./time.ts";

const { desks, deskReservations, users } = tables;

export type ReservationWithDesk = DeskReservation & { desk: Desk; user: User };

export async function listDesks(opts: { includeInactive?: boolean } = {}): Promise<Desk[]> {
  return db
    .select()
    .from(desks)
    .where(opts.includeInactive ? undefined : eq(desks.active, true))
    .orderBy(asc(desks.label));
}

export async function getDeskByLabel(label: string): Promise<Desk | null> {
  const [desk] = await db.select().from(desks).where(eq(desks.label, label.trim())).limit(1);
  return desk ?? null;
}

export type DeskAttrs = Partial<Pick<Desk, "label" | "locationNote" | "equipment" | "mapX" | "mapY" | "permanentOwner" | "active">>;

export async function createDesk(attrs: DeskAttrs): Promise<Desk> {
  if (!attrs.label || attrs.label.trim() === "") throw new Error("label: can't be blank");
  const [desk] = await db
    .insert(desks)
    .values({ ...attrs, label: attrs.label.trim() })
    .returning();
  return desk;
}

export async function updateDesk(desk: Desk, attrs: DeskAttrs): Promise<Desk> {
  const values = attrs.label !== undefined ? { ...attrs, label: attrs.label.trim() } : attrs;
  const [updated] = await db.update(desks).set(values).where(eq(desks.id, desk.id)).returning();
  return updated;
}

export function deactivateDesk(desk: Desk): Promise<Desk> {
  return updateDesk(desk, { active: false });
}

export type ReserveError =
  | { error: "not_found" }
  | { error: "inactive" }
  | { error: "permanent_owner"; owner: string }
  | { error: "past_date" }
  | { error: "taken" };

export async function reserveDesk(
  label: string,
  userId: string,
  date: string,
  note: string | null = null,
): Promise<{ ok: true; reservation: ReservationWithDesk } | ({ ok: false } & ReserveError)> {
  const desk = await getDeskByLabel(label);
  if (!desk) return { ok: false, error: "not_found" };
  if (!desk.active) return { ok: false, error: "inactive" };
  if (desk.permanentOwner !== null) return { ok: false, error: "permanent_owner", owner: desk.permanentOwner };
  if (date < utcToday()) return { ok: false, error: "past_date" };

  try {
    const reservation = await db.transaction(async (tx) => {
      await tx
        .delete(deskReservations)
        .where(and(eq(deskReservations.userId, userId), eq(deskReservations.date, date)));
      const [created] = await tx.insert(deskReservations).values({ deskId: desk.id, userId, date, note }).returning();
      return created;
    });
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    return { ok: true, reservation: { ...reservation, desk, user } };
  } catch {
    return { ok: false, error: "taken" };
  }
}

export async function cancelReservation(userId: string, label: string, date: string): Promise<boolean> {
  const desk = await getDeskByLabel(label);
  if (!desk) return false;
  const result = await db
    .delete(deskReservations)
    .where(
      and(eq(deskReservations.deskId, desk.id), eq(deskReservations.date, date), eq(deskReservations.userId, userId)),
    );
  return (result.rowCount ?? 0) > 0;
}

export async function listReservationsForDate(date: string): Promise<ReservationWithDesk[]> {
  const rows = await db
    .select({ reservation: deskReservations, desk: desks, user: users })
    .from(deskReservations)
    .innerJoin(desks, eq(desks.id, deskReservations.deskId))
    .innerJoin(users, eq(users.id, deskReservations.userId))
    .where(eq(deskReservations.date, date))
    .orderBy(asc(deskReservations.insertedAt));
  return rows.map((row) => ({ ...row.reservation, desk: row.desk, user: row.user }));
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
