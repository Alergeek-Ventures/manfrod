import { tools as calendar } from "./calendar.ts";
import type { ToolSpec } from "./context.ts";
import { tools as memoryExtras } from "./memory-extras.ts";
import { tools as notes } from "./notes.ts";
import { tools as office } from "./office.ts";
import { tools as reminders } from "./reminders.ts";
import { tools as slack } from "./slack.ts";
import { tools as vacation } from "./vacation.ts";

export const registry: Record<string, ToolSpec<any>> = {
  ...calendar,
  ...office,
  ...memoryExtras,
  ...notes,
  ...reminders,
  ...slack,
  ...vacation,
};

export function capabilitiesText(): string {
  return Object.entries(registry)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, tool]) => `- ${name}: ${tool.description}`)
    .join("\n");
}
