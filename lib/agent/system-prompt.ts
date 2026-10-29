import { getUser } from "../accounts.ts";
import { languageInstructions } from "../agent-settings.ts";
import { healthy } from "../db/index.ts";
import { getSoulAnchor, type SoulAnchor } from "../memory/nodes.ts";
import { secretsPrompt } from "../secrets.ts";
import { tasksPrompt } from "../tasks/index.ts";
import { localIsoWithOffset, isoWeek, localToday, offsetMinutes, weekdayName, zoneAbbreviation, TIMEZONE } from "../time.ts";
import { SOUL_BASE_PROMPT, SOUL_ONBOARDING_PROMPT, SYSTEM_PROMPT } from "./prompts.ts";

function soulContext({ soul, linked, more }: SoulAnchor): string {
  const sections = [`[Soul - Entrypoint to your notes graph]\n${soul.content}\n`];
  if (linked.length > 0) {
    const lines = linked.map((node) => `- [${node.id}] ${node.content.slice(0, 200)}`);
    if (more > 0) lines.push(`- ...and ${more} older linked note(s): get-note ${soul.id} lists them all`);
    sections.push(`[Linked Notes - expanding the entrypoint]\n${lines.join("\n")}\n`);
  }
  return sections.join("\n\n");
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
      `\nYou are in Slack channel ${channel}, thread_ts ${threadTs}. read-slack-thread with no arguments reads this thread, read-slack-channel with no arguments reads this channel.`;
  } else {
    const user = await getUser(userId);
    if (user?.name) userLine = `\nUser: ${user.name}`;
  }
  return `[Current Context]\n${nowLine()}${userLine}`.trim();
}

export async function buildSystemPrompt(userId: string, sessionKey: string | null, readableLevels: string[]): Promise<string> {
  if (!(await healthy())) return SYSTEM_PROMPT + SOUL_BASE_PROMPT;
  const dm = isDmSession(sessionKey);
  const anchor = dm ? await getSoulAnchor(userId, readableLevels) : null;
  const base = anchor
    ? `${soulContext(anchor)}\n\n${SYSTEM_PROMPT}`
    : `${SYSTEM_PROMPT}${SOUL_BASE_PROMPT}${dm ? SOUL_ONBOARDING_PROMPT : ""}`;
  const secrets = await secretsPrompt(userId);
  const language = await languageInstructions(sessionKey?.split(":")[0] ?? null);
  const tasks = await tasksPrompt(sessionKey);
  return `${base}\n\n${await currentContext(userId, sessionKey)}\n\n${language}${secrets ? `\n\n${secrets}` : ""}${tasks ? `\n\n${tasks}` : ""}`;
}

export async function skillRunnerPrompt(channelId: string | null, userId: string | null): Promise<string> {
  const secrets = await secretsPrompt(userId);
  const language = await languageInstructions(channelId);
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

${language}
${secrets ? `\n${secrets}\n` : ""}
`;
}

export function isEmptyReply(text: string): boolean {
  return /\bEMPTY\b/.test(text);
}
