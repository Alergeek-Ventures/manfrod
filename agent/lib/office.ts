import { z } from "zod";
import { getUser, isAdmin } from "../../lib/accounts.ts";
import { config } from "../../lib/config.ts";
import { splitTags } from "../../lib/office/model.ts";
import type { MapDesk } from "../../lib/office/state.ts";
import { isValidIsoDate, localToday } from "../../lib/time.ts";

export const DOOR_ID = "studencka4-4";
export const DATE_DOC = "ISO8601 date (YYYY-MM-DD), default today";
export const editorUrl = () => `${config.appUrl}/admin/office`;

export function withDate(date: string | undefined, run: (date: string) => Promise<string>): Promise<string> {
  if (date === undefined || date === null) return run(localToday());
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
