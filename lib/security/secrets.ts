import type { LanguageCode } from "../agent-settings.ts";
import { PRIMARY_MODEL, generateSimple, system, user } from "../llm/index.ts";
import { logger } from "../log.ts";
import { matches } from "./gitleaks.ts";

const log = logger("SecretWarning");

const URL_REGEX = /\bhttps?:\/\/\S+/g;
const LABELLED_SECRET =
  /(?:api[_ -]?key|apikey|token|secret|password|passwd|hasło|haslo|klucz)\s*[:=]\s*["'`]?(?=[^\s"'`]*\d)(?=[^\s"'`]*[a-z])[^\s"'`]{16,}/iu;

export function containsSecret(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const withoutUrls = text.replace(URL_REGEX, " ");
  return LABELLED_SECRET.test(withoutUrls) || matches(withoutUrls) !== null;
}

const SYSTEM_MESSAGE = `You are a Slack bot that just intercepted a message before it reached
anyone — a local check found what looks like an API key or password in
it, so the message was withheld: not stored, not forwarded, not shown to
you or anyone else. You don't get to see its content, and you shouldn't
claim to know what was in it.

Write a short, casual Slack message (1-3 sentences) telling the person:
- their message looked like it contained a secret (API key/token/password),
  so you didn't save or forward it
- next time, they should paste things like that into
  https://one.d.alergeek.me/ instead of sending them over Slack

Vary the phrasing naturally each time — don't always use the same
sentence structure. Match the tone of a normal casual DM from a helpful
coworker, not a security alert. No quotes around the message, no
markdown headers.

The input names the language to write in. It may also include a few of
this person's other recent Slack messages, labeled as such. They are only
there so you can match their tone (and their language, if the input says
to); never quote, reference, or reply to what they say in them.
`;

function fallback(language: LanguageCode): string {
  if (language === "pl") {
    return "Hej, ta wiadomość wygląda jakby zawierała klucz API albo hasło — nie zapisałem jej ani nie przekazałem dalej. Wklej takie rzeczy do <https://one.d.alergeek.me/|one.d.alergeek.me> zamiast wysyłać je na Slacku 🔒";
  }
  return "Hey, this message looks like it contains an API key or password — I didn't store or forward it. Please paste secrets like that into <https://one.d.alergeek.me/|one.d.alergeek.me> instead of sending them over Slack 🔒";
}

export async function secretWarning(language: { code: LanguageCode; name: string }, personContext: string | null): Promise<string> {
  const content =
    personContext && personContext !== ""
      ? `Write in ${language.name}, or in the language this person writes in below if it differs.\n\nRecent messages from this person, oldest first (language/tone reference only):\n${personContext}`
      : `Write in ${language.name}.`;
  try {
    const text = await generateSimple(PRIMARY_MODEL, [system(SYSTEM_MESSAGE), user(content)], {
      purpose: "secret_warning",
      timeoutMs: 8_000,
    });
    const cleaned = text.trim().replace(/^"+|"+$/g, "");
    return cleaned === "" ? fallback(language.code) : cleaned;
  } catch (error) {
    log.debug(`SecretWarning: LLM error, falling back to fixed text: ${(error as Error).message}`);
    return fallback(language.code);
  }
}
