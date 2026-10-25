import { FAST_MODEL, generateSimple, system, user } from "../llm/index.ts";
import { logger } from "../log.ts";
import { listFullThread, post } from "./api.ts";
import { isKicked, kick } from "./thread-permission.ts";

const log = logger("Slack.Kick");

const CONTEXT_MESSAGES = 8;
const CONTEXT_CHARS = 1_500;

const SYSTEM_MESSAGE = `Jesteś Manfrod, firmowy asystent na Slacku. Ktoś w tym wątku właśnie
poprosił, żebyś przestał się w nim udzielać, i faktycznie już wychodzisz.

Napisz jedną krótką wiadomość pożegnalną:
- W JĘZYKU WĄTKU. Rozpoznaj język z załączonych wiadomości i użyj dokładnie
  tego samego. Jeśli wątek jest po angielsku, pożegnaj się po angielsku;
  jeśli po polsku, po polsku. Przy mieszance wybierz język, w którym
  poproszono Cię o wyjście. Bez kontekstu użyj polskiego.
- lekko smutną, ale bez dramatyzowania i bez proszenia się o powrót
- nawiązującą do tego konkretnego wątku, jeśli z kontekstu widać, o czym był
- z informacją, że wystarczy Cię oznaczyć (@Manfrod), żebyś wrócił
- maksymalnie 2 zdania, jedno emoji
- bez myślników "—" i "–", bez cudzysłowów wokół całości

Odpowiedz samą treścią wiadomości, niczym więcej.
`;

const FALLBACK_FAREWELL =
  "Ok, znikam z tego wątku. 😔 Gdybyście mnie potrzebowali, wystarczy mnie oznaczyć.";

async function threadContext(channel: string, threadTs: string): Promise<string> {
  const messages = await listFullThread(channel, threadTs);
  if (!messages) return "(brak kontekstu wątku)";
  const context = messages
    .slice(-CONTEXT_MESSAGES)
    .map((message) => `${message.user_name ?? message.user ?? "ktoś"}: ${message.text ?? ""}`)
    .join("\n")
    .slice(0, CONTEXT_CHARS);
  return context === "" ? "(brak kontekstu wątku)" : `Ostatnie wiadomości w wątku:\n\n${context}`;
}

export async function farewell(channel: string, threadTs: string): Promise<string> {
  try {
    const text = await generateSimple(
      FAST_MODEL,
      [system(SYSTEM_MESSAGE), user(await threadContext(channel, threadTs))],
      { purpose: "farewell", timeoutMs: 8_000 },
    );
    return text.trim() === "" ? FALLBACK_FAREWELL : text.trim();
  } catch (error) {
    log.debug(`Slack Kick: farewell generation failed, using fallback: ${(error as Error).message}`);
    return FALLBACK_FAREWELL;
  }
}

export type KickResult = "ok" | "already_kicked" | "error";

export async function runKick(
  channel: string | null | undefined,
  threadTs: string | null | undefined,
  attrs: { userId?: string | null; slackUserId?: string | null; source: "shortcut" | "tool" },
): Promise<KickResult> {
  if (!channel || !threadTs) {
    log.warn(`Slack Kick: refusing to kick without a channel and thread (channel=${channel}, thread_ts=${threadTs})`);
    return "error";
  }
  if (await isKicked(channel, threadTs)) return "already_kicked";
  if (!(await kick(channel, threadTs, attrs))) return "error";

  const result = await post("chat.postMessage", {
    channel,
    thread_ts: threadTs,
    text: await farewell(channel, threadTs),
  });
  if (!result.ok) {
    log.warn(`Slack Kick: left ${channel}/${threadTs} but could not post the farewell: ${result.error}`);
  }
  return "ok";
}
