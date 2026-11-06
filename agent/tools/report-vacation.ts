import { z } from "zod";
import { overlappingAbsences, parseDateRange, putAbsence } from "../../lib/facts.ts";
import { createNode } from "../../lib/memory/nodes.ts";
import { flagMessage } from "../../lib/memory/pending.ts";
import { weekdayName } from "../../lib/time.ts";
import { embedQuery } from "../../lib/voyage.ts";
import { flaggable } from "../../lib/../lib/agent/context.ts";
import { absenceNote } from "../lib/vacation.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

const withWeekday = (date: string) => `${date} (${weekdayName(date)})`;

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Flag a planned absence from the office for the background memory to record: time off (vacation, day off, sick leave) or work away from the office (business trip, client visit, remote work from elsewhere). The memory saves it and decides on its own whether to propose sharing with all clients. Call whenever the user mentions being absent — do NOT ask the user about client visibility. When someone corrects an absence that is already recorded, call it again with the corrected dates and details and correction: true: it replaces the old record. When something is already recorded in that period, it saves nothing and shows it to you so you can tell whether it is the same absence. Never use it to record that an absence was called off — use cancel-vacation for that.",
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
        "What it is, in the team's internal language from [Language], with names spelled exactly as the person wrote them, e.g. 'wyjazd do klienta Scape w Sztokholmie', 'L4', 'urlop w Grecji'.",
      ),
    correction: z
      .boolean()
      .optional()
      .describe("true when the person is correcting an absence already recorded (its dates or what it is), not just mentioning it again"),
  }),
  async execute({ start_date, end_date, working, details, correction }, ctx) {
    if (correction !== true) {
      const recorded = await overlappingAbsences(ctx.userId, start_date, end_date);
      if (recorded.length > 0) {
        const lines = recorded.flatMap((fact) => {
          const range = parseDateRange(fact.value);
          if (!range) return [];
          const description = fact.value.split(" — ").slice(1).join(" — ");
          const readable = fact.access.some((level) => ctx.readableLevels.includes(level));
          return [`- ${withWeekday(range.from)}..${withWeekday(range.to)}${readable && description ? `: ${description}` : ""}`];
        });
        return `Nothing saved yet. Already recorded for ${withWeekday(start_date)}..${withWeekday(end_date)}:\n${lines.join("\n")}\nIf this is the same absence (weekends and holidays in between do not matter), tell them you already have it. If it changes the dates or what it is, call report-vacation again with correction: true.`;
      }
    }
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
});
