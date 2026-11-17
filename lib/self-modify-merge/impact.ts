import { and, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { SelfModifyMerge } from "../db/schema.ts";
import { post } from "../slack/api.ts";
import { BAD_RATING, INFERRED_RATING } from "../self-review/rules.ts";
import { closeTask, getTask } from "../tasks/index.ts";
import { formatLocal } from "../time.ts";
import { parseTarget, type TargetKind } from "./eligibility.ts";
import { recordVerdict, type Verdict } from "./store.ts";

const { auditEvents, messageFeedback } = tables;

export const RETENTION_DAYS = 7;
const RETENTION_MARGIN_MS = 3_600_000;
const SKILL_ACTIONS = ["load-skill", "eve__skill"];
const LISTED_LINKS = 10;

export const ROUTINE_KINDS: Record<string, string[]> = {
  "work-start": ["nudge_waiting"],
  "absence-follow-up": ["nudge_absence"],
  "weekly-wrap-up": ["nudge_weekly"],
  "evening-hours": ["nudge_hours"],
  "holiday-check": ["holiday_check"],
};

export const UNTRACKED_ROUTINES = new Set(["weekly-project-summary", "proactive-style"]);

export interface Window {
  from: Date;
  to: Date;
}

export interface Usage {
  uses: number;
  sessions: number;
  negative: { rating: string; permalink: string | null; at: Date }[];
}

export function windows(liveAt: Date, now: Date): { before: Window; after: Window } {
  const length = now.getTime() - liveAt.getTime();
  const oldest = now.getTime() - RETENTION_DAYS * 86_400_000 + RETENTION_MARGIN_MS;
  return {
    before: { from: new Date(Math.max(liveAt.getTime() - length, oldest)), to: liveAt },
    after: { from: liveAt, to: now },
  };
}

function usesQuery(kind: TargetKind, name: string) {
  if (kind === "skill") {
    return and(
      eq(auditEvents.type, "action_started"),
      inArray(sql`${auditEvents.meta} ->> 'action'`, SKILL_ACTIONS),
      sql`${auditEvents.meta} ->> 'args' like ${`%"name":"${name}"%`}`,
    );
  }
  const kinds = ROUTINE_KINDS[name] ?? [];
  return and(
    eq(auditEvents.type, "thinking"),
    or(
      sql`${auditEvents.meta} ->> 'skill_name' = ${name}`,
      kinds.length > 0 ? inArray(sql`${auditEvents.meta} ->> 'kind'`, kinds) : undefined,
    ),
  );
}

export async function usage(kind: TargetKind, name: string, window: Window): Promise<Usage> {
  const rows = await db
    .select({ sessionKey: sql<string | null>`${auditEvents.meta} ->> 'session_key'` })
    .from(auditEvents)
    .where(and(usesQuery(kind, name), gte(auditEvents.timestamp, window.from), lt(auditEvents.timestamp, window.to)));
  const sessions = [...new Set(rows.flatMap((row) => (row.sessionKey ? [row.sessionKey] : [])))];
  const uses = sessions.length + rows.filter((row) => !row.sessionKey).length;
  if (sessions.length === 0) return { uses, sessions: 0, negative: [] };
  const negative = await db
    .select({ rating: messageFeedback.rating, permalink: messageFeedback.permalink, at: messageFeedback.insertedAt })
    .from(messageFeedback)
    .where(and(inArray(messageFeedback.sessionKey, sessions), inArray(messageFeedback.rating, [BAD_RATING, INFERRED_RATING])));
  return { uses, sessions: sessions.length, negative };
}

const rate = (usage: Usage) => (usage.sessions === 0 ? "n/a" : `${Math.round((usage.negative.length / usage.sessions) * 100)}%`);

function links(usage: Usage): string {
  const listed = usage.negative.slice(0, LISTED_LINKS).map((entry) => {
    const label = `${entry.rating === BAD_RATING ? "👎" : "inferred"} ${formatLocal(entry.at)}`;
    return entry.permalink ? `<${entry.permalink}|${label}>` : label;
  });
  const more = usage.negative.length > LISTED_LINKS ? ` and ${usage.negative.length - LISTED_LINKS} more` : "";
  return listed.length > 0 ? `${listed.join(", ")}${more}` : "none";
}

export function describeUsage(label: string, window: Window, usage: Usage): string {
  return `  ${label} (${formatLocal(window.from)} – ${formatLocal(window.to)}): ${usage.uses} use(s) in ${usage.sessions} conversation(s), ${usage.negative.length} negative rating(s), ${rate(usage)} of conversations. Ratings: ${links(usage)}`;
}

export async function impactReport(merge: SelfModifyMerge, pullUrl: string | null, now = new Date()): Promise<string> {
  if (!merge.liveAt) return `#${merge.pullNumber} is not live in production yet.`;
  const { before, after } = windows(merge.liveAt, now);
  const parts = [
    `#${merge.pullNumber}${pullUrl ? ` (${pullUrl})` : ""}, live since ${formatLocal(merge.liveAt)}. Uses are kept ${RETENTION_DAYS} days, so the window before the deploy is at most as long as the one after. Ratings inferred from conversations arrive the night after.`,
  ];
  for (const value of merge.targets) {
    const target = parseTarget(value);
    if (!target) continue;
    if (target.kind === "routine" && UNTRACKED_ROUTINES.has(target.name)) {
      parts.push(`${value}: its runs are not traceable to conversations, so there is no data.`);
      continue;
    }
    const [was, is] = await Promise.all([usage(target.kind, target.name, before), usage(target.kind, target.name, after)]);
    parts.push(`${value}:\n${describeUsage("Before", before, was)}\n${describeUsage("After", after, is)}`);
  }
  return parts.join("\n\n");
}

const VERDICTS: Record<Verdict, string> = {
  better: ":chart_with_upwards_trend: Better",
  no_change: ":heavy_minus_sign: No clear change",
  worse: ":chart_with_downwards_trend: Worse",
  not_enough_data: ":grey_question: Not enough data",
};

export function verdictText(pullNumber: number, pullUrl: string | null, verdict: Verdict, summary: string): string {
  const pull = pullUrl ? `<${pullUrl}|#${pullNumber}>` : `#${pullNumber}`;
  const revert = verdict === "worse" ? `\nI recommend reverting ${pull}; I won't revert it myself.` : "";
  return `${VERDICTS[verdict]} after ${pull}: ${summary}${revert}`;
}

export async function postVerdict(merge: SelfModifyMerge, pullUrl: string | null, verdict: Verdict, summary: string): Promise<string> {
  if (!merge.channelId || !merge.threadTs) return "This pull request has no self-review thread to post in.";
  const result = await post("chat.postMessage", {
    channel: merge.channelId,
    thread_ts: merge.threadTs,
    text: verdictText(merge.pullNumber, pullUrl, verdict, summary),
  });
  if (!result.ok) return `Could not post the verdict: ${result.error}`;
  await recordVerdict(merge.id, verdict);
  const task = merge.taskId ? await getTask(merge.taskId) : null;
  if (task && (task.status === "active" || task.status === "blocked")) await closeTask(task, "done", `${verdict}: ${summary}`);
  return `Posted the verdict (${verdict}) in the thread${task ? " and closed the task" : ""}.`;
}
