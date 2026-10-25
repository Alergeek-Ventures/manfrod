import { z } from "zod";
import { deleteAbsences } from "../../lib/facts.ts";
import { createNode } from "../../lib/memory/nodes.ts";
import { flagMessage } from "../../lib/memory/pending.ts";
import { embedQuery } from "../../lib/voyage.ts";
import { flaggable } from "../../lib/../lib/agent/context.ts";
import { userName } from "../lib/vacation.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Delete the user's own recorded absence when they call it off entirely (they will be in the office after all, the trip is cancelled). Removes every absence of theirs overlapping the given dates. When only the dates or details change, use report-vacation instead.",
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
});
