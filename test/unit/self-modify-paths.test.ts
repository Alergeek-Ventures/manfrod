import { describe, expect, it } from "vitest";
import { pathViolation } from "../../agent/lib/self-modify.ts";

describe("pathViolation", () => {
  it("allows skills, routines, tools, prompts and unit tests", () => {
    for (const path of [
      "agent/skills/desk-booking/SKILL.md",
      "agent/routines/leave-digest.md",
      "agent/tools/reserve-desk.ts",
      "agent/lib/office.ts",
      "agent/channels/slack.ts",
      "lib/agent/prompts.ts",
      "lib/proactive.ts",
      "lib/slack/renderer.ts",
      "app/(panel)/admin/access/agent-tab.tsx",
      "components/app-sidebar.tsx",
      "test/unit/new.test.ts",
    ]) {
      expect(pathViolation(path)).toBeNull();
    }
  });

  it("protects the self-modification code and agent config", () => {
    for (const path of [
      "agent/subagents/self-modify/tools/publish-proposal.ts",
      "agent/lib/self-modify.ts",
      "agent/lib/define-tool.ts",
      "agent/lib/e2b-sandbox.ts",
      "agent/agent.ts",
      "lib/secrets.ts",
      "lib/agent/context.ts",
      "lib/accounts.ts",
      "lib/github.ts",
      "lib/self-review/rules.ts",
      "lib/db/index.ts",
    ]) {
      expect(pathViolation(path)).toBe("protected path");
    }
  });

  it("rejects everything else", () => {
    for (const path of [
      "package.json",
      "pnpm-lock.yaml",
      ".github/workflows/ci.yml",
      "db/migrations/0009_x.sql",
      "scripts/migrate.mjs",
      "Dockerfile",
    ]) {
      expect(pathViolation(path)).toBe("outside the allowed paths");
    }
  });

  it("rejects traversal and git internals", () => {
    expect(pathViolation("agent/skills/../../lib/secrets.ts")).toBe("unsafe path");
    expect(pathViolation("agent/.git/config")).toBe("unsafe path");
  });
});
