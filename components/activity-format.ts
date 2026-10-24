export interface ActivityView {
  id: string;
  type: string;
  source: string | null;
  userId: string | null;
  meta: Record<string, any>;
  timestamp: string;
}

const truncate = (value: unknown, max: number): string => {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
};

export const formatTime = (iso: string) => iso.slice(11, 19);

export type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

const MEMORY_TYPES = new Set([
  "memory_searched",
  "memory_node_created",
  "memory_link_created",
  "memory_node_processed",
  "extraction_started",
  "extraction_completed",
  "retrospection_started",
  "retrospection_completed",
]);

export function typeVariant(event: ActivityView): BadgeVariant {
  const { type, meta } = event;
  if (type === "log") return meta.level === "error" || meta.level === "warning" ? "destructive" : "outline";
  if (type === "feedback_received") return meta.rating === "bad" ? "destructive" : "default";
  if (type === "action_completed") return meta.success === false ? "destructive" : "default";
  if (["extraction_failed", "retrospection_failed", "llm_call_failed"].includes(type)) return "destructive";
  if (["responding", "llm_call_succeeded", "message_received"].includes(type)) return "default";
  if (MEMORY_TYPES.has(type) || ["thinking", "narrating", "action_started", "llm_call_started", "llm_retry", "llm_fallback"].includes(type)) {
    return "secondary";
  }
  return "outline";
}

const TYPE_LABELS: Record<string, string> = {
  message_received: "MESSAGE",
  action_started: "ACTION:START",
  action_completed: "ACTION:DONE",
  thinking: "THINKING",
  narrating: "NARRATING",
  responding: "RESPONDING",
  feedback_received: "FEEDBACK",
  plan_titled: "PLAN",
  idle: "IDLE",
  memory_searched: "MEMORY:SEARCH",
  memory_node_created: "MEMORY:CREATE",
  memory_link_created: "MEMORY:LINK",
  memory_node_processed: "MEMORY:PROCESS",
  extraction_started: "EXTRACT:START",
  extraction_completed: "EXTRACT:DONE",
  extraction_failed: "EXTRACT:FAIL",
  retrospection_started: "RETROSPECT:START",
  retrospection_completed: "RETROSPECT:DONE",
  retrospection_failed: "RETROSPECT:FAIL",
  llm_call_started: "LLM:START",
  llm_call_succeeded: "LLM:OK",
  llm_call_failed: "LLM:FAIL",
  llm_retry: "LLM:RETRY",
  llm_fallback: "LLM:FALLBACK",
};

export function formatType(event: ActivityView): string {
  if (event.type === "log") return String(event.meta.level ?? "log").toUpperCase();
  return TYPE_LABELS[event.type] ?? event.type.toUpperCase();
}

const tierBadge = (meta: Record<string, any>) => (meta.tier === "paid" ? "[PAID] " : "");
const formatTokens = (input: unknown, output: unknown) =>
  input === undefined && output === undefined ? "" : `(${input ?? 0}→${output ?? 0} tok)`;

export function formatDetail(event: ActivityView): string {
  const { type, meta } = event;
  switch (type) {
    case "message_received":
      return truncate(meta.content, 100);
    case "action_started":
      return `${meta.action} ${truncate(meta.args, 80)}`;
    case "action_completed":
      return `${meta.duration_ms ?? 0}ms ${truncate(meta.result ?? "", 60)}`;
    case "log":
      return truncate(meta.message, 120);
    case "narrating":
      return truncate(meta.text, 120);
    case "responding":
      return truncate(meta.content, 120);
    case "plan_titled":
      return String(meta.title ?? "");
    case "feedback_received":
      return meta.rating === "good" ? "👍 dobra odpowiedź" : "👎 słaba odpowiedź";
    case "idle":
      return "conversation timeout";
    case "llm_call_started":
      return `${tierBadge(meta)}${meta.provider}/${meta.model} (${meta.purpose})`;
    case "llm_call_succeeded":
      return `${tierBadge(meta)}${meta.provider}/${meta.model} ${meta.latency_ms}ms ${formatTokens(meta.input_tokens, meta.output_tokens)}`;
    case "llm_call_failed":
      return `${meta.provider}/${meta.model} attempt ${meta.attempt}: ${meta.error}`;
    case "llm_retry":
      return `${meta.provider}/${meta.model} retry #${meta.attempt} in ${meta.delay_ms}ms`;
    case "llm_fallback":
      return `${meta.from_provider}/${meta.from_model} → ${meta.to_provider}/${meta.to_model}`;
    default:
      return Object.keys(meta).length > 0 ? truncate(meta, 200) : "";
  }
}

function prettyJson(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

function memorySearched(meta: Record<string, any>): string {
  const query = meta.query ?? meta.query_preview ?? "?";
  const expanded = meta.expanded_queries;
  const stats = meta.stats ?? {};
  let queries = "";
  if (Array.isArray(expanded) && expanded.length > 0) {
    queries = `\nExpanded queries:\n${expanded.map((value: string, index: number) => `  ${index + 1}. ${value}`).join("\n")}`;
  } else if (typeof expanded === "number") {
    queries = `\nExpanded queries: ${expanded}`;
  }
  let pipeline: string;
  if (Object.keys(stats).length > 0) {
    const filteredOut = (stats.merged ?? 0) - (stats.filtered ?? 0);
    pipeline = `

Pipeline:
  Query expansion: ${stats.expand_query_enabled ? "yes" : "no"}
  Vector search: ${stats.vector ?? 0} results
  BM25 search: ${stats.bm25 ?? 0} results
  RRF merged: ${stats.merged ?? 0} unique
  Reranked: ${stats.rerank_ran ? "yes" : "no"} (${stats.reranked ?? 0} candidates)
  Filtered (threshold ${stats.relevance_threshold ?? "?"}): ${stats.filtered ?? 0} passed, ${filteredOut} dropped
  Final (with links): ${stats.final ?? 0} results
`;
  } else {
    pipeline = `\nResults: ${meta.result_count ?? 0}`;
  }
  const scores = meta.rerank_scores;
  let rerank = "";
  if (Array.isArray(scores) && scores.length > 0) {
    rerank = `\nRerank scores:\n${scores
      .map((entry: Record<string, any>) => `  ${Number(entry.score ?? 0).toFixed(3)}  "${entry.content_preview ?? ""}..."`)
      .join("\n")}`;
  } else if (stats.rerank_ran === false && stats.rerank_enabled) {
    rerank = "\nRerank scores: skipped (< 2 candidates)";
  }
  return `Query: ${query}${queries}${pipeline}${rerank}`;
}

export function formatExpanded(event: ActivityView): string {
  const { type, meta } = event;
  switch (type) {
    case "action_started":
      return `Action: ${meta.action}\nArgs: ${prettyJson(meta.args)}\n`;
    case "action_completed":
      return `Duration: ${meta.duration_ms}ms\nSuccess: ${meta.success}\nResult:\n${meta.result}\n`;
    case "log":
      return [
        `Message: ${meta.message}`,
        meta.module && `Module: ${meta.module}`,
        meta.function && `Function: ${meta.function}`,
        meta.file && `File: ${meta.file}:${meta.line}`,
        meta.crash_reason && `\nCrash Reason: ${meta.crash_reason}`,
        meta.stacktrace && `\nStacktrace:\n${meta.stacktrace}`,
      ]
        .filter(Boolean)
        .join("\n");
    case "message_received":
      return `Content: ${meta.content}\nFrom: ${meta.from_id ?? ""}\nChat: ${meta.chat_id ?? ""}\n`;
    case "responding":
      return String(meta.content ?? "");
    case "narrating":
      return String(meta.text ?? "");
    case "llm_call_succeeded":
      return `Provider: ${meta.provider}\nModel: ${meta.model}\nTier: ${meta.tier}\nPurpose: ${meta.purpose}\nLatency: ${meta.latency_ms}ms\nInput tokens: ${meta.input_tokens ?? "N/A"}\nOutput tokens: ${meta.output_tokens ?? "N/A"}\nTotal tokens: ${meta.total_tokens ?? "N/A"}\n`;
    case "llm_call_failed":
      return `Provider: ${meta.provider}\nModel: ${meta.model}\nTier: ${meta.tier}\nPurpose: ${meta.purpose}\nAttempt: ${meta.attempt}\nLatency: ${meta.latency_ms}ms\nError: ${meta.error}\n`;
    case "llm_fallback":
      return `From: ${meta.from_provider}/${meta.from_model}\nTo: ${meta.to_provider}/${meta.to_model}\nPurpose: ${meta.purpose}\nReason: ${meta.reason}\n`;
    case "llm_call_started":
      return `Provider: ${meta.provider}\nModel: ${meta.model}\nTier: ${meta.tier}\nPurpose: ${meta.purpose}\nAttempt: ${meta.attempt}\n`;
    case "llm_retry":
      return `Provider: ${meta.provider}\nModel: ${meta.model}\nTier: ${meta.tier}\nPurpose: ${meta.purpose}\nAttempt: ${meta.attempt}\nDelay: ${meta.delay_ms}ms\nReason: ${meta.reason}\n`;
    case "extraction_started":
      return `Messages to process: ${meta.message_count}`;
    case "extraction_completed":
      return `Conversation ID: ${meta.conversation_id}\nNodes created: ${meta.node_count}\nSummary: ${meta.summary_preview}\n`;
    case "extraction_failed":
    case "retrospection_failed":
      return `Reason: ${meta.reason}`;
    case "retrospection_started":
      return `Slipbox nodes: ${meta.slipbox_count}\nReview sample: ${meta.review_count}\n`;
    case "retrospection_completed":
      return `Nodes processed: ${meta.nodes_processed}\nLinks created: ${meta.links_created}\nInsights created: ${meta.insights_created}\nNodes deleted: ${meta.nodes_deleted}\nLinks deleted: ${meta.links_deleted}\n`;
    case "memory_searched":
      return memorySearched(meta);
    case "memory_node_created":
      return `Node ID: ${meta.node_id}\nContent: ${meta.content_preview}\n`;
    case "memory_link_created":
      return `Link: ${meta.node_a_id} <-> ${meta.node_b_id}`;
    case "memory_node_processed":
      return `Node ID: ${meta.node_id}`;
    default:
      return JSON.stringify(meta, null, 2);
  }
}
