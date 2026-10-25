import { z } from "zod";
import { listOfficeAccessLog } from "../../lib/kalafiornia.ts";
import { formatLocal, isValidIsoDate, utcToday } from "../../lib/time.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
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
});
