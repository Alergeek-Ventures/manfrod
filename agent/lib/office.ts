import { z } from "zod";
import { getUser, getUserByEmail, getUserBySlackId, isAdmin, isUuid, listUsers } from "../../lib/accounts.ts";
import { config } from "../../lib/config.ts";
import type { User } from "../../lib/db/schema.ts";
import { splitTags } from "../../lib/office/model.ts";
import type { MapDesk } from "../../lib/office/state.ts";
import { isValidIsoDate, utcToday } from "../../lib/time.ts";

export const DOOR_ID = "studencka4-4";
export const DATE_DOC = "ISO8601 date (YYYY-MM-DD), default today";
export const editorUrl = () => `${config.appUrl}/admin/office`;

export function withDate(date: string | undefined, run: (date: string) => Promise<string>): Promise<string> {
  if (date === undefined || date === null) return run(utcToday());
  if (!isValidIsoDate(date)) return Promise.resolve(`Invalid date '${date}'. Use ISO8601 like '2026-07-23'.`);
  return run(date);
}

export async function adminRefusal(userId: string): Promise<string | null> {
  const user = await getUser(userId);
  return isAdmin(user) ? null : "Tylko admin może zarządzać biurkami.";
}

export function splitEquipment(equipment: string | undefined): string[] | undefined {
  return typeof equipment === "string" ? splitTags(equipment) : undefined;
}

export const personName = (user: Pick<User, "name" | "email" | "slackId">) => user.name ?? user.email ?? user.slackId;

export type PersonMatch = { ok: true; user: User } | { ok: false; message: string };

export async function resolvePerson(value: string): Promise<PersonMatch> {
  const raw = value.trim().replace(/^<@([A-Z0-9]+)(\|[^>]*)?>$/, "$1");
  const direct = /^[UW][A-Z0-9]{5,}$/.test(raw)
    ? await getUserBySlackId(raw)
    : raw.includes("@")
      ? await getUserByEmail(raw.toLowerCase())
      : isUuid(raw)
        ? await getUser(raw)
        : null;
  if (direct) return { ok: true, user: direct };
  const wanted = raw.toLowerCase();
  const users = await listUsers();
  const exact = users.filter((user) => (user.name ?? "").toLowerCase() === wanted);
  const matches = exact.length > 0 ? exact : users.filter((user) => (user.name ?? "").toLowerCase().split(/\s+/)[0] === wanted);
  if (matches.length === 1) return { ok: true, user: matches[0] };
  if (matches.length > 1)
    return { ok: false, message: `'${value}' matches several people (${matches.map(personName).join(", ")}); pass their Slack ID.` };
  return { ok: false, message: `I don't know anyone called '${value}'; pass their Slack ID (see list-team-members).` };
}

export function deskStatusText(desk: MapDesk): string {
  if (desk.status === "taken") {
    const ownerAway = desk.ownerName && desk.reservation?.userId !== desk.ownerUserId;
    return `zajęte: ${desk.fullName}${ownerAway ? ` (właściciel ${desk.ownerName} poza biurem)` : ""}`;
  }
  if (desk.status === "owner_present") return `na stałe: ${desk.ownerName}`;
  if (desk.status === "owner_away") return `wolne (właściciel ${desk.ownerName} poza biurem)`;
  return "wolne";
}

export function deskLine(desk: MapDesk): string {
  const equipment = desk.equipment.length === 0 ? "brak sprzętu" : desk.equipment.join(", ");
  const unplaced = desk.x === null || desk.y === null ? " (nie ma go jeszcze na mapie)" : "";
  return `- ${desk.label}${unplaced} [${equipment}] — ${deskStatusText(desk)}`;
}

export const deskFields = {
  location_note: z.string().optional(),
  equipment: z.string().optional(),
  owner: z.string().optional(),
};
