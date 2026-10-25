import { describe, expect, it } from "vitest";
import { canResolveEscalation } from "../../lib/memory/classifier.ts";

describe("canResolveEscalation", () => {
  it("lets only the author resolve a prompt that names one", () => {
    expect(canResolveEscalation({ author_slack_id: "U1" }, "U1")).toBe(true);
    expect(canResolveEscalation({ author_slack_id: "U1" }, "U2")).toBe(false);
    expect(canResolveEscalation({ author_slack_id: "U1" }, undefined)).toBe(false);
  });

  it("keeps prompts posted before authors were recorded resolvable", () => {
    expect(canResolveEscalation({}, "U2")).toBe(true);
  });
});
