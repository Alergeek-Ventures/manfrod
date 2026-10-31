import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { experimental_decide as decide, type ModelMessage } from "ai";
import { config } from "../config.ts";
import { AGENT_MODEL, BRAIN_MODEL, openrouterProvider } from "../llm/index.ts";
import { logger } from "../log.ts";
import { TIME_NOTE_HEADER } from "./prompts.ts";

const log = logger("ModelRouter");

export const CONTEXT_WINDOW_TOKENS = 272_000;
const TRANSCRIPT_MESSAGES = 6;
const MESSAGE_LIMIT = 1_200;

const ROUTES = {
  sonnet: {
    model: AGENT_MODEL,
    fallback: BRAIN_MODEL,
    criteria:
      "Default. Small talk, greetings and thanks, normal conversation, questions about the team, projects or memory, and lighter tasks with one or two tool calls such as setting a reminder, booking a desk, searching notes or reading a thread.",
  },
  opus: {
    model: BRAIN_MODEL,
    fallback: AGENT_MODEL,
    criteria:
      "Complex work that needs careful judgment: multi-step tasks chaining several tools, planning, analysis or summaries across many messages, ambiguous or high-stakes requests (anything about clients, money, people's access or deleting things), debugging, writing or reviewing long documents, and reorganising memory. Also requests that need follow-through over time beyond this reply, such as collecting answers from several people, chasing something until it happens or keeping an eye on something for days, checks of long-running tasks, and setting up recurring jobs that do more than send someone a message.",
  },
} as const;

const DEFAULT_ROUTE: Route = "sonnet";

export type Route = keyof typeof ROUTES;

export const MAX_STEPS_PER_TURN = 40;
const STEP_WARNING_AT = 25;

const turns = new Map<string, { userMessages: number; route: Route; steps: number }>();

export class StepBudgetExceededError extends Error {
  constructor(sessionId: string) {
    super(`Turn in session ${sessionId} exceeded ${MAX_STEPS_PER_TURN} model steps and was stopped`);
    this.name = "StepBudgetExceededError";
  }
}

function text(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join(" ")
    .trim();
}

function transcript(messages: readonly ModelMessage[]): string {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role, content: text(message) }))
    .filter((message) => message.content !== "" && !message.content.startsWith(TIME_NOTE_HEADER))
    .slice(-TRANSCRIPT_MESSAGES)
    .map((message) => `${message.role === "user" ? "User" : "Manfrod"}: ${message.content.slice(-MESSAGE_LIMIT)}`)
    .join("\n");
}

export async function chooseRoute(messages: readonly ModelMessage[]): Promise<Route> {
  if (!config.typesafeApiKey) return DEFAULT_ROUTE;
  try {
    const result = await decide({
      model: typeSafeAi.decisionModel(config.decisionModel),
      state: { conversation: transcript(messages) },
      questions: {
        model: {
          type: "choice",
          instructions: "Which model should handle the assistant's next turn? Pick opus only when the turn clearly needs it.",
          criteria: Object.fromEntries(Object.entries(ROUTES).map(([key, route]) => [key, route.criteria])) as Record<Route, string>,
        },
      },
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(5_000),
    });
    return result.answers.model.choice as Route;
  } catch (error) {
    log.warn(`ModelRouter: decision failed, using ${DEFAULT_ROUTE}: ${(error as Error).message}`);
    return DEFAULT_ROUTE;
  }
}

export async function routeStep(sessionId: string, messages: readonly ModelMessage[]) {
  const userMessages = messages.filter((message) => message.role === "user").length;
  let current = turns.get(sessionId);
  if (!current || current.userMessages !== userMessages) {
    current = { userMessages, route: await chooseRoute(messages), steps: 0 };
    turns.set(sessionId, current);
    log.info(`ModelRouter: ${sessionId} → ${current.route}`);
  }
  current.steps += 1;
  if (current.steps > MAX_STEPS_PER_TURN) {
    log.error(`ModelRouter: ${sessionId} hit the ${MAX_STEPS_PER_TURN}-step limit on ${current.route}, stopping the turn`);
    throw new StepBudgetExceededError(sessionId);
  }
  if (current.steps === STEP_WARNING_AT)
    log.warn(`ModelRouter: ${sessionId} is at step ${STEP_WARNING_AT} of this turn on ${current.route}`);
  return {
    model: openrouterProvider().chat(ROUTES[current.route].model, {
      usage: { include: true },
      models: [ROUTES[current.route].fallback],
    }),
    modelContextWindowTokens: CONTEXT_WINDOW_TOKENS,
    modelOptions: { promptCache: { anthropic: {} } },
  };
}
