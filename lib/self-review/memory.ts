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
  note_ids?: string[];
  readable_levels?: string[];
  at?: string;
}

export function contextBefore(events: ContextEvent[], ratedAt: Date): ContextEvent | null {
  const earlier = events.filter((event) => event.at && new Date(event.at).getTime() <= ratedAt.getTime());
  return earlier.sort((a, b) => b.at!.localeCompare(a.at!))[0] ?? null;
}

export async function memoryShown(feedback: MessageFeedback, ratedAt: Date): Promise<string | null> {
  if (!feedback.sessionKey) return null;
  const rows = await db
    .select({ meta: auditEvents.meta })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.type, "memory_context"),
        gte(auditEvents.timestamp, new Date(ratedAt.getTime() - EVENT_WINDOW_MS)),
        lte(auditEvents.timestamp, new Date(ratedAt.getTime() + EVENT_WINDOW_MS)),
        sql`${auditEvents.meta}->>'session_key' = ${feedback.sessionKey}`,
      ),
    );
  const event = contextBefore(
    rows.map((row) => (row.meta ?? {}) as ContextEvent),
    ratedAt,
  );
  if (!event) return null;
  const ids = event.note_ids ?? [];
  const levels = event.readable_levels ?? [];
  if (ids.length === 0 || levels.length === 0) return "(no notes)";
  const found = await db
    .select({ id: nodes.id, content: nodes.content })
    .from(nodes)
    .where(and(inArray(nodes.id, ids), accessOverlaps(nodes.access, levels)));
  const byId = new Map(found.map((node) => [node.id, node.content]));
  const lines = ids.map((id) => {
    const content = byId.get(id);
    if (content === undefined) return "- (this note is no longer available)";
    return `- ${content.length > NOTE_CHARS ? `${content.slice(0, NOTE_CHARS)}…` : content}`;
  });
  return lines.join("\n");
}
