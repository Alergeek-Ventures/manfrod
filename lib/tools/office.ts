import { z } from "zod";
import { getUser } from "../accounts.ts";
import { isAdminEmail } from "../config.ts";
import { postMap } from "../desk-map.ts";
import {
  cancelReservation,
  createDesk,
  deactivateDesk,
  getDeskByLabel,
  listDesks,
  listReservationsForDate,
  reserveDesk,
  updateDesk,
  type DeskAttrs,
} from "../desks.ts";
import type { Desk } from "../db/schema.ts";
import { listOfficeAccessLog, openDoor } from "../kalafiornia.ts";
import { formatLocal, isValidIsoDate, utcToday } from "../time.ts";
import { spec } from "./context.ts";

const DOOR_ID = "studencka4-4";
const DATE_DOC = "ISO8601 date (YYYY-MM-DD), default today";

function withDate(date: string | undefined, run: (date: string) => Promise<string>): Promise<string> {
  if (date === undefined || date === null) return run(utcToday());
  if (!isValidIsoDate(date)) return Promise.resolve(`Invalid date '${date}'. Use ISO8601 like '2026-07-23'.`);
  return run(date);
}

async function adminRefusal(userId: string): Promise<string | null> {
  const user = await getUser(userId);
  return isAdminEmail(user?.email) ? null : "Tylko admin może zarządzać biurkami.";
}

function splitEquipment(equipment: string | undefined): string[] | undefined {
  if (typeof equipment !== "string") return undefined;
  return equipment
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
}

function deskLine(desk: Desk, reservedBy: string | null): string {
  const equipment = desk.equipment.length === 0 ? "brak sprzętu" : desk.equipment.join(", ");
  const location = desk.locationNote ? ` (${desk.locationNote})` : "";
  const status = desk.permanentOwner ? `na stałe: ${desk.permanentOwner}` : reservedBy ? `zajęte: ${reservedBy}` : "wolne";
  return `- ${desk.label}${location} [${equipment}] — ${status}`;
}

const deskFields = {
  location_note: z.string().optional(),
  equipment: z.string().optional(),
  map_x: z.number().int().optional(),
  map_y: z.number().int().optional(),
  permanent_owner: z.string().optional(),
};

function deskAttrs(args: {
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

export const tools = {
  list_desks: spec({
    description: "List all desks with their equipment and booking status for a date (default today).",
    inputSchema: z.object({ date: z.string().optional().describe(DATE_DOC) }),
    execute: ({ date }) =>
      withDate(date, async (day) => {
        const desks = await listDesks();
        if (desks.length === 0) return "No desks configured yet.";
        const byDesk = new Map((await listReservationsForDate(day)).map((reservation) => [reservation.deskId, reservation]));
        return `Desks (${day}):\n${desks.map((desk) => deskLine(desk, byDesk.get(desk.id)?.user.name ?? null)).join("\n")}`;
      }),
  }),

  reserve_desk: spec({
    description: "Reserve a desk for yourself on a specific date.",
    inputSchema: z.object({
      desk_label: z.string().describe("Desk label, e.g. 'A5'"),
      date: z.string().describe("ISO8601 date (YYYY-MM-DD)"),
      note: z.string().optional().describe("Optional note"),
    }),
    execute: ({ desk_label, date, note }, ctx) =>
      withDate(date, async (day) => {
        const result = await reserveDesk(desk_label, ctx.userId, day, note ?? null);
        if (result.ok) return `Reserved desk ${result.reservation.desk.label} for ${day}.`;
        switch (result.error) {
          case "not_found":
            return `No desk found with label '${desk_label}'.`;
          case "inactive":
            return `Desk '${desk_label}' is no longer available.`;
          case "permanent_owner":
            return `Desk '${desk_label}' is permanently assigned to ${result.owner} and can't be booked.`;
          case "past_date":
            return "Can't reserve a desk in the past. Provide today or a future date.";
          default: {
            const existing = (await listReservationsForDate(day)).find((reservation) => reservation.desk.label === desk_label);
            return existing
              ? `Desk '${desk_label}' is already booked by ${existing.user.name} on ${day}.`
              : `Could not reserve desk '${desk_label}' — invalid request.`;
          }
        }
      }),
  }),

  cancel_desk_reservation: spec({
    description: "Cancel your own desk reservation for a specific date.",
    inputSchema: z.object({
      desk_label: z.string().describe("Desk label, e.g. 'A5'"),
      date: z.string().describe("ISO8601 date (YYYY-MM-DD)"),
    }),
    execute: ({ desk_label, date }, ctx) =>
      withDate(date, async (day) =>
        (await cancelReservation(ctx.userId, desk_label, day))
          ? `Cancelled your reservation for desk '${desk_label}' on ${day}.`
          : `You don't have a reservation for desk '${desk_label}' on that date.`,
      ),
  }),

  list_desk_reservations: spec({
    description: "List who has which desk reserved on a date (default today), as text.",
    inputSchema: z.object({ date: z.string().optional().describe(DATE_DOC) }),
    execute: ({ date }) =>
      withDate(date, async (day) => {
        const reservations = await listReservationsForDate(day);
        const permanent = (await listDesks()).filter((desk) => desk.permanentOwner);
        if (reservations.length === 0 && permanent.length === 0) return `No desk reservations for ${day}.`;
        const lines = [
          ...permanent.map((desk) => `- ${desk.label}: ${desk.permanentOwner} (stałe przypisanie)`),
          ...reservations.map(
            (reservation) => `- ${reservation.desk.label}: ${reservation.user.name}${reservation.note ? ` — ${reservation.note}` : ""}`,
          ),
        ];
        return `Desk reservations (${day}):\n${lines.join("\n")}`;
      }),
  }),

  show_desk_map: spec({
    description:
      "Render the office desk map as an image for a date (default today) and post it to Slack. Posts to this channel by default, or to channel_id if given.",
    inputSchema: z.object({
      date: z.string().optional().describe(DATE_DOC),
      channel_id: z.string().optional().describe("Slack channel ID to post to instead of the current channel, e.g. 'C087QF130R3'"),
    }),
    async execute({ date, channel_id }, ctx) {
      const channel = channel_id ?? ctx.msgCtx.channel;
      if (!channel) return "Can't post the map outside a Slack channel.";
      return withDate(date, async (day) => {
        try {
          const result = await postMap(channel, day);
          return result.ok ? `Posted the desk map for ${day}.` : `Could not render/post the desk map: ${result.error}`;
        } catch (error) {
          return `Could not render/post the desk map: ${(error as Error).message}`;
        }
      });
    },
  }),

  add_desk: spec({
    description: "Admin only. Add a new desk to the office layout (location, equipment, map position).",
    inputSchema: z.object({
      label: z.string().describe("Desk label, e.g. 'A5'"),
      location_note: deskFields.location_note.describe("Free-text location, e.g. 'przy oknie'"),
      equipment: deskFields.equipment.describe("Comma-separated equipment tags, e.g. 'usb-c,mac_mini'"),
      map_x: deskFields.map_x.describe("Pixel x on the base map image"),
      map_y: deskFields.map_y.describe("Pixel y on the base map image"),
      permanent_owner: deskFields.permanent_owner.describe("If set, desk is always occupied by this person and never bookable"),
    }),
    async execute(args, ctx) {
      const refusal = await adminRefusal(ctx.userId);
      if (refusal) return refusal;
      try {
        const desk = await createDesk({ label: args.label, ...deskAttrs(args) });
        return `Added desk '${desk.label}'.`;
      } catch (error) {
        return `Could not add desk: ${(error as Error).message}`;
      }
    },
  }),

  update_desk: spec({
    description: "Admin only. Update an existing desk's location, equipment, map position, or permanent owner.",
    inputSchema: z.object({
      label: z.string().describe("Existing desk label to update"),
      location_note: deskFields.location_note.describe("New free-text location"),
      equipment: deskFields.equipment.describe("New comma-separated equipment tags"),
      map_x: deskFields.map_x.describe("New pixel x on the base map image"),
      map_y: deskFields.map_y.describe("New pixel y on the base map image"),
      permanent_owner: deskFields.permanent_owner.describe("Set to permanently assign the desk, or leave unset to keep it as-is"),
    }),
    async execute(args, ctx) {
      const refusal = await adminRefusal(ctx.userId);
      if (refusal) return refusal;
      const desk = await getDeskByLabel(args.label);
      if (!desk) return `No desk found with label '${args.label}'.`;
      try {
        const updated = await updateDesk(desk, deskAttrs(args));
        return `Updated desk '${updated.label}'.`;
      } catch (error) {
        return `Could not update desk: ${(error as Error).message}`;
      }
    },
  }),

  deactivate_desk: spec({
    description: "Admin only. Remove a desk from the bookable layout (soft delete).",
    inputSchema: z.object({ label: z.string().describe("Desk label to deactivate") }),
    async execute({ label }, ctx) {
      const refusal = await adminRefusal(ctx.userId);
      if (refusal) return refusal;
      const desk = await getDeskByLabel(label);
      if (!desk) return `No desk found with label '${label}'.`;
      await deactivateDesk(desk);
      return `Deactivated desk '${label}'.`;
    },
  }),

  open_office_door: spec({
    description:
      "Opens the office door via the Kalafiornia app, using the caller's own connected Kalafiornia session. If they haven't connected it, returns an error asking them to log in at the web app's integrations page.",
    inputSchema: z.object({}),
    async execute(_args, ctx) {
      const result = await openDoor(ctx.userId, DOOR_ID);
      if (result.ok) return "Door opened.";
      if (result.error === "not_connected") {
        return "ERROR: No Kalafiornia account connected. The user needs to log in at the web app's integrations page (/integrations).";
      }
      if (result.error === "session_invalid") {
        return "ERROR: Kalafiornia session expired. The user needs to log in again at the web app's integrations page (/integrations).";
      }
      return `Kalafiornia door open failed: ${result.error}`;
    },
  }),

  list_office_access_log: spec({
    description:
      "List office door access events (who opened it, when, with app or key). Defaults to today. Use user_name to check a specific person.",
    inputSchema: z.object({
      since: z.string().optional().describe("Only entries from this date onward, ISO8601 (YYYY-MM-DD). Defaults to today."),
      user_name: z.string().optional().describe("Case-insensitive substring filter on the person's name"),
    }),
    async execute({ since, user_name }) {
      if (since !== undefined && since !== null && !isValidIsoDate(since)) {
        return "Nieprawidłowa data w 'since', oczekiwano YYYY-MM-DD.";
      }
      const entries = await listOfficeAccessLog({ since: since ?? utcToday(), userName: user_name || undefined });
      if (!entries.ok) return `Nie udało się pobrać logu wejść: ${entries.error}`;
      if (entries.value.length === 0) return "Brak wejść w tym okresie.";
      return entries.value.map((entry) => `[${formatLocal(entry.time)}] ${entry.user_name} (${entry.opened_by})`).join("\n");
    },
  }),
};
