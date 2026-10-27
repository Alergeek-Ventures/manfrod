import { z } from "zod";
import { putAbsence } from "../../lib/facts.ts";
import { createNode } from "../../lib/memory/nodes.ts";
import { flagMessage } from "../../lib/memory/pending.ts";
import { embedQuery } from "../../lib/voyage.ts";
import { flaggable } from "../../lib/../lib/agent/context.ts";
import { absenceNote } from "../lib/vacation.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Flag a planned absence from the office for the background memory to record: time off (vacation, day off, sick leave) or work away from the office (business trip, client visit, remote work from elsewhere). The memory saves it and decides on its own whether to propose sharing with all clients. Call whenever the user mentions being absent — do NOT ask the user about client visibility. When someone corrects an absence that is already recorded, call it again with the corrected dates and details: it replaces the old record. Never use it to record that an absence was called off — use cancel-vacation for that.",
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
});
