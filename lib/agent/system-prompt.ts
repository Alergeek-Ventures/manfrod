import { getUser } from "../accounts.ts";
import { languageInstructions } from "../agent-settings.ts";
import { healthy } from "../db/index.ts";
import { githubPrompt } from "../github/prompt.ts";
import { integrationsPrompt } from "./integrations.ts";
import { getSoulAnchor, type SoulAnchor } from "../memory/nodes.ts";
import { secretsPrompt } from "../secrets.ts";
import { tasksPrompt } from "../tasks/index.ts";
import { localIsoWithOffset, isoWeek, localToday, offsetMinutes, weekdayName, zoneAbbreviation, TIMEZONE } from "../time.ts";
import { CONVERSATION_PROMPT, SOUL_BASE_PROMPT, SOUL_ONBOARDING_PROMPT, TIME_NOTE_HEADER } from "./prompts.ts";

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

export const timeNote = () => `${TIME_NOTE_HEADER}\n${nowLine()}`;

export async function currentContext(userId: string, sessionKey: string | null, channel: string | null): Promise<string> {
  let userLine = "";
  if (channel?.startsWith("D")) {
    const user = await getUser(userId);
    userLine =
      '\nThis is a private direct message (DM) with this person, not a channel; only they read your reply. Their private notes are readable here, so list or quote them when they ask. A "[The user is currently viewing #…]" line only says which channel is open on their screen, not where this conversation happens.' +
      (user?.name ? `\nUser: ${user.name}` : "");
  } else if (!sessionKey && channel) {
    userLine = `\nThis is a shared Slack channel, ${channel}; other people may read your reply.`;
  } else if (sessionKey && !isDmSession(sessionKey)) {
    const [channel, threadTs] = sessionKey.split(":");
    userLine =
      '\nThis is a shared channel thread — multiple people participate. Each user message is prefixed with its author ("[from: Full Name <slack_id>]" — the <slack_id> is a unique identifier, not part of the name; use it to tell apart people who share a name). Address the right person; don\'t assume there is a single "the user".' +
      `\nYou are in Slack channel ${channel}, thread_ts ${threadTs}. read-slack-thread with no arguments reads this thread, read-slack-channel with no arguments reads this channel.`;
  } else {
    const user = await getUser(userId);
    if (user?.name) userLine = `\nUser: ${user.name}`;
  }
  return userLine === "" ? "" : `[Current Context]${userLine}`;
}

const sections = (...parts: (string | null | undefined)[]) =>
  parts
    .map((part) => part?.trim() ?? "")
    .filter((part) => part !== "")
    .join("\n\n");

export async function buildSystemPrompt(
  userId: string,
  sessionKey: string | null,
  readableLevels: string[],
  channelWithoutSession: string | null = null,
): Promise<string> {
  if (!(await healthy())) return sections(CONVERSATION_PROMPT, SOUL_BASE_PROMPT);
  const channel = sessionKey?.split(":")[0] ?? channelWithoutSession;
  const dm = channel?.startsWith("D") ?? false;
  const [anchor, context, language, secrets, tasks, github, integrations] = await Promise.all([
    dm ? getSoulAnchor(userId, readableLevels) : null,
    currentContext(userId, sessionKey, channel),
    languageInstructions(channel),
    secretsPrompt(userId),
    tasksPrompt(sessionKey),
    githubPrompt(channel),
    integrationsPrompt(userId, channel),
  ]);
  const identity = anchor ? soulContext(anchor) : `${SOUL_BASE_PROMPT}${dm ? SOUL_ONBOARDING_PROMPT : ""}`;
  return sections(CONVERSATION_PROMPT, identity, context, language, github, integrations, secrets, tasks);
}

export async function skillRunnerPrompt(channelId: string | null, userId: string | null): Promise<string> {
  const [secrets, language, integrations] = await Promise.all([
    secretsPrompt(userId),
    languageInstructions(channelId),
    integrationsPrompt(userId, channelId),
  ]);
  return `You're running autonomously on a schedule — no one is watching this
conversation live, so don't narrate or ask questions, just act. Follow
the instructions in the latest message using your tools. When you're
done, reply with a short confirmation (1 sentence) — it gets posted to
the target Slack channel exactly like a normal reply.

If the instructions tell you there's nothing worth posting in some
case (e.g. "if X, don't report anything"), call no-reply instead of
replying, so nothing is posted to Slack. Only use it when the
instructions actually call for staying silent; otherwise reply
normally.

${language}
${integrations ? `\n${integrations}\n` : ""}${secrets ? `\n${secrets}\n` : ""}
`;
}
