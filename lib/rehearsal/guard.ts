import { runWithSecrets, type SecretUse } from "../secrets.ts";

export const REHEARSAL_KIND = "rehearsal";

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "find-meeting-time",
  "find-slack-canvas-sections",
  "get-calendar-events",
  "get-fact",
  "get-note",
  "get-person-soul",
  "get-soul",
  "github-board",
  "github-code",
  "github-commits",
  "github-pulls",
  "github-repositories",
  "linear-get-issue",
  "linear-list-cycles",
  "linear-list-issues",
  "linear-list-projects",
  "linear-search-issues",
  "list-desk-reservations",
  "list-desks",
  "list-facts",
  "list-office-access-log",
  "list-office-presence",
  "list-projects",
  "list-recent-notes",
  "list-recurring-reminders",
  "list-reminders",
  "list-slack-canvases",
  "list-slack-channels",
  "list-tasks",
  "list-team-members",
  "list-upcoming-holidays",
  "read-slack-canvas",
  "read-slack-channel",
  "read-slack-thread",
  "search-notes",
  "web-search",
]);

const ARGS_CHARS = 500;

export const isRehearsal = (kind: string | null | undefined) => kind === REHEARSAL_KIND;

export const blockedInRehearsal = (kind: string | null | undefined, toolName: string) =>
  isRehearsal(kind) && !READ_ONLY_TOOLS.has(toolName);

export function simulated(toolName: string, input: unknown): string {
  const args = JSON.stringify(input) ?? "";
  return `[rehearsal] not executed: ${toolName} ${args.length > ARGS_CHARS ? `${args.slice(0, ARGS_CHARS)}…` : args}`;
}

export async function runGuarded<I, R>(kind: string, use: SecretUse, input: I, execute: (resolved: I) => Promise<R>): Promise<R | string> {
  if (blockedInRehearsal(kind, use.toolName)) return simulated(use.toolName, input);
  return runWithSecrets(use, input, execute);
}
