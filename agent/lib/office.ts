import { z } from "zod";
import { getUser, isAdmin } from "../../lib/accounts.ts";
import { type DeskAttrs } from "../../lib/desks.ts";
import type { Desk } from "../../lib/db/schema.ts";
import { isValidIsoDate, utcToday } from "../../lib/time.ts";

export const DOOR_ID = "studencka4-4";
export const DATE_DOC = "ISO8601 date (YYYY-MM-DD), default today";

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
  if (typeof equipment !== "string") return undefined;
  return equipment
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
}

export function deskLine(desk: Desk, reservedBy: string | null): string {
  const equipment = desk.equipment.length === 0 ? "brak sprzętu" : desk.equipment.join(", ");
  const location = desk.locationNote ? ` (${desk.locationNote})` : "";
  const status = desk.permanentOwner ? `na stałe: ${desk.permanentOwner}` : reservedBy ? `zajęte: ${reservedBy}` : "wolne";
  return `- ${desk.label}${location} [${equipment}] — ${status}`;
}

export const deskFields = {
  location_note: z.string().optional(),
  equipment: z.string().optional(),
  map_x: z.number().int().optional(),
  map_y: z.number().int().optional(),
  permanent_owner: z.string().optional(),
};

export function deskAttrs(args: {
  location_note?: string;
  equipment?: string;
  map_x?: number;
  map_y?: number;
  permanent_owner?: string;
}): DeskAttrs {
  const attrs: DeskAttrs = {};
  if (args.location_note !== undefined) attrs.locationNote = args.location_note;
  if (args.map_x !== undefined) attrs.mapX = args.map_x;
  if (args.map_y !== undefined) attrs.mapY = args.map_y;
  if (args.permanent_owner !== undefined) attrs.permanentOwner = args.permanent_owner;
  const equipment = splitEquipment(args.equipment);
  if (equipment) attrs.equipment = equipment;
  return attrs;
}
