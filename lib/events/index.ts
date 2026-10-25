import { db, tables } from "../db/index.ts";

export type ActivityType =
  | "message_received"
  | "action_started"
  | "action_completed"
  | "thinking"
  | "narrating"
  | "plan_titled"
  | "response_chunk"
  | "responding"
  | "reacted"
  | "interrupted"
  | "idle"
  | "feedback_received"
  | "log"
  | "memory_searched"
  | "memory_node_created"
  | "memory_node_updated"
  | "memory_node_deleted"
  | "memory_node_escalated"
  | "memory_link_created"
  | "memory_link_deleted"
  | "memory_node_processed"
  | "unmapped_channel_seen"
  | "sensitive_content_detected"
  | "extraction_started"
  | "extraction_completed"
  | "extraction_failed"
  | "retrospection_started"
  | "retrospection_completed"
  | "retrospection_failed"
  | "recurring_reminder_created"
  | "recurring_reminder_updated"
  | "recurring_reminder_deleted"
  | "llm_call_started"
  | "llm_call_succeeded"
  | "llm_call_failed"
  | "llm_retry"
  | "llm_fallback"
  | "secret_used"
  | "secret_updated"
  | "secret_deleted";

export interface ActivityAttrs {
  userId?: string | null;
  sessionKey?: string | null;
  source?: string | null;
  meta?: Record<string, unknown>;
}

export interface Activity {
  id: string;
  type: string;
  source: string | null;
  userId: string | null;
  meta: Record<string, unknown>;
  timestamp: Date;
}

const EPHEMERAL: ReadonlySet<string> = new Set(["response_chunk"]);

function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, jsonSafe(inner)]));
  }
  return value;
}

export async function broadcast(type: ActivityType, attrs: ActivityAttrs = {}): Promise<void> {
  if (EPHEMERAL.has(type)) return;

  const meta = { ...(attrs.meta ?? {}) };
  if (attrs.sessionKey && meta.session_key === undefined) meta.session_key = attrs.sessionKey;

  try {
    await db.insert(tables.auditEvents).values({
      type,
      source: attrs.source ?? null,
      meta: jsonSafe(meta) as Record<string, unknown>,
      timestamp: new Date(),
      userId: attrs.userId ?? null,
    });
  } catch (error) {
    console.warn(`[warning] Failed to persist activity ${type}: ${(error as Error).message}`);
  }
}

export function emit(type: ActivityType, attrs: ActivityAttrs = {}): void {
  void broadcast(type, attrs);
}

export function toActivity(row: typeof tables.auditEvents.$inferSelect): Activity {
  return {
    id: row.id,
    type: row.type,
    source: row.source,
    userId: row.userId,
    meta: (row.meta ?? {}) as Record<string, unknown>,
    timestamp: row.timestamp,
  };
}
