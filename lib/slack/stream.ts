import { logger } from "../log.ts";
import { appendStream, deleteMessage, setStatus, startStream, stopStream, type SlackBody, type SlackResult } from "./api.ts";
import { blocksWeight, CARD_LIMITS, countCharts, countTables } from "./cards.ts";
import { toBlocks, withoutTableSeparators } from "./mrkdwn.ts";
import { shared, TtlMap } from "./state.ts";

const log = logger("Slack.StreamSession");

const FLUSH_INTERVAL_MS = 700;
const IDLE_TIMEOUT_MS = 3 * 60 * 1000;
const TASK_FIELD_LIMIT = 256;
const BUFFERED_BLOCKS_TTL_MS = 2 * 60 * 1000;
const MAX_START_ATTEMPTS = 3;
const FEEDBACK_BLOCKS = 1;
const MESSAGE_CARD_BLOCKS = CARD_LIMITS.maxBlocks - FEEDBACK_BLOCKS;

export interface Recipient {
  userId: string;
  teamId: string | null;
}

export interface Task {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "complete" | "error";
  details?: string | null;
  output?: string | null;
}

type Chunk = SlackBody;

export interface BlockDelivery {
  readonly delivered: Promise<boolean>;
  waitingForStream(): boolean;
  cancel(): boolean;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const hasTextTable = (text: string) => toBlocks(text).blocks?.some((block) => block.type === "table") ?? false;

const refused: BlockDelivery = { delivered: Promise.resolve(false), waitingForStream: () => false, cancel: () => false };

function truncate(text: string | null | undefined, limit: number): string | null {
  if (text === null || text === undefined) return null;
  return [...text].length > limit ? `${[...text].slice(0, limit - 1).join("")}…` : text;
}

function taskChunk(task: Task): Chunk {
  const chunk: Chunk = { type: "task_update", id: task.id, title: truncate(task.title, TASK_FIELD_LIMIT), status: task.status };
  const details = truncate(task.details, TASK_FIELD_LIMIT);
  const output = truncate(task.output, TASK_FIELD_LIMIT);
  if (details) chunk.details = details;
  if (output) chunk.output = output;
  return chunk;
}

export function remainingText(turnText: string, content: string): string {
  if (turnText.trim() === "") return content;
  if (content.trim() === turnText.trim()) return "";
  if (content.startsWith(turnText)) return content.slice(turnText.length);
  return `\n\n${content}`;
}

class StreamSession {
  ts: string | null = null;
  private pending: Chunk[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private turnText = "";
  private streamedText = "";
  private heldLine = "";
  private cardBlocks = 0;
  private cardTables = 0;
  private cardCharts = 0;
  private startFailures = 0;
  planTitle: string | null = null;
  private tasks = new Map<string, Task>();
  private queue: Promise<unknown> = Promise.resolve();
  private deliveries = new Map<Chunk, (delivered: boolean) => void>();
  closed = false;

  constructor(
    readonly channel: string,
    readonly threadTs: string,
    private readonly recipient: Recipient | null,
    private readonly onClose: () => void,
  ) {
    this.touch();
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      log.warn(`Slack StreamSession idle timeout in ${this.channel}/${this.threadTs}, closing stream`);
      void this.abort("_(przerwane - brak odpowiedzi)_");
    }, IDLE_TIMEOUT_MS);
  }

  private enqueue(chunk: Chunk) {
    if (chunk.type === "markdown_text") {
      const last = this.pending.at(-1);
      if (last?.type === "markdown_text") {
        last.text += chunk.text;
        return;
      }
    }
    if (chunk.type === "task_update") {
      const index = this.pending.findIndex((existing) => existing.type === "task_update" && existing.id === chunk.id);
      if (index !== -1) {
        this.pending[index] = chunk;
        return;
      }
    }
    this.pending.push(chunk);
  }

  private settle(chunks: Chunk[], delivered: boolean) {
    for (const chunk of chunks) {
      const resolve = this.deliveries.get(chunk);
      if (!resolve) continue;
      this.deliveries.delete(chunk);
      if (!delivered) {
        this.cardBlocks -= blocksWeight(chunk.blocks);
        this.cardTables -= countTables(chunk.blocks);
        this.cardCharts -= countCharts(chunk.blocks);
      }
      resolve(delivered);
    }
  }

  private withoutCards(chunks: Chunk[]): Chunk[] {
    return chunks.filter((chunk) => !this.deliveries.has(chunk));
  }

  private stalled() {
    return this.ts === null && this.startFailures >= MAX_START_ATTEMPTS;
  }

  private withdraw(chunk: Chunk): boolean {
    const index = this.pending.indexOf(chunk);
    if (index === -1) return false;
    this.pending.splice(index, 1);
    this.settle([chunk], false);
    return true;
  }

  private maybeFlush() {
    if (this.flushTimer) return;
    void this.serial(() => this.flush());
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.pending.length > 0 && !this.stalled()) this.maybeFlush();
    }, FLUSH_INTERVAL_MS);
  }

  private async send(chunks: Chunk[]): Promise<boolean> {
    if (this.ts === null) {
      const opts: SlackBody = { chunks, task_display_mode: "plan" };
      if (this.recipient) {
        opts.recipient_user_id = this.recipient.userId;
        if (this.recipient.teamId) opts.recipient_team_id = this.recipient.teamId;
      }
      const ts = await startStream(this.channel, this.threadTs, opts);
      if (!ts) return false;
      this.ts = ts;
      void setStatus(this.channel, this.threadTs, "");
      return true;
    }
    const result = await appendStream(this.channel, this.ts, chunks);
    if (!result.ok) log.warn(`Slack StreamSession failed to append to stream in ${this.channel}: ${result.error}`);
    return result.ok;
  }

  private async flush() {
    if (this.pending.length === 0 || this.closed || this.stalled()) return;
    const chunks = this.pending;
    this.pending = [];
    if (await this.send(chunks)) {
      this.settle(chunks, true);
      return;
    }
    const rest = this.withoutCards(chunks);
    if (rest.length < chunks.length) {
      this.settle(chunks, false);
      if (rest.length === 0 || (await this.send(rest))) return;
    }
    if (this.ts !== null) return;
    this.startFailures += 1;
    log.error(`Slack StreamSession failed to start stream in ${this.channel} (attempt ${this.startFailures})`);
    this.pending = [...rest, ...this.pending];
  }

  private async stop(ts: string, chunks: Chunk[]): Promise<SlackResult> {
    const result = await stopStream(this.channel, ts, chunks);
    if (result.ok) {
      this.settle(chunks, true);
      return result;
    }
    const rest = this.withoutCards(chunks);
    this.settle(chunks, false);
    if (rest.length === chunks.length) return result;
    log.warn(`Slack StreamSession failed to stop stream with card blocks in ${this.channel}: ${result.error}, retrying without them`);
    return stopStream(this.channel, ts, rest);
  }

  keepAlive() {
    if (!this.closed) this.touch();
  }

  private plainTables(text: string): string {
    return this.cardTables > 0 ? withoutTableSeparators(text) : text;
  }

  private emitText(text: string) {
    this.turnText += text;
    this.enqueue({ type: "markdown_text", text: this.plainTables(text) });
    this.touch();
    this.maybeFlush();
  }

  private releaseHeldLine() {
    const held = this.heldLine;
    this.heldLine = "";
    if (held !== "") this.emitText(held);
  }

  text(text: string) {
    this.streamedText += text;
    if (this.cardTables === 0 && this.heldLine === "") {
      this.emitText(text);
      return;
    }
    const combined = this.heldLine + text;
    const lineStart = combined.lastIndexOf("\n") + 1;
    const partial = combined.slice(lineStart);
    const mayBeTableRow = /^\s*\|/.test(partial);
    this.heldLine = mayBeTableRow ? partial : "";
    const ready = mayBeTableRow ? combined.slice(0, lineStart) : combined;
    if (ready !== "") this.emitText(ready);
  }

  blocks(blocks: Record<string, unknown>[]): BlockDelivery {
    if (this.closed || this.stalled()) return refused;
    const weight = blocksWeight(blocks);
    const tables = countTables(blocks);
    const charts = countCharts(blocks);
    if (this.cardBlocks + weight > MESSAGE_CARD_BLOCKS) return refused;
    if (tables > 0 && (this.cardTables + tables > CARD_LIMITS.maxTables || hasTextTable(this.streamedText))) return refused;
    if (this.cardCharts + charts > CARD_LIMITS.maxCharts) return refused;
    this.cardBlocks += weight;
    this.cardTables += tables;
    this.cardCharts += charts;
    const chunk: Chunk = { type: "blocks", blocks };
    const { promise, resolve } = deferred<boolean>();
    this.deliveries.set(chunk, resolve);
    this.enqueue(chunk);
    this.touch();
    this.maybeFlush();
    return { delivered: promise, waitingForStream: () => false, cancel: () => this.withdraw(chunk) };
  }

  plan(title: string) {
    if (title === this.planTitle) return;
    this.planTitle = title;
    this.enqueue({ type: "plan_update", title: truncate(title, TASK_FIELD_LIMIT) });
    this.touch();
    this.maybeFlush();
  }

  planDefault(title: string) {
    if (this.planTitle === null) this.plan(title);
  }

  task(task: Task) {
    const previous = this.tasks.get(task.id);
    const merged: Task = {
      ...previous,
      ...Object.fromEntries(Object.entries(task).filter(([, value]) => value !== null && value !== undefined)),
    } as Task;
    this.releaseHeldLine();
    this.turnText = "";
    this.tasks.set(merged.id, merged);
    this.enqueue(taskChunk(merged));
    this.touch();
    this.maybeFlush();
  }

  private closeOpenTasks(status: Task["status"]): Chunk[] {
    return [...this.tasks.values()].filter((task) => task.status === "in_progress").map((task) => taskChunk({ ...task, status }));
  }

  private dispose() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.settle(this.pending, false);
    this.pending = [];
    this.closed = true;
    this.onClose();
  }

  finish(content: string, extraChunks: Chunk[]): Promise<"ok" | "not_streaming" | "error"> {
    return this.serial(async () => {
      if (this.ts === null) {
        this.dispose();
        return "not_streaming";
      }
      this.heldLine = "";
      const tail = this.plainTables(remainingText(this.turnText, content));
      const chunks = [
        ...this.pending,
        ...this.closeOpenTasks("complete"),
        ...(tail === "" ? [] : [{ type: "markdown_text", text: tail }]),
        ...extraChunks,
      ];
      this.pending = [];
      const ts = this.ts;
      this.dispose();
      const result = await this.stop(ts, chunks);
      if (!result.ok) {
        log.error(`Slack StreamSession failed to stop stream in ${this.channel}: ${result.error}`);
        return "error";
      }
      return "ok";
    });
  }

  abort(note: string | null = null): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return;
      const held = this.plainTables(this.heldLine);
      this.heldLine = "";
      const chunks = [...this.pending, ...(held === "" ? [] : [{ type: "markdown_text", text: held }]), ...this.closeOpenTasks("error")];
      if (note) chunks.push({ type: "markdown_text", text: `\n\n${note}` });
      this.pending = [];
      const ts = this.ts;
      this.dispose();
      if (ts === null) {
        this.settle(chunks, false);
        return;
      }
      const result = await this.stop(ts, chunks);
      if (!result.ok) log.warn(`Slack StreamSession failed to close stream in ${this.channel}: ${result.error}`);
    });
  }

  discard(): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return;
      const ts = this.ts;
      this.dispose();
      if (ts === null) return;
      await stopStream(this.channel, ts);
      const result = await deleteMessage(this.channel, ts);
      if (!result.ok) log.warn(`Slack StreamSession failed to delete discarded stream in ${this.channel}: ${result.error}`);
    });
  }
}

const sessions = shared("streamSessions", () => new Map<string, StreamSession>());

interface BufferedBlocks {
  attach(session: StreamSession): void;
}

const bufferedBlocks = shared("bufferedStreamBlocks", () => new TtlMap<string, BufferedBlocks[]>(BUFFERED_BLOCKS_TTL_MS));

const key = (channel: string, threadTs: string) => `${channel}:${threadTs}`;

export function getStream(channel: string, threadTs: string): StreamSession | undefined {
  return sessions.get(key(channel, threadTs));
}

export function ensureStream(channel: string, threadTs: string, recipient: Recipient | null): StreamSession {
  const existing = getStream(channel, threadTs);
  if (existing && !existing.closed) return existing;
  const session = new StreamSession(channel, threadTs, recipient, () => {
    if (sessions.get(key(channel, threadTs)) === session) sessions.delete(key(channel, threadTs));
  });
  sessions.set(key(channel, threadTs), session);
  const waiting = bufferedBlocks.get(key(channel, threadTs)) ?? [];
  bufferedBlocks.delete(key(channel, threadTs));
  for (const entry of waiting) entry.attach(session);
  return session;
}

export function sendBlocks(channel: string, threadTs: string, blocks: Record<string, unknown>[]): BlockDelivery {
  const stream = getStream(channel, threadTs);
  if (stream && !stream.closed) return stream.blocks(blocks);
  const { promise, resolve } = deferred<boolean>();
  let attached: BlockDelivery | null = null;
  let cancelled = false;
  const entry: BufferedBlocks = {
    attach(session) {
      attached = session.blocks(blocks);
      void attached.delivered.then(resolve);
    },
  };
  const waiting = bufferedBlocks.get(key(channel, threadTs)) ?? [];
  waiting.push(entry);
  bufferedBlocks.set(key(channel, threadTs), waiting);
  return {
    delivered: promise,
    waitingForStream: () => attached === null && !cancelled,
    cancel() {
      if (attached) return attached.cancel();
      if (cancelled) return false;
      cancelled = true;
      const current = bufferedBlocks.get(key(channel, threadTs));
      const remaining = current?.filter((candidate) => candidate !== entry) ?? [];
      if (remaining.length > 0) bufferedBlocks.set(key(channel, threadTs), remaining);
      else bufferedBlocks.delete(key(channel, threadTs));
      resolve(false);
      return true;
    },
  };
}

export type { StreamSession };
