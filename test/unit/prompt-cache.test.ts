import { describe, expect, it } from "vitest";
import { system, user, withCacheBreakpoints } from "../../lib/llm/index.ts";

describe("withCacheBreakpoints", () => {
  const messages = [system("rules"), user("first"), user("last")];

  it("marks the system prompt and the newest message for Anthropic models", () => {
    const marked = withCacheBreakpoints("anthropic/claude-sonnet-5.5", messages);
    expect(marked.map((message) => Boolean(message.providerOptions?.openrouter))).toEqual([true, false, true]);
  });

  it("leaves other models alone", () => {
    expect(withCacheBreakpoints("openai/gpt-5.6-luna", messages)).toBe(messages);
  });
});
