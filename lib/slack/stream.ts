import { logger } from "../log.ts";
import { appendStream, setStatus, startStream, stopStream, type SlackBody } from "./api.ts";
import { shared } from "./state.ts";

const log = logger("Slack.StreamSession");

const FLUSH_INTERVAL_MS = 700;
const IDLE_TIMEOUT_MS = 3 * 60 * 1000;
const TASK_FIELD_LIMIT = 256;

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
  planTitle: string | null = null;
  private tasks = new Map<string, Task>();
  private queue: Promise<unknown> = Promise.resolve();
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

  private maybeFlush() {
    if (this.flushTimer) return;
    void this.serial(() => this.flush());
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.pending.length > 0) this.maybeFlush();
    }, FLUSH_INTERVAL_MS);
  }

  private async flush() {
    if (this.pending.length === 0 || this.closed) return;
    const chunks = this.pending;
    this.pending = [];
    if (this.ts === null) {
      const opts: SlackBody = { chunks, task_display_mode: "plan" };
      if (this.recipient) {
        opts.recipient_user_id = this.recipient.userId;
        if (this.recipient.teamId) opts.recipient_team_id = this.recipient.teamId;
      }
      const ts = await startStream(this.channel, this.threadTs, opts);
      if (!ts) {
        log.error(`Slack StreamSession failed to start stream in ${this.channel}`);
        this.pending = [...chunks, ...this.pending];
        return;
      }
      this.ts = ts;
      void setStatus(this.channel, this.threadTs, "");
      return;
    }
    const result = await appendStream(this.channel, this.ts, chunks);
    if (!result.ok) log.warn(`Slack StreamSession failed to append to stream in ${this.channel}: ${result.error}`);
  }

  text(text: string) {
    this.turnText += text;
    this.enqueue({ type: "markdown_text", text });
    this.touch();
    this.maybeFlush();
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
    this.closed = true;
    this.onClose();
  }

  finish(content: string, extraChunks: Chunk[]): Promise<"ok" | "not_streaming" | "error"> {
    return this.serial(async () => {
      if (this.ts === null) {
        this.dispose();
        return "not_streaming";
      }
      const tail = remainingText(this.turnText, content);
      const chunks = [
        ...this.pending,
        ...this.closeOpenTasks("complete"),
        ...(tail === "" ? [] : [{ type: "markdown_text", text: tail }]),
        ...extraChunks,
      ];
      this.pending = [];
      const ts = this.ts;
      this.dispose();
      const result = await stopStream(this.channel, ts, chunks);
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
      const chunks = [...this.pending, ...this.closeOpenTasks("error")];
      if (note) chunks.push({ type: "markdown_text", text: `\n\n${note}` });
      const ts = this.ts;
      this.dispose();
      if (ts === null) return;
      const result = await stopStream(this.channel, ts, chunks);
      if (!result.ok) log.warn(`Slack StreamSession failed to close stream in ${this.channel}: ${result.error}`);
    });
  }
}

const sessions = shared("streamSessions", () => new Map<string, StreamSession>());

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
  return session;
}

export type { StreamSession };
