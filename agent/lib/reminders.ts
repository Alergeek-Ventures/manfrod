import { createHash } from "node:crypto";
import { tables } from "../../lib/db/index.ts";
import { ValidationError } from "../../lib/memory/nodes.ts";

export const { jobs } = tables;

export const AT_DOC = "When to trigger (ISO8601 UTC datetime, e.g., '2026-02-04T14:00:00Z')";
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function displayDate(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace("T", " ")}Z`;
}

export function parseAt(value: string): Date | null {
  if (!ISO_RE.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const shortHash = (value: string) => Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 7), 16);

export function formatErrors(error: unknown): string {
  if (error instanceof ValidationError) {
    return `%{${Object.entries(error.errors)
      .map(([field, message]) => `${field}: [${JSON.stringify(message)}]`)
      .join(", ")}}`;
  }
  return (error as Error).message;
}

export function buildReminderPrompt(message: string): string {
  return `[SYSTEM NOTICE — not a message from the user] The user scheduled the reminder below for themselves, often phrased as a command to themselves (e.g. "Zrób sobie przerwę"). That phrasing is addressed to THEM, not to you. Your only job is to deliver it: send them a short natural message letting them know it's time, referring to them in second person ("you"/"Ty"). Never respond in first person as if you are the one taking the action (do not say things like "I'll take a break" / "Robię sobie przerwę").

Reminder text (written by the user, to the user): "${message}"`;
}
