import { describe, expect, it } from "vitest";
import { isUpstreamProviderError, RetryableProviderError, retryUpstreamErrors } from "../../lib/llm/retryable.ts";

type Part = { type: string; [key: string]: unknown };

function fakeStream(parts: Part[]) {
  return async () => ({
    stream: new ReadableStream<Part>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  });
}

async function collect(parts: Part[]): Promise<Part[]> {
  const result = await retryUpstreamErrors.wrapStream!({ doStream: fakeStream(parts) } as never);
  const out: Part[] = [];
  const reader = (result.stream as ReadableStream<Part>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

const upstream = { message: "Provider returned error", code: 400, metadata: { provider_name: "Anthropic" } };

describe("retryUpstreamErrors", () => {
  it("recognises OpenRouter upstream errors only", () => {
    expect(isUpstreamProviderError(upstream)).toBe(true);
    expect(isUpstreamProviderError(new Error("Provider returned error"))).toBe(true);
    expect(isUpstreamProviderError(new Error("Invalid API key"))).toBe(false);
    expect(isUpstreamProviderError(null)).toBe(false);
  });

  it("marks an upstream error before any output as retryable", async () => {
    const parts = await collect([
      { type: "stream-start", warnings: [] },
      { type: "response-metadata" },
      { type: "error", error: upstream },
    ]);
    const error = parts.at(-1)?.error;
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect((error as RetryableProviderError).isRetryable).toBe(true);
    expect((error as RetryableProviderError).cause).toBe(upstream);
  });

  it("leaves an upstream error after streamed output untouched", async () => {
    const parts = await collect([
      { type: "text-delta", id: "t", delta: "hej" },
      { type: "error", error: upstream },
    ]);
    expect(parts.at(-1)?.error).toBe(upstream);
  });

  it("leaves other stream errors untouched", async () => {
    const other = { message: "Invalid request", code: 400 };
    const parts = await collect([{ type: "error", error: other }]);
    expect(parts.at(-1)?.error).toBe(other);
  });

  it("marks an upstream error thrown when the stream opens", async () => {
    const call = retryUpstreamErrors.wrapStream!({
      doStream: async () => {
        throw new Error("Provider returned error");
      },
    } as never);
    await expect(call).rejects.toBeInstanceOf(RetryableProviderError);
  });

  it("marks an upstream error from a non-streaming call", async () => {
    const call = retryUpstreamErrors.wrapGenerate!({
      doGenerate: async () => {
        throw upstream;
      },
    } as never);
    await expect(call).rejects.toMatchObject({ isRetryable: true });
  });
});
