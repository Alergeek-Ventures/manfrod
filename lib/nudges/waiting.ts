import type { User } from "../db/schema.ts";
import { listOfficeAccessLog, type AccessEntry } from "../kalafiornia.ts";
import { logger } from "../log.ts";
import { resolveForRead } from "../memory/access.ts";
import { search } from "../memory/search.ts";
import {
  channelHistory,
  channelMembers,
  fetchUserName,
  getPermalink,
  isActive,
  listChannels,
  listFullThread,
  type SlackBody,
} from "../slack/api.ts";
import { localToday } from "../time.ts";
import { run } from "./compose.ts";
import { firmowidSessionActive, isAbsent, nudgeablePeople, wroteToday } from "./signals.ts";
import { handled, isEnabled, recordDelivery } from "./store.ts";

const LOOKBACK_HOURS = 72;
const MIN_AGE_MINUTES = 45;
const CHANNEL_ANSWER_WINDOW_SECONDS = 3600;
const CHANNEL_CONTEXT_MESSAGES = 5;
const MAX_THREADS = 12;
const COMMITMENT_DAYS = 14;
const TEXT_CHARS = 500;
const TAIL_CHARS = 200;

const log = logger("Nudges.Waiting");

const GUIDANCE = `This person just started their workday. Tell them, briefly, about Slack threads where someone is still waiting for their answer or action, and about things they promised to do that are still open and due around now. Skip FYIs, thank-yous, questions this person or someone else already answered (also in a separate channel message right after), matters that look closed, and anything older that has clearly gone stale. If nothing genuinely needs them, do not send.`;

const FOLLOW_UP = `Gdy odpowie: jeśli chce coś odpisać albo zobaczyć, przeczytaj wątek przez read-slack-thread i pomóż. Jeśli coś jest już załatwione, przyjmij to i nie wracaj do tego.`;

interface Thread {
  channelId: string;
  channelName: string;
  messages: SlackBody[];
}

export interface WaitingThread {
  channelId: string;
  channelName: string;
  ts: string;
  author: string;
  text: string;
  after: SlackBody[];
}

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

export function waitingFor(slackUserId: string, threads: Thread[], now: number): WaitingThread[] {
  const mention = `<@${slackUserId}>`;
  const roots = new Map<string, SlackBody[]>();
  for (const thread of threads) {
    if (thread.messages[0]) roots.set(thread.channelId, [...(roots.get(thread.channelId) ?? []), thread.messages[0]]);
  }
  const laterInChannel = (channelId: string, ts: string) =>
    (roots.get(channelId) ?? []).filter((root) => Number(root.ts) > Number(ts)).sort((a, b) => Number(a.ts) - Number(b.ts));
  const found: WaitingThread[] = [];
  for (const thread of threads) {
    thread.messages.forEach((message, index) => {
      if (message.user === slackUserId || message.bot_id || typeof message.text !== "string" || !message.text.includes(mention)) return;
      if (now - Number(message.ts) * 1000 < MIN_AGE_MINUTES * 60_000) return;
      const replies = thread.messages.slice(index + 1);
      if (replies.some((reply) => reply.user === slackUserId)) return;
      const channelAfter = index === 0 ? laterInChannel(thread.channelId, message.ts) : [];
      const answeredInChannel = channelAfter.some(
        (root) => root.user === slackUserId && Number(root.ts) - Number(message.ts) <= CHANNEL_ANSWER_WINDOW_SECONDS,
      );
      if (answeredInChannel) return;
      const after = [...replies, ...channelAfter.slice(0, CHANNEL_CONTEXT_MESSAGES)];
      found.push({
        channelId: thread.channelId,
        channelName: thread.channelName,
        ts: message.ts,
        author: message.user,
        text: message.text,
        after,
      });
    });
  }
  return found.sort((a, b) => Number(b.ts) - Number(a.ts)).slice(0, MAX_THREADS);
}

class Workspace {
  private threads: Promise<Thread[]> | null = null;
  private members = new Map<string, Promise<string[]>>();

  constructor(private readonly oldest: string) {}

  all(): Promise<Thread[]> {
    this.threads ??= this.load();
    return this.threads;
  }

  membersOf(channelId: string): Promise<string[]> {
    if (!this.members.has(channelId))
      this.members.set(
        channelId,
        channelMembers(channelId).then((members) => members ?? []),
      );
    return this.members.get(channelId)!;
  }

  private async load(): Promise<Thread[]> {
    const channels = ((await listChannels({ types: "public_channel,private_channel,mpim" })) ?? []).filter((channel) => channel.is_member);
    const threads: Thread[] = [];
    for (const channel of channels) {
      const history = (await channelHistory(channel.id, this.oldest)) ?? [];
      for (const root of history) {
        const replies = Number(root.reply_count ?? 0) > 0 ? ((await listFullThread(channel.id, root.ts, 200)) ?? [root]) : [root];
        threads.push({ channelId: channel.id, channelName: channel.name ?? channel.id, messages: replies });
      }
    }
    return threads;
  }
}

async function describeThreads(found: WaitingThread[]): Promise<string> {
  const names = new Map<string, string>();
  const name = async (slackId: string | undefined) => {
    if (!slackId) return "?";
    if (!names.has(slackId)) names.set(slackId, (await fetchUserName(slackId)) ?? slackId);
    return `${names.get(slackId)} <@${slackId}>`;
  };
  const blocks: string[] = [];
  for (const thread of found) {
    const permalink = (await getPermalink(thread.channelId, thread.ts)) ?? "(no link)";
    const age = Math.round((Date.now() - Number(thread.ts) * 1000) / 3_600_000);
    const tail = await Promise.all(
      thread.after.slice(-3).map(async (reply) => `    ${await name(reply.user)}: ${clip(reply.text ?? "", TAIL_CHARS)}`),
    );
    blocks.push(
      [
        `- #${thread.channelName}, ${age}h ago, ${permalink}`,
        `  ${await name(thread.author)}: ${clip(thread.text, TEXT_CHARS)}`,
        ...(tail.length > 0 ? ["  Later in the thread or channel:", ...tail] : []),
      ].join("\n"),
    );
  }
  return blocks.join("\n");
}

async function commitments(person: User): Promise<string> {
  const levels = await resolveForRead(person.id, person.slackDmChannelId!);
  const since = Date.now() - COMMITMENT_DAYS * 86_400_000;
  const nodes = await search(person.id, levels, `${person.name ?? ""} obiecał zrobić, zrobię, dam znać, wyślę, do jutra, termin`, {
    limit: 8,
    expandQuery: false,
  });
  return nodes
    .filter((node) => node.insertedAt.getTime() >= since)
    .map((node) => `- ${node.insertedAt.toISOString().slice(0, 10)}: ${clip(node.content, TEXT_CHARS)}`)
    .join("\n");
}

async function startedWork(person: User, today: string, office: AccessEntry[]): Promise<boolean> {
  if (await wroteToday(person.id, today)) return true;
  const name = person.name?.toLowerCase();
  if (name && office.some((entry) => (entry.user_name ?? "").toLowerCase().includes(name))) return true;
  if (await isActive(person.slackId)) return true;
  return firmowidSessionActive(person.id);
}

export async function runWorkStartNudges(today = localToday()): Promise<number> {
  const oldest = String(Math.floor((Date.now() - LOOKBACK_HOURS * 3_600_000) / 1000));
  const workspace = new Workspace(oldest);
  const office = await listOfficeAccessLog({ since: today });
  const entries = office.ok ? office.value : [];
  let sent = 0;
  for (const person of await nudgeablePeople()) {
    try {
      if (!(await isEnabled(person.id, "waiting")) || (await handled(person.id, "waiting", today))) continue;
      if (await isAbsent(person.id, today)) {
        await recordDelivery(person.id, "waiting", today, false, "Absent today.");
        continue;
      }
      if (!(await startedWork(person, today, entries))) continue;
      const threads = [];
      for (const thread of waitingFor(person.slackId, await workspace.all(), Date.now())) {
        if ((await workspace.membersOf(thread.channelId)).includes(person.slackId)) threads.push(thread);
      }
      const promised = await commitments(person);
      if (threads.length === 0 && !promised) {
        await recordDelivery(person.id, "waiting", today, false, "Nothing waiting.");
        continue;
      }
      const context = [
        threads.length > 0 ? `Threads that mention them with no reply from them since:\n${await describeThreads(threads)}` : "",
        promised ? `Notes from your memory that may be their commitments:\n${promised}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      if (await run({ kind: "waiting", period: today, person, guidance: GUIDANCE, context, followUp: FOLLOW_UP })) sent += 1;
    } catch (error) {
      log.error(`Nudges.Waiting: failed for ${person.id}: ${(error as Error).message}`);
    }
  }
  if (sent > 0) log.info(`Nudges.Waiting: sent ${sent} start-of-day message(s)`);
  return sent;
}
