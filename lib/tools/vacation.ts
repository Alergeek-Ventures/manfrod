import { z } from "zod";
import { getUser } from "../accounts.ts";
import { deleteAbsences, putAbsence } from "../facts.ts";
import { createNode } from "../memory/nodes.ts";
import { flagMessage } from "../memory/pending.ts";
import { embedQuery } from "../voyage.ts";
import { flaggable, spec } from "./context.ts";

async function userName(userId: string): Promise<string> {
  const user = await getUser(userId);
  return user?.name && user.name !== "" ? user.name : "User";
}

async function absenceNote(userId: string, startDate: string, endDate: string, working: boolean, details?: string) {
  const dates = startDate === endDate ? startDate : `${startDate}..${endDate}`;
  const name = await userName(userId);
  const detail = details && details.trim() !== "" ? details.trim() : null;
  if (working) return detail ? `${name} pracuje poza biurem ${dates}: ${detail}` : `${name} pracuje poza biurem ${dates}`;
  return detail ? `${name} nie będzie w biurze ${dates}: ${detail}` : `${name} bierze urlop ${dates}`;
}

export const tools = {
  report_vacation: spec({
    keepSecretPlaceholders: true,
    description:
      "Flag a planned absence from the office for the background memory to record: time off (vacation, day off, sick leave) or work away from the office (business trip, client visit, remote work from elsewhere). The memory saves it and decides on its own whether to propose sharing with all clients. Call whenever the user mentions being absent — do NOT ask the user about client visibility. When someone corrects an absence that is already recorded, call it again with the corrected dates and details: it replaces the old record. Never use it to record that an absence was called off — use cancel_vacation for that.",
    inputSchema: z.object({
      start_date: z.string().describe("Start date ISO8601 (YYYY-MM-DD)"),
      end_date: z.string().describe("End date ISO8601 (YYYY-MM-DD)"),
      working: z
        .boolean()
        .optional()
        .describe(
          "true when the person keeps working, just not from the office (business trip, client visit, conference, remote work from elsewhere). Omit or false for time off.",
        ),
      details: z
        .string()
        .optional()
        .describe(
          "What it is, in Polish, with names spelled exactly as the person wrote them, e.g. 'wyjazd do klienta Scape w Sztokholmie', 'L4', 'urlop w Grecji'.",
        ),
    }),
    async execute({ start_date, end_date, working, details }, ctx) {
      const isWorking = working === true;
      const note = await absenceNote(ctx.userId, start_date, end_date, isWorking, details);
      const message = flaggable(ctx.msgCtx);
      if (message) {
        await flagMessage(message.channel, message.ts, "create_absence", {
          start_date,
          end_date,
          content: note,
          working: isWorking,
        });
        return `Zanotowane (${start_date}..${end_date}). Pamięć w tle zapisze nieobecność i w razie potrzeby zapyta o udostępnienie klientom.`;
      }
      try {
        const { fact } = await putAbsence(ctx.userId, start_date, end_date, note, ["internal", "external/all"]);
        await createNode(ctx.userId, fact.access, { content: note, embedding: await embedQuery(note) });
        return `Zapisałem nieobecność: ${fact.value}`;
      } catch (error) {
        return `Błąd zapisu: ${(error as Error).message}`;
      }
    },
  }),

  cancel_vacation: spec({
    description:
      "Delete the user's own recorded absence when they call it off entirely (they will be in the office after all, the trip is cancelled). Removes every absence of theirs overlapping the given dates. When only the dates or details change, use report_vacation instead.",
    inputSchema: z.object({
      start_date: z.string().describe("First day of the cancelled absence, ISO8601 (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("Last day of the cancelled absence, ISO8601 (YYYY-MM-DD). Omit for a single day."),
    }),
    async execute({ start_date, end_date }, ctx) {
      const endDate = end_date ?? start_date;
      const deleted = await deleteAbsences(ctx.userId, start_date, endDate);
      if (deleted.length === 0) return `Brak zapisanej nieobecności w ${start_date}..${endDate}, nic nie usunięto.`;
      const values = deleted.map((fact) => fact.value).join("; ");
      const note = `${await userName(ctx.userId)} odwołuje nieobecność, jest już nieaktualna: ${values}`;
      const message = flaggable(ctx.msgCtx);
      if (message) {
        await flagMessage(message.channel, message.ts, "create_memory", { content: note });
      } else {
        const access = [...new Set(deleted.flatMap((fact) => fact.access))];
        try {
          await createNode(ctx.userId, access, { content: note, embedding: await embedQuery(note) });
        } catch {}
      }
      return `Usunięto nieobecność: ${values}`;
    },
  }),
};
