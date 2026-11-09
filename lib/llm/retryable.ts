import type { LanguageModelMiddleware } from "ai";

const UPSTREAM_ERROR = /provider returned error/i;
const SILENT_PARTS: ReadonlySet<string> = new Set(["stream-start", "response-metadata", "raw"]);

export class RetryableProviderError extends Error {
  readonly isRetryable = true;

  constructor(cause: unknown) {
    super(messageOf(cause) ?? "Provider returned error", { cause });
    this.name = "RetryableProviderError";
  }
}

function messageOf(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return typeof error === "string" ? error : undefined;
}

export function isUpstreamProviderError(error: unknown): boolean {
  const message = messageOf(error);
  return message !== undefined && UPSTREAM_ERROR.test(message);
}

function markRetryable(error: unknown): unknown {
  return isUpstreamProviderError(error) ? new RetryableProviderError(error) : error;
}

export const retryUpstreamErrors: LanguageModelMiddleware = {
  async wrapGenerate({ doGenerate }) {
    try {
      return await doGenerate();
    } catch (error) {
      throw markRetryable(error);
    }
  },

  async wrapStream({ doStream }) {
    let result: Awaited<ReturnType<typeof doStream>>;
    try {
      result = await doStream();
    } catch (error) {
      throw markRetryable(error);
    }
    let emitted = false;
    const stream = result.stream.pipeThrough(
      new TransformStream({
        transform(part, controller) {
          if (part.type === "error") {
            controller.enqueue(emitted ? part : { ...part, error: markRetryable(part.error) });
            return;
          }
          if (!SILENT_PARTS.has(part.type)) emitted = true;
          controller.enqueue(part);
        },
      }),
    );
    return { ...result, stream };
  },
};
