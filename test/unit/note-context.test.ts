import { describe, expect, it } from "vitest";
import type { Node } from "../../lib/db/schema.ts";
import { buildContext } from "../../lib/memory/search.ts";

const note = (id: string, content: string) => ({ id, content }) as Node;

describe("buildContext", () => {
  it("keeps the most relevant notes that fit the budget", () => {
    const context = buildContext([note("a", "x".repeat(100)), note("b", "y".repeat(100)), note("c", "z".repeat(100))], 250);
    expect(context).toContain("[a]");
    expect(context).toContain("[b]");
    expect(context).not.toContain("[c]");
  });

  it("shortens a single long note instead of letting it take the whole budget", () => {
    const context = buildContext([note("a", "x".repeat(5_000)), note("b", "short")]);
    expect(context).toContain("…");
    expect(context).toContain("[b] short");
  });

  it("returns nothing when there is nothing to show", () => {
    expect(buildContext([])).toBe("");
  });
});
