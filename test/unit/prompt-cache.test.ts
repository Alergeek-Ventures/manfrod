import { describe, expect, it } from "vitest";
import { system, user, withCacheBreakpoints } from "../../lib/llm/index.ts";

describe("withCacheBreakpoints", () => {
  const messages = [system("rules"), user("first"), user("last")];

  it("marks the system prompt and the newest message for Anthropic models", () => {
    const marked = withCacheBreakpoints("anthropic/claude-sonnet-5.5", messages);
    expect(marked.map((message) => Boolean(message.providerOptions?.openrouter))).toEqual([true, false, true]);
  });

  it("marks only the last tool result when the newest message holds several", () => {
    const result = (toolCallId: string) => ({
      type: "tool-result" as const,
      toolCallId,
      toolName: "search",
      output: { type: "text" as const, value: "ok" },
    });
    const marked = withCacheBreakpoints("anthropic/claude-sonnet-5.5", [
      system("rules"),
      { role: "tool", content: [result("a"), result("b"), result("c"), result("d"), result("e")] },
    ]);
    const tool = marked[1]!;
    expect(tool.providerOptions?.openrouter).toBeUndefined();
    const parts = tool.role === "tool" ? tool.content : [];
    expect(parts.map((part) => part.type === "tool-result" && Boolean(part.providerOptions?.openrouter))).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it("leaves other models alone", () => {
    expect(withCacheBreakpoints("openai/gpt-5.6-luna", messages)).toBe(messages);
  });
});
