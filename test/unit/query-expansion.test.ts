import { describe, expect, it } from "vitest";
import { readExpansion } from "../../lib/memory/query-expander.ts";

describe("readExpansion", () => {
  it("returns null when the model did not answer with a JSON array, so the caller can report it", () => {
    expect(readExpansion("sorry, I can't", "budżet")).toBeNull();
    expect(readExpansion('{"queries": ["a"]}', "budżet")).toBeNull();
  });

  it("puts the original query first and keeps at most three", () => {
    expect(readExpansion('```json\n["koszty", "budżet", "wydatki", "plan"]\n```', "budżet")).toEqual(["budżet", "koszty", "wydatki"]);
  });
});
