import { describe, expect, it } from "vitest";
import { singleToolResultBreakpoint } from "../../lib/llm/cache-breakpoints.ts";

const mark = { anthropic: { cacheControl: { type: "ephemeral" } } };

function result(id: string) {
  return { type: "tool-result", toolCallId: id, toolName: id, output: { type: "text", value: "ok" } };
}

async function transform(prompt: unknown[]) {
  const params = await singleToolResultBreakpoint.transformParams!({ params: { prompt }, type: "stream", model: {} } as never);
  return params.prompt as unknown as Array<{ role: string; providerOptions?: unknown; content: Array<{ providerOptions?: unknown }> }>;
}

describe("singleToolResultBreakpoint", () => {
  it("moves a tool message breakpoint onto its last result only", async () => {
    const [message] = await transform([
      { role: "tool", content: [result("a"), result("b"), result("c"), result("d")], providerOptions: mark },
    ]);
    expect(message.providerOptions).toEqual({});
    expect(message.content.map((part) => part.providerOptions)).toEqual([undefined, undefined, undefined, mark]);
  });

  it("keeps other provider options on the message", async () => {
    const options = { anthropic: { cacheControl: { type: "ephemeral" }, other: 1 }, openai: { x: 1 } };
    const [message] = await transform([{ role: "tool", content: [result("a"), result("b")], providerOptions: options }]);
    expect(message.providerOptions).toEqual({ anthropic: { other: 1 }, openai: { x: 1 } });
    expect(message.content[1].providerOptions).toEqual({ anthropic: options.anthropic });
  });

  it("leaves single results, unmarked tool messages and other roles alone", async () => {
    const prompt = [
      { role: "system", content: "s", providerOptions: mark },
      { role: "assistant", content: [], providerOptions: mark },
      { role: "tool", content: [result("a")], providerOptions: mark },
      { role: "tool", content: [result("a"), result("b")] },
    ];
    expect(await transform(prompt)).toEqual(prompt);
  });
});
