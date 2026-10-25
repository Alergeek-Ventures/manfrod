import { describe, expect, it } from "vitest";
import { parseDecision } from "../../lib/agent/response-gate.ts";

describe("parseDecision", () => {
  it("parses each decision", () => {
    expect(parseDecision("respond")).toEqual({ kind: "respond" });
    expect(parseDecision("ignore")).toEqual({ kind: "ignore" });
    expect(parseDecision("react:joy")).toEqual({ kind: "react", emoji: "joy" });
    expect(parseDecision(" React_and_respond: :heart: ")).toEqual({ kind: "react_and_respond", emoji: "heart" });
  });

  it("falls back safely on unknown emoji or garbage", () => {
    expect(parseDecision("react:unicorn")).toEqual({ kind: "ignore" });
    expect(parseDecision("react_and_respond:unicorn")).toEqual({ kind: "respond" });
    expect(parseDecision("maybe?")).toEqual({ kind: "respond" });
    expect(parseDecision(null)).toEqual({ kind: "respond" });
  });
});
