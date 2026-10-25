import { PRIMARY_MODEL, generateSimple, system, user } from "../llm/index.ts";
import { logger } from "../log.ts";

const log = logger("Titles");

const THREAD_TITLE_SYSTEM = `You write a short Slack thread title (3-8 words, under 60 characters) for
a message a bot is about to send someone. Base it only on the message
below — match its own language and tone, and make it feel personal and
specific to that message, not generic. E.g. for a message about an
upcoming holiday on a date, something like "Święto ... w dniu ...". No
quotes, no emoji, no trailing punctuation. Reply with only the title.`;

const TITLE_MAX_LENGTH = 60;

export function cleanTitle(raw: string): string | null {
  const line =
    raw
      .split("\n")
      .map((candidate) => candidate.trim().replace(/^"+|"+$/g, "").replace(/^\.+|\.+$/g, "").trim())
      .filter((candidate) => candidate !== "")
      .at(-1) ?? "";
  return line === "" || line.length > TITLE_MAX_LENGTH ? null : line;
}

function fallbackTitle(content: string): string {
  return (content.trim().split("\n", 1)[0] ?? "").slice(0, 99);
}

export async function threadTitle(content: string): Promise<string> {
  try {
    const title = await generateSimple(PRIMARY_MODEL, [system(THREAD_TITLE_SYSTEM), user(content)], {
      purpose: "thread_title",
      timeoutMs: 8_000,
    });
    return cleanTitle(title) ?? fallbackTitle(content);
  } catch (error) {
    log.debug(`ThreadTitle: LLM error, falling back to truncation: ${(error as Error).message}`);
    return fallbackTitle(content);
  }
}

const PLAN_TITLE_SYSTEM = `You name the task an assistant is currently working on, for a progress
indicator the user watches while they wait.

Rules:
- Polish, first person singular, present tense, as the assistant: "Sprawdzam
  rezerwacje biurek", "Szukam notatek ze spotkania", "Przygotowuję
  podsumowanie kanału".
- 2-5 words, under 60 characters.
- Describe what is being done for the user, not which tools are used.
- No quotes, no emoji, no trailing punctuation, no ellipsis.
- Reply with only the title.
`;

const PLAN_REQUEST_LIMIT = 1_000;

export async function planTitle(request: string | null | undefined): Promise<string | null> {
  if (typeof request !== "string") return null;
  const trimmed = request.length > PLAN_REQUEST_LIMIT ? request.slice(-PLAN_REQUEST_LIMIT) : request;
  try {
    const title = await generateSimple(PRIMARY_MODEL, [system(PLAN_TITLE_SYSTEM), user(trimmed)], {
      purpose: "plan_title",
      timeoutMs: 6_000,
    });
    return cleanTitle(title);
  } catch (error) {
    log.debug(`PlanTitle: LLM error, keeping provisional title: ${(error as Error).message}`);
    return null;
  }
}
