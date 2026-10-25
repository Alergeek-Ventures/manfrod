import { FAST_MODEL, generateSimple, system, user } from "../llm/index.ts";
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

const POLISH_CHARS = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;
const POLISH_WORDS = new Set("nie jest tutaj proszę cześć siema dzięki masz jak co gdzie kiedy jestem może właśnie".split(" "));

export function languageHint(text: unknown): "pl" | "en" {
  if (typeof text !== "string") return "pl";
  if (POLISH_CHARS.test(text)) return "pl";
  const words = text
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
  return words.some((word) => POLISH_WORDS.has(word)) ? "pl" : "en";
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

The input you get is EITHER a language code (\`pl\`, \`en\`, ...) — write
entirely in that language — OR a few of this person's other recent Slack
messages, labeled as such. In that case they are only there so you can
tell which language and tone this person actually writes in; never
quote, reference, or reply to what they say in them.
`;

function fallback(lang: "pl" | "en"): string {
  if (lang === "pl") {
    return "Hej, ta wiadomość wygląda jakby zawierała klucz API albo hasło — nie zapisałem jej ani nie przekazałem dalej. Wklej takie rzeczy do <https://one.d.alergeek.me/|one.d.alergeek.me> zamiast wysyłać je na Slacku 🔒";
  }
  return "Hey, this message looks like it contains an API key or password — I didn't store or forward it. Please paste secrets like that into <https://one.d.alergeek.me/|one.d.alergeek.me> instead of sending them over Slack 🔒";
}

export async function secretWarning(context: string | null, fallbackLang: "pl" | "en"): Promise<string> {
  const content =
    context && context !== "" ? `Recent messages from this person, oldest first (language/tone reference only):\n${context}` : fallbackLang;
  try {
    const text = await generateSimple(FAST_MODEL, [system(SYSTEM_MESSAGE), user(content)], {
      purpose: "secret_warning",
      timeoutMs: 8_000,
    });
    const cleaned = text.trim().replace(/^"+|"+$/g, "");
    return cleaned === "" ? fallback(fallbackLang) : cleaned;
  } catch (error) {
    log.debug(`SecretWarning: LLM error, falling back to fixed text: ${(error as Error).message}`);
    return fallback(fallbackLang);
  }
}
