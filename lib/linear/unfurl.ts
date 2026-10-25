import { logger } from "../log.ts";
import { getActiveMapping } from "../memory/access.ts";
import { post } from "../slack/api.ts";
import { issueByIdentifier } from "./client.ts";
import { authorization, getConnection } from "./index.ts";

const log = logger("Linear.Unfurl");
const ISSUE_URL = /^https:\/\/linear\.app\/([^/]+)\/issue\/([A-Za-z0-9]+-\d+)/;
const MAX_LINKS = 5;

export interface LinkSharedEvent {
  channel?: string;
  message_ts?: string;
  unfurl_id?: string;
  source?: string;
  links?: { url: string }[];
}

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function excerpt(description: string | null): string | null {
  const text = (description ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return escape(text.length > 280 ? `${text.slice(0, 279)}…` : text);
}

function issueBlocks(issue: any): unknown[] {
  const details = [
    issue.state?.name,
    issue.priority ? issue.priorityLabel : null,
    issue.assignee?.name ?? "Unassigned",
    issue.project?.name,
    issue.cycle ? `Cycle ${issue.cycle.name ?? issue.cycle.number}` : null,
    issue.dueDate ? `Due ${issue.dueDate}` : null,
    issue.estimate ? `${issue.estimate} pts` : null,
    ...(issue.labels?.nodes ?? []).map((label: { name: string }) => label.name),
  ].filter(Boolean);
  const summary = excerpt(issue.description);
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*<${issue.url}|${issue.identifier} ${escape(issue.title)}>*${summary ? `\n${summary}` : ""}` },
    },
    { type: "context", elements: [{ type: "mrkdwn", text: escape(details.join(" · ")) }] },
  ];
}

export async function unfurlLinearLinks(event: LinkSharedEvent): Promise<void> {
  const links = (event.links ?? [])
    .map((link) => ({ url: link.url, match: ISSUE_URL.exec(link.url) }))
    .filter((link) => link.match)
    .slice(0, MAX_LINKS);
  if (links.length === 0) return;

  const mapping = await getActiveMapping(event.channel);
  const connection = await getConnection(mapping?.projectId);
  if (connection?.mode !== "app") return;
  const auth = await authorization(connection);
  if (!auth.ok) return;

  const unfurls: Record<string, { blocks: unknown[] }> = {};
  for (const { url, match } of links) {
    const issue = await issueByIdentifier(auth.value, match![2]);
    if (!issue.ok || !issue.value) continue;
    if (ISSUE_URL.exec(issue.value.url)?.[1] !== match![1]) continue;
    unfurls[url] = { blocks: issueBlocks(issue.value) };
  }
  if (Object.keys(unfurls).length === 0) return;

  const target =
    event.unfurl_id && event.source
      ? { unfurl_id: event.unfurl_id, source: event.source }
      : { channel: event.channel, ts: event.message_ts };
  const result = await post("chat.unfurl", { ...target, unfurls });
  if (!result.ok) log.warn(`Linear.Unfurl: chat.unfurl failed in ${event.channel}: ${result.error}`);
}
