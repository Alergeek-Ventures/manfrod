import { describe, expect, it } from "vitest";
import { migrationViolation, pathViolation } from "../../agent/lib/self-modify.ts";

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
      "lib/self-review/index.ts",
      "agent/lib/http.ts",
      "agent/tools/http-request.ts",
    ]) {
      expect(pathViolation(path)).toBe("protected path");
    }
  });

  it("rejects everything else", () => {
    for (const path of ["package.json", "pnpm-lock.yaml", ".github/workflows/ci.yml", "scripts/migrate.mjs", "Dockerfile"]) {
      expect(pathViolation(path)).toBe("outside the allowed paths");
    }
  });

  it("accepts only new, non-destructive migrations", () => {
    expect(pathViolation("db/migrations/0016_add_x.sql")).toBeNull();
    expect(
      migrationViolation({ path: "db/migrations/0016_add_x.sql", status: "A" }, "ALTER TABLE x ADD COLUMN IF NOT EXISTS y text;"),
    ).toBeNull();
    expect(migrationViolation({ path: "db/migrations/0012_self_review.sql", status: "M" }, "")).toMatch(/can't be changed/);
    expect(migrationViolation({ path: "db/migrations/0012_self_review.sql", status: "D" }, null)).toMatch(/can't be changed/);
    expect(migrationViolation({ path: "db/migrations/add.sql", status: "A" }, "")).toMatch(/NNNN_name/);
    for (const sql of ["DROP TABLE nodes;", "ALTER TABLE facts DROP COLUMN value;", "TRUNCATE messages;", "DELETE FROM users;"]) {
      expect(migrationViolation({ path: "db/migrations/0016_x.sql", status: "A" }, sql)).toMatch(/destructive/);
    }
  });

  it("rejects traversal and git internals", () => {
    expect(pathViolation("agent/skills/../../lib/secrets.ts")).toBe("unsafe path");
    expect(pathViolation("agent/.git/config")).toBe("unsafe path");
  });
});
