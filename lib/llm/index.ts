import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { APICallError, generateText as aiGenerateText, type LanguageModelUsage, type ModelMessage, type ToolSet } from "ai";
import { config } from "../config.ts";
import { emit } from "../events/index.ts";
import { cost } from "../pricing.ts";

export const PRIMARY_MODEL = "openai/gpt-5.6-luna";
export const FAST_MODEL = "anthropic/claude-haiku-5.5";
export const BRAIN_MODEL = "anthropic/claude-opus-5.5";
export const AGENT_MODEL = "anthropic/claude-sonnet-5.5";
export const MEMORY_MODEL = AGENT_MODEL;

interface ChainEntry {
  provider: "openrouter";
  model: string;
  tier: "paid" | "free";
}

export const FALLBACK_CHAIN: ChainEntry[] = [
  { provider: "openrouter", model: PRIMARY_MODEL, tier: "paid" },
  { provider: "openrouter", model: FAST_MODEL, tier: "paid" },
];

export const MEMORY_CHAIN: ChainEntry[] = [{ provider: "openrouter", model: MEMORY_MODEL, tier: "paid" }, ...FALLBACK_CHAIN];

const TIMEOUT_MS = 180_000;
const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1_000;
const SIMPLE_MAX_RETRIES = 3;
const SIMPLE_INITIAL_DELAY_MS = 500;

export interface Attribution {
  userId?: string | null;
  sessionKey?: string | null;
}

export interface GenerateOptions extends Attribution {
  purpose: string;
  chain?: ChainEntry[];
  tools?: ToolSet;
  system?: string;
}

export function openrouterProvider() {
  return createOpenRouter({ apiKey: config.openrouterApiKey, compatibility: "strict" });
}

export function chatModel(modelId: string) {
  return openrouterProvider().chat(modelId, { usage: { include: true } });
}

class EmptyResponseError extends Error {
  constructor() {
    super("Model returned an empty response");
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryable(error: unknown): boolean {
  if (error instanceof EmptyResponseError) return true;
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status === undefined) return true;
    return [429, 500, 502, 503, 504].includes(status);
  }
  if (error instanceof Error) {
    const name = error.name;
    return name === "AbortError" || name === "TimeoutError" || /fetch failed|ECONNRESET|ETIMEDOUT|socket|network/i.test(error.message);
  }
  return false;
}

export function formatError(error: unknown): string {
  if (error instanceof EmptyResponseError) return "Model returned an empty response";
  if (APICallError.isInstance(error)) {
    let message = error.message;
    try {
      const body = JSON.parse(error.responseBody ?? "");
      message = body?.error?.message ?? body?.message ?? message;
    } catch {}
    return error.statusCode ? `HTTP ${error.statusCode}: ${message}` : message;
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "Request timeout";
    return `Transport error: ${error.message}`;
  }
  return String(error);
}

export function usageMeta(
  model: string,
  provider: string,
  tier: string,
  purpose: string,
  latencyMs: number,
  usage: LanguageModelUsage | undefined,
) {
  const tokens = {
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
    cached_tokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
    cache_creation_tokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
  return {
    model,
    provider,
    tier,
    purpose,
    latency_ms: latencyMs,
    total_tokens: usage?.totalTokens ?? null,
    cost_usd: cost(model, tokens),
    ...tokens,
  };
}

function event(attribution: Attribution, meta: Record<string, unknown>) {
  return { userId: attribution.userId ?? null, sessionKey: attribution.sessionKey ?? null, source: "llm", meta };
}

type GenerateResult = Awaited<ReturnType<typeof aiGenerateText>>;

async function callOnce(entry: ChainEntry, messages: ModelMessage[], options: GenerateOptions): Promise<GenerateResult> {
  const hasTools = options.tools !== undefined && Object.keys(options.tools).length > 0;
  const result = await aiGenerateText({
    model: chatModel(entry.model),
    messages,
    allowSystemInMessages: true,
    system: options.system,
    tools: hasTools ? options.tools : undefined,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!hasTools && result.text.trim() === "") throw new EmptyResponseError();
  return result;
}

async function withRetries(entry: ChainEntry, messages: ModelMessage[], options: GenerateOptions): Promise<GenerateResult> {
  const attribution: Attribution = { userId: options.userId, sessionKey: options.sessionKey };
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    emit(
      "llm_call_started",
      event(attribution, {
        model: entry.model,
        provider: entry.provider,
        tier: entry.tier,
        purpose: options.purpose,
        attempt,
      }),
    );
    const started = Date.now();
    try {
      const result = await callOnce(entry, messages, options);
      emit(
        "llm_call_succeeded",
        event(attribution, usageMeta(entry.model, entry.provider, entry.tier, options.purpose, Date.now() - started, result.usage)),
      );
      return result;
    } catch (error) {
      lastError = error;
      emit(
        "llm_call_failed",
        event(attribution, {
          model: entry.model,
          provider: entry.provider,
          tier: entry.tier,
          purpose: options.purpose,
          attempt,
          error: formatError(error),
          latency_ms: Date.now() - started,
        }),
      );
      if (attempt < MAX_RETRIES && retryable(error)) {
        const delayMs = INITIAL_DELAY_MS * 2 ** (attempt - 1);
        emit(
          "llm_retry",
          event(attribution, {
            model: entry.model,
            provider: entry.provider,
            tier: entry.tier,
            purpose: options.purpose,
            attempt,
            delay_ms: delayMs,
            reason: formatError(error),
          }),
        );
        await sleep(delayMs);
        continue;
      }
      break;
    }
  }
  throw lastError;
}

export class AllModelsFailedError extends Error {
  constructor(readonly lastError: unknown) {
    super("all_models_failed");
  }
}

export async function generateText(messages: ModelMessage[], options: GenerateOptions): Promise<GenerateResult> {
  const attribution: Attribution = { userId: options.userId, sessionKey: options.sessionKey };
  let lastError: unknown;

  const chain = options.chain ?? FALLBACK_CHAIN;
  for (let index = 0; index < chain.length; index += 1) {
    const entry = chain[index];
    try {
      return await withRetries(entry, messages, options);
    } catch (error) {
      lastError = error;
      const next = chain[index + 1];
      if (next) {
        emit(
          "llm_fallback",
          event(attribution, {
            from_model: entry.model,
            from_provider: entry.provider,
            to_model: next.model,
            to_provider: next.provider,
            reason: formatError(error),
            purpose: options.purpose,
          }),
        );
      }
    }
  }
  throw new AllModelsFailedError(lastError);
}

export interface SimpleOptions extends Attribution {
  purpose: string;
  timeoutMs?: number;
}

export async function generateSimple(modelId: string, messages: ModelMessage[], options: SimpleOptions): Promise<string> {
  const attribution: Attribution = { userId: options.userId, sessionKey: options.sessionKey };
  const timeoutMs = options.timeoutMs ?? 30_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= SIMPLE_MAX_RETRIES; attempt += 1) {
    emit(
      "llm_call_started",
      event(attribution, {
        model: modelId,
        provider: "openrouter",
        tier: "free",
        purpose: options.purpose,
        attempt,
      }),
    );
    const started = Date.now();
    try {
      const result = await aiGenerateText({
        model: chatModel(modelId),
        messages,
        allowSystemInMessages: true,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
      emit(
        "llm_call_succeeded",
        event(attribution, usageMeta(modelId, "openrouter", "free", options.purpose, Date.now() - started, result.usage)),
      );
      return result.text;
    } catch (error) {
      lastError = error;
      emit(
        "llm_call_failed",
        event(attribution, {
          model: modelId,
          provider: "openrouter",
          tier: "free",
          purpose: options.purpose,
          attempt,
          error: formatError(error),
          latency_ms: Date.now() - started,
        }),
      );
      if (attempt < SIMPLE_MAX_RETRIES && retryable(error)) {
        const delayMs = SIMPLE_INITIAL_DELAY_MS * 2 ** (attempt - 1);
        emit(
          "llm_retry",
          event(attribution, {
            model: modelId,
            provider: "openrouter",
            tier: "free",
            purpose: options.purpose,
            attempt,
            delay_ms: delayMs,
            reason: formatError(error),
          }),
        );
        await sleep(delayMs);
        continue;
      }
      break;
    }
  }
  throw lastError;
}

export const system = (content: string): ModelMessage => ({ role: "system", content });
export const user = (content: string): ModelMessage => ({ role: "user", content });
export const assistant = (content: string): ModelMessage => ({ role: "assistant", content });
