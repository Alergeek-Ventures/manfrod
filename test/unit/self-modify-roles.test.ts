import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = "agent/subagents/self-modify";

describe("self-modify roles", () => {
  it("leaves writing files to the coder and keeps the reviewer read-only", () => {
    expect(existsSync(`${root}/tools/write_file.ts`)).toBe(false);
    expect(existsSync(`${root}/subagents/coder/tools/write_file.ts`)).toBe(true);
    expect(existsSync(`${root}/subagents/reviewer/tools/write_file.ts`)).toBe(false);
    expect(existsSync(`${root}/subagents/reviewer/tools/bash.ts`)).toBe(false);
  });

  it("runs the coder and the reviewer in the self-modify checkout", () => {
    for (const name of ["coder", "reviewer"]) {
      expect(readFileSync(`${root}/subagents/${name}/sandbox.ts`, "utf8")).toContain("shareParent: true");
    }
  });

  it("uses Sonnet for the coder and GPT 6.1 Terra for the reviewer", () => {
    expect(readFileSync(`${root}/subagents/coder/agent.ts`, "utf8")).toContain("AGENT_MODEL");
    expect(readFileSync(`${root}/subagents/reviewer/agent.ts`, "utf8")).toContain("REVIEW_MODEL");
  });
});
