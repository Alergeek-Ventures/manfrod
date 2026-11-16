import { describe, expect, it } from "vitest";
import { sandboxOwner } from "../../agent/lib/e2b-sandbox.ts";

describe("sandboxOwner", () => {
  const child = { id: "child", parent: { sessionId: "self-modify" } };

  it("puts a sharing subagent in its parent's sandbox", () => {
    expect(sandboxOwner(child, true)).toBe("self-modify");
  });

  it("keeps everyone else in their own sandbox", () => {
    expect(sandboxOwner(child, false)).toBe("child");
    expect(sandboxOwner({ id: "root" }, true)).toBe("root");
  });
});
