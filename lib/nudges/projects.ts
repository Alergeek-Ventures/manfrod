import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import { describePeriod, upcomingPeriods } from "../holidays.ts";
import { listIssues } from "../linear/calls.ts";
import { getConnection } from "../linear/index.ts";
import { logger } from "../log.ts";
import { resolveForRead } from "../memory/access.ts";
import { listNodesByDate } from "../memory/nodes.ts";
import { channelHistory, fetchUserName, listChannels, listFullThread, post, type SlackBody } from "../slack/api.ts";
import { fromMarkdown } from "../slack/mrkdwn.ts";
import { addDays, isoWeek, localToday, zonedToUtc } from "../time.ts";
import { decide } from "./compose.ts";
import { channelSettings, markSummarized } from "./store.ts";

const { channelMappings, projects } = tables;
const MAX_NOTES = 80;
const MAX_MESSAGES = 60;
const MESSAGE_CHARS = 300;
const NOTE_CHARS = 400;
const THREAD_REPLIES = 5;

const log = logger("Nudges.Projects");

const GUIDANCE = `It is Friday afternoon. Write this project's weekly summary for its Slack channel: what got done, decisions made, what is in progress or blocked, and what is coming next week. Base it only on the notes, channel messages and Linear issues below, and credit people with <@SLACK_ID> where it helps. Keep it short and easy to scan; a compact list is fine here. Leave out small talk and anything already obsolete. If the week was quiet and there is nothing meaningful to report, do not send.`;

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text.replaceAll("\n", " "));

async function internalProjectChannels() {
  const rows = await db
    .select({ channelId: channelMappings.slackChannelId, projectId: channelMappings.projectId, project: projects.name })
    .from(channelMappings)
    .innerJoin(projects, eq(projects.id, channelMappings.projectId))
    .where(and(eq(channelMappings.status, "active"), isNotNull(channelMappings.projectId), isNull(channelMappings.clientId)));
  const seen = new Set<string>();
  return rows.filter((row) => !seen.has(row.channelId) && seen.add(row.channelId));
}

async function channelActivity(channelId: string, since: string): Promise<string> {
  const oldest = String(Math.floor(zonedToUtc(since, "00:00:00").getTime() / 1000));
  const roots = ((await channelHistory(channelId, oldest)) ?? []).filter((message) => !message.bot_id && message.subtype === undefined);
  const names = new Map<string, string>();
  const name = async (message: SlackBody) => {
    const id = message.user as string | undefined;
    if (!id) return "?";
    if (!names.has(id)) names.set(id, (await fetchUserName(id)) ?? id);
    return `${names.get(id)} <@${id}>`;
  };
  const lines: string[] = [];
  for (const root of roots.slice(0, MAX_MESSAGES).reverse()) {
    lines.push(`- ${await name(root)}: ${clip(root.text ?? "", MESSAGE_CHARS)}`);
    if (Number(root.reply_count ?? 0) === 0) continue;
    const replies = ((await listFullThread(channelId, root.ts, 100)) ?? []).slice(1).filter((reply) => !reply.bot_id);
    for (const reply of replies.slice(-THREAD_REPLIES)) lines.push(`    ${await name(reply)}: ${clip(reply.text ?? "", MESSAGE_CHARS)}`);
  }
  return lines.join("\n");
}

export async function runProjectSummaries(today = localToday()): Promise<number> {
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const monday = addDays(today, -((weekday + 6) % 7));
  const period = `${today.slice(0, 4)}-W${String(isoWeek(today)).padStart(2, "0")}`;
  const member = new Set(((await listChannels()) ?? []).filter((channel) => channel.is_member).map((channel) => channel.id as string));
  const holidays = await upcomingPeriods(addDays(monday, 7), 5);
  const nextWeek =
    holidays.ok && holidays.value.length > 0 ? `Public holidays next week:\n${holidays.value.map(describePeriod).join("\n")}` : "";
  let posted = 0;
  for (const channel of await internalProjectChannels()) {
    try {
      if (!member.has(channel.channelId)) continue;
      const settings = await channelSettings(channel.channelId);
      if (!settings.summaries || settings.lastSummaryPeriod === period) continue;
      const levels = await resolveForRead("", channel.channelId);
      const notes = await listNodesByDate(levels, {
        since: zonedToUtc(monday, "00:00:00"),
        projectId: channel.projectId,
        limit: MAX_NOTES,
        order: "asc",
      });
      const activity = await channelActivity(channel.channelId, monday);
      if (notes.length === 0 && !activity) {
        await markSummarized(channel.channelId, period);
        continue;
      }
      const linear = (await getConnection(channel.projectId)) ? await listIssues(channel.projectId!, 30) : "";
      const context = [
        `Project: ${channel.project}`,
        notes.length > 0
          ? `Notes from your memory this week:\n${notes.map((node) => `- ${node.insertedAt.toISOString().slice(0, 10)}: ${clip(node.content, NOTE_CHARS)}`).join("\n")}`
          : "",
        activity ? `Channel messages this week:\n${activity}` : "",
        linear ? `Linear issues of the project:\n${linear}` : "",
        nextWeek,
      ]
        .filter(Boolean)
        .join("\n\n");
      const decision = await decide({
        kind: "weekly project summary",
        audience: `the project channel <#${channel.channelId}>`,
        guidance: GUIDANCE,
        context,
      });
      if (decision?.send) {
        const sent = await post("chat.postMessage", { channel: channel.channelId, text: fromMarkdown(decision.message) });
        if (!sent.ok) {
          log.warn(`Nudges.Projects: could not post to ${channel.channelId}: ${sent.error}`);
          continue;
        }
        posted += 1;
      }
      await markSummarized(channel.channelId, period);
    } catch (error) {
      log.error(`Nudges.Projects: failed for ${channel.channelId}: ${(error as Error).message}`);
    }
  }
  if (posted > 0) log.info(`Nudges.Projects: posted ${posted} project summary(ies)`);
  return posted;
}
