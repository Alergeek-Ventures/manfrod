import { TASK_KIND, turnThread, type ToolCtx } from "../agent/context.ts";
import { SELF_REVIEW_KIND } from "../self-review/rules.ts";
import { post } from "./api.ts";
import { createElementScanner } from "./card-scan.ts";
import { createCardBuilder, isRichBlock, plainBlocks, type CardWarning, type DroppedElement } from "./cards.ts";
import { shared, TtlMap } from "./state.ts";
import { sendBlocks, type BlockDelivery } from "./stream.ts";

const CALL_TTL_MS = 15 * 60 * 1000;
const STREAM_GRACE_MS = 1500;
const DELIVERY_WAIT_MS = 8000;
const IN_FLIGHT_WAIT_MS = 5000;
const NOTIFICATION_TEXT_LIMIT = 150;

type Block = Record<string, unknown>;

interface StreamedPart {
  element: number;
  delivery: BlockDelivery;
}

interface CardCall {
  scan: ReturnType<typeof createElementScanner>;
  add: ReturnType<typeof createCardBuilder>;
  seen: number;
  parts: StreamedPart[];
  turnId: string | null;
}

export interface CardThread {
  channel: string;
  threadTs: string;
}

export interface StreamedBatch {
  blocks: { type: string; length: number }[];
  dropped: number;
}

export interface CardOutcome {
  streamed: number;
  posted: number;
  degraded: number;
  dropped: DroppedElement[];
  warnings: CardWarning[];
  error: string | null;
}

const calls = shared("cardCalls", () => new TtlMap<string, CardCall>(CALL_TTL_MS));
const finishedCalls = shared("finishedCardCalls", () => new TtlMap<string, true>(CALL_TTL_MS));

function finish(callId: string): CardCall | undefined {
  const call = calls.get(callId);
  calls.delete(callId);
  finishedCalls.set(callId, true);
  return call;
}

export function cardRefusal(kind: string): string | null {
  if (kind === SELF_REVIEW_KIND) return "Self-review can't post on Slack.";
  if (kind === TASK_KIND) return "Cards are not shown in task runs; write to the thread with post-slack-message.";
  return null;
}

export function cardStreamThread(tool: ToolCtx): CardThread | null {
  if (tool.kind !== "slack") return null;
  const { channel, threadTs } = turnThread(tool);
  return channel && threadTs ? { channel, threadTs } : null;
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

export function streamCardInput(callId: string, thread: CardThread, delta: string, turnId: string | null = null): StreamedBatch | null {
  if (finishedCalls.has(callId)) return null;
  let call = calls.get(callId);
  if (!call) {
    call = { scan: createElementScanner(), add: createCardBuilder(), seen: 0, parts: [], turnId };
    calls.set(callId, call);
  }
  const completed = call.scan(delta);
  if (completed.length === 0) return null;
  const blocks: Block[] = [];
  for (const json of completed) {
    const element = call.seen;
    call.seen += 1;
    const step = call.add(parseJson(json));
    if (!("block" in step)) continue;
    blocks.push(step.block);
    call.parts.push({ element, delivery: sendBlocks(thread.channel, thread.threadTs, [step.block]) });
  }
  return {
    blocks: blocks.map((block) => ({ type: String(block.type), length: JSON.stringify(block).length })),
    dropped: completed.length - blocks.length,
  };
}

function within(promise: Promise<boolean>, ms: number): Promise<boolean | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function settle(delivery: BlockDelivery): Promise<boolean> {
  const early = await within(delivery.delivered, STREAM_GRACE_MS);
  if (early !== null) return early;
  if (delivery.waitingForStream() && delivery.cancel()) return false;
  const late = await within(delivery.delivered, DELIVERY_WAIT_MS);
  if (late !== null) return late;
  if (delivery.cancel()) return false;
  return (await within(delivery.delivered, IN_FLIGHT_WAIT_MS)) ?? true;
}

async function streamedElements(callId: string): Promise<Set<number>> {
  const call = finish(callId);
  const streamed = new Set<number>();
  if (!call) return streamed;
  await Promise.all(
    call.parts.map(async (part) => {
      if (await settle(part.delivery)) streamed.add(part.element);
    }),
  );
  return streamed;
}

export function cancelCardCall(callId: string) {
  for (const part of finish(callId)?.parts ?? []) part.delivery.cancel();
}

export function endCardTurn(turnId: string) {
  for (const callId of calls.keys()) {
    if (calls.get(callId)?.turnId === turnId) cancelCardCall(callId);
  }
}

const isObject = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value);

function elementType(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function blockText(block: Block): unknown {
  if (block.type === "data_visualization") return block.title;
  if (block.type === "layout") return block.label;
  return (block.text as { text?: unknown } | undefined)?.text;
}

function notificationText(blocks: Block[]): string {
  for (const block of blocks) {
    const text = blockText(block);
    if (typeof text === "string" && text.trim() !== "") return text.slice(0, NOTIFICATION_TEXT_LIMIT);
  }
  return "Card";
}

const isInvalidBlocks = (error: string) => error.startsWith("invalid_blocks");

function postBlocks(channel: string, threadTs: string | null | undefined, blocks: Block[]) {
  return post("chat.postMessage", {
    channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text: notificationText(blocks),
    blocks,
  });
}

async function postCard(channel: string, threadTs: string | null | undefined, blocks: Block[]) {
  const result = await postBlocks(channel, threadTs, blocks);
  const rich = blocks.filter(isRichBlock).length;
  if (result.ok || rich === 0 || !isInvalidBlocks(result.error)) return { result, degraded: 0 };
  return { result: await postBlocks(channel, threadTs, plainBlocks(blocks)), degraded: rich };
}

export async function showCard(callId: string, elements: unknown[], tool: ToolCtx): Promise<CardOutcome> {
  const { channel, threadTs } = turnThread(tool);
  const streamed = await streamedElements(callId);
  const add = createCardBuilder();
  const unsent: Block[] = [];
  const dropped: DroppedElement[] = [];
  const warnings: CardWarning[] = [];
  let shown = 0;
  let objects = 0;
  elements.forEach((value, index) => {
    const element = isObject(value) ? objects++ : -1;
    const step = add(value);
    if (!("block" in step)) {
      dropped.push({ index, type: elementType(value), reason: step.reason });
      return;
    }
    if (step.warning) warnings.push({ index, type: elementType(value), message: step.warning });
    if (streamed.has(element)) shown += 1;
    else unsent.push(step.block);
  });
  const base = { streamed: shown, posted: 0, degraded: 0, dropped, warnings };
  if (unsent.length === 0) return { ...base, error: null };
  if (!channel) return { ...base, error: "there is no Slack conversation to show it in" };
  const { result, degraded } = await postCard(channel, threadTs, unsent);
  if (!result.ok) return { ...base, error: result.error };
  return { ...base, posted: unsent.length, degraded, error: null };
}

export function describeCardOutcome(outcome: CardOutcome): string {
  const lines: string[] = [];
  if (outcome.error) lines.push(`Could not post the card: ${outcome.error}.`);
  else if (outcome.streamed === 0 && outcome.posted === 0) lines.push("Nothing was shown: the card had no valid elements.");
  else if (outcome.posted === 0) lines.push("Card shown in your reply.");
  else if (outcome.streamed === 0) lines.push("Card posted in the thread.");
  else lines.push(`Card shown: ${outcome.streamed} block(s) in your reply, ${outcome.posted} posted separately in the thread.`);
  if (outcome.degraded > 0)
    lines.push(
      `Slack did not accept ${outcome.degraded} chart or columns element(s); they were posted as plain text or a table with the same data instead.`,
    );
  if (outcome.dropped.length > 0) {
    lines.push("Dropped elements (the person does not see them; mention or fix this in your reply, shown blocks cannot be removed):");
    for (const item of outcome.dropped) lines.push(`- elements[${item.index}]${item.type ? ` (${item.type})` : ""}: ${item.reason}`);
  }
  if (outcome.warnings.length > 0) {
    lines.push("Shown but cut short (mention what is missing in your reply):");
    for (const item of outcome.warnings) lines.push(`- elements[${item.index}]${item.type ? ` (${item.type})` : ""}: ${item.message}`);
  }
  return lines.join("\n");
}
