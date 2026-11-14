import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { MessageFeedback } from "../db/schema.ts";
import { accessOverlaps } from "../memory/access.ts";

const { auditEvents, nodes } = tables;
const EVENT_WINDOW_MS = 86_400_000;
const NOTE_CHARS = 600;

export const MEMORY_VERDICTS = ["helped", "wrong", "missing", "unrelated"] as const;
export type MemoryVerdict = (typeof MEMORY_VERDICTS)[number];

export interface ContextEvent {
  kind?: "turn" | "tool";
  note_ids?: string[];
  readable_levels?: string[];
  at?: string;
}

const MAX_NOTES = 30;

export function contextForReply(events: ContextEvent[], ratedAt: Date): ContextEvent[] {
  const earlier = events
    .filter((event) => event.at && new Date(event.at).getTime() <= ratedAt.getTime())
    .sort((a, b) => a.at!.localeCompare(b.at!));
  const turnStart = earlier.findLastIndex((event) => event.kind !== "tool");
  return turnStart === -1 ? [] : earlier.slice(turnStart);
}

async function readable(event: ContextEvent): Promise<Map<string, string>> {
  const ids = event.note_ids ?? [];
  const levels = event.readable_levels ?? [];
  if (ids.length === 0 || levels.length === 0) return new Map();
  const found = await db
    .select({ id: nodes.id, content: nodes.content })
    .from(nodes)
    .where(and(inArray(nodes.id, ids), accessOverlaps(nodes.access, levels)));
  return new Map(found.map((node) => [node.id, node.content]));
}

export async function memoryShown(feedback: MessageFeedback, ratedAt: Date): Promise<string | null> {
  if (!feedback.sessionKey) return null;
  const rows = await db
    .select({ meta: auditEvents.meta })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.type, "memory_context"),
        sql`${auditEvents.meta}->>'session_key' = ${feedback.sessionKey}`,
        gte(auditEvents.timestamp, new Date(ratedAt.getTime() - EVENT_WINDOW_MS)),
        lte(auditEvents.timestamp, new Date(ratedAt.getTime() + EVENT_WINDOW_MS)),
      ),
    );
  const events = contextForReply(
    rows.map((row) => (row.meta ?? {}) as ContextEvent),
    ratedAt,
  );
  if (events.length === 0) return null;
  const contents = new Map<string, string | null>();
  for (const event of events) {
    const found = await readable(event);
    for (const id of event.note_ids ?? []) if (!contents.get(id)) contents.set(id, found.get(id) ?? null);
  }
  if (contents.size === 0) return "(no notes)";
  const lines = [...contents.values()].slice(0, MAX_NOTES).map((content) => {
    if (content === null) return "- (this note is no longer available)";
    return `- ${JSON.stringify(content.length > NOTE_CHARS ? `${content.slice(0, NOTE_CHARS)}…` : content)}`;
  });
  return lines.join("\n");
}
