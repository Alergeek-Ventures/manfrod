import { describe, expect, it } from "vitest";
import { cost, isFree, isKnown, label, uncachedCost } from "../../lib/pricing.ts";

const GPT = "openai/gpt-5.6-luna";
const HAIKU = "anthropic/claude-haiku-5.5";

describe("cost", () => {
  it("prices plain input and output at headline rates", () => {
    expect(cost(GPT, { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(1.4, 6);
  });

  it("treats cached tokens as a discounted subset of input", () => {
    expect(cost(GPT, { input_tokens: 1_000_000, output_tokens: 0, cached_tokens: 600_000 })).toBeCloseTo(0.4 * 0.2 + 0.6 * 0.01, 6);
  });

  it("caching is cheaper than not caching", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 10_000, cached_tokens: 800_000 };
    expect(cost(GPT, usage)).toBeLessThan(uncachedCost(GPT, usage));
  });

  it("charges the higher cache-write rate only above the threshold", () => {
    expect(cost(GPT, { cache_creation_tokens: 100_000 })).toBeCloseTo(0.1 * 0.125, 6);
    expect(cost(GPT, { cache_creation_tokens: 300_000 })).toBeCloseTo(0.3 * 0.25, 6);
  });

  it("haiku prices below gpt for identical usage", () => {
    const usage = { input_tokens: 500_000, output_tokens: 50_000 };
    expect(cost(HAIKU, usage)).toBeLessThan(cost(GPT, usage));
  });

  it("free and unknown models cost nothing", () => {
    expect(cost("llama-3.1-8b-instant", { input_tokens: 5_000_000, output_tokens: 1_000_000 })).toBe(0);
    expect(isFree("llama-3.1-8b-instant")).toBe(true);
    expect(cost("some/unlisted-model", { input_tokens: 1_000 })).toBe(0);
    expect(cost(null, { input_tokens: 1_000 })).toBe(0);
    expect(isKnown("llama-3.1-8b-instant")).toBe(true);
    expect(isKnown("some/unlisted-model")).toBe(false);
  });

  it("kimi prices above gpt", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 100_000 };
    expect(cost("moonshotai/kimi-k2.5", usage)).toBeGreaterThan(cost(GPT, usage));
  });

  it("tolerates missing counts and never goes negative", () => {
    expect(cost(GPT, {})).toBe(0);
    expect(cost(GPT, { input_tokens: null, output_tokens: null })).toBe(0);
    expect(cost(GPT, { input_tokens: 100, cached_tokens: 5_000 })).toBeGreaterThanOrEqual(0);
  });
});

describe("label", () => {
  it("names known models and passes unknown ids through", () => {
    expect(label(GPT)).toBe("GPT-5.6 Luna");
    expect(label("some/unlisted-model")).toBe("some/unlisted-model");
  });
});
