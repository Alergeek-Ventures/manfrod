import { AsyncLocalStorage } from "node:async_hooks";

export interface SlackTarget {
  channelId: string;
  threadTs?: string;
}

export interface HandoffAuth {
  authenticator: string;
  principalType: string;
  principalId: string;
  attributes: Record<string, string | string[]>;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

export interface SessionEvent {
  type: string;
  data?: Record<string, unknown>;
}

export interface AgentRuntime {
  sendToSlack(target: SlackTarget, message: string, auth: HandoffAuth): Promise<unknown>;
  startHeadless(address: string, message: string, auth: HandoffAuth, history: HistoryMessage[]): Promise<string>;
  sessionEvents(sessionId: string): Promise<SessionEvent[]>;
  endSession(sessionId: string): Promise<void>;
  waitUntil(task: Promise<unknown>): void;
}

const storage = new AsyncLocalStorage<AgentRuntime>();

export function withAgentRuntime<T>(runtime: AgentRuntime, run: () => Promise<T>): Promise<T> {
  return storage.run(runtime, run);
}

export function agentRuntime(): AgentRuntime {
  const runtime = storage.getStore();
  if (!runtime) throw new Error("agent runtime is only available inside the jobs channel");
  return runtime;
}
