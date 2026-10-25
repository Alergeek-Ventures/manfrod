import { getUser } from "../accounts.ts";
import { healthy } from "../db/index.ts";
import { getNodeLinksAccessible, getSoul } from "../memory/nodes.ts";
import { placeholder, secretNames } from "../secrets.ts";
import { catalogText } from "../skills.ts";
import { capabilitiesText } from "../tools/index.ts";
import { localIsoWithOffset, isoWeek, localToday, offsetMinutes, weekdayName, zoneAbbreviation, TIMEZONE } from "../time.ts";
import { SOUL_BASE_PROMPT, SYSTEM_PROMPT_INTRO, SYSTEM_PROMPT_REST } from "./prompts.ts";

function fullSystemPrompt(): string {
  return `${SYSTEM_PROMPT_INTRO}\n## Your Capabilities\n${capabilitiesText()}\n\n${SYSTEM_PROMPT_REST}`;
}

async function soulContext(userId: string, readableLevels: string[]): Promise<string> {
  const soul = await getSoul(userId);
  if (!soul) return "";
  const sections = [`[Soul - Entrypoint to your notes graph]\n${soul.content}\n`];
  const linked = (await getNodeLinksAccessible(readableLevels, soul.id)).filter((node) => node.userId === userId);
  if (linked.length > 0) {
    sections.push(
      `[Linked Notes - expanding the entrypoint]\n${linked.map((node) => `- [${node.id}] ${node.content.slice(0, 200)}`).join("\n")}\n`,
    );
  }
  return sections.join("\n\n");
}

export async function secretsText(): Promise<string> {
  let names: string[];
  try {
    names = await secretNames();
  } catch {
    return "";
  }
  if (names.length === 0) return "";
  return `[Secrets]
Admin-managed secrets are available as placeholders: ${names.map(placeholder).join(", ")}.
Skills and instructions may reference them. Put the placeholder verbatim into tool arguments where the value is needed — it is replaced with the real value only when the tool runs, and tool results show the placeholder again instead of the value. You never see the values: don't guess them, ask people for them, or claim to know them. Tools that save notes, souls or reminders keep placeholders as-is.`;
}

export const isDmSession = (sessionKey: string | null) => sessionKey?.startsWith("D") ?? false;

function nowLine(): string {
  const now = new Date();
  const today = localToday();
  const offset = Math.trunc(offsetMinutes(now) / 60);
  return `Now: ${localIsoWithOffset(now)} (${weekdayName(today)})
Week: ${isoWeek(today)} of ${today.slice(0, 4)}
Timezone: ${TIMEZONE} (${zoneAbbreviation(now)}, UTC${offset >= 0 ? "+" : "-"}${Math.abs(offset)})`;
}

async function currentContext(userId: string, sessionKey: string | null): Promise<string> {
  let userLine = "";
  if (sessionKey && !isDmSession(sessionKey)) {
    const [channel, threadTs] = sessionKey.split(":");
    userLine =
      '\nThis is a shared channel thread — multiple people participate. Each user message is prefixed with its author ("[from: Full Name <slack_id>]" — the <slack_id> is a unique identifier, not part of the name; use it to tell apart people who share a name). Address the right person; don\'t assume there is a single "the user".' +
      `\nYou are in Slack channel ${channel}, thread_ts ${threadTs}. read_slack_thread with no arguments reads this thread, read_slack_channel with no arguments reads this channel.`;
  } else {
    const user = await getUser(userId);
    if (user?.name) userLine = `\nUser: ${user.name}`;
  }
  return `[Current Context]\n${nowLine()}${userLine}`.trim();
}

export async function buildSystemPrompt(userId: string, sessionKey: string | null, readableLevels: string[]): Promise<string> {
  if (!(await healthy())) return fullSystemPrompt() + SOUL_BASE_PROMPT;
  const context = await soulContext(userId, readableLevels);
  const soul = await getSoul(userId);
  const base = soul ? `${context}\n\n${fullSystemPrompt()}` : `${context}\n\n${fullSystemPrompt()}${SOUL_BASE_PROMPT}`;
  const catalog = catalogText();
  const secrets = await secretsText();
  return `${base}\n\n${await currentContext(userId, sessionKey)}${catalog ? `\n\n${catalog}` : ""}${secrets ? `\n\n${secrets}` : ""}`;
}

export async function skillRunnerPrompt(): Promise<string> {
  const secrets = await secretsText();
  return `You're running autonomously on a schedule — no one is watching this
conversation live, so don't narrate or ask questions, just act. Follow
the instructions in the next message using your tools. When you're
done, reply with a short confirmation (1 sentence) — it gets posted to
the target Slack channel exactly like a normal reply.

If the instructions tell you there's nothing worth posting in some
case (e.g. "if X, don't report anything"), reply with exactly the
single word \`EMPTY\` and nothing else — that sentinel is caught and
silently discarded instead of being posted to Slack. Only use it when
the instructions actually call for staying silent; otherwise reply
normally.

[Current Context]
Now: ${localIsoWithOffset(new Date())} (${weekdayName(localToday())})
Timezone: ${TIMEZONE}
${secrets ? `\n${secrets}\n` : ""}
`;
}

export function isEmptyReply(text: string): boolean {
  return /\bEMPTY\b/.test(text);
}
