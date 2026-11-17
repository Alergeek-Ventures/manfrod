import { describe, expect, it } from "vitest";
import type { ComparedFile } from "../../lib/github.ts";
import {
  ciState,
  containsMerge,
  DAILY_LIMIT,
  eligibility,
  fileListProblems,
  frontmatter,
  isCandidate,
  MAX_CHANGED_LINES,
  MAX_FILES,
  MAX_LINE_CHARS,
  newReferences,
  underDailyLimit,
  type FileVersions,
} from "../../lib/self-modify-merge/eligibility.ts";
import { parseVerdict, securityReview, type ReviewInput } from "../../lib/self-modify-merge/review.ts";
import { isEnabledValue } from "../../lib/self-modify-merge/settings.ts";
import { pathViolation } from "../../agent/lib/self-modify.ts";

const ROUTINE = "---\nname: work-start\ndescription: Morning nudge\n---\n\n# Work start\n\nSay hi.\n";
const SKILL = "---\nname: desk-booking\ndescription: Book desks\n---\n\n# Desk booking\n\nAsk which day.\n";

const file = (path: string, status = "modified", changes = 4, previousPath: string | null = null): ComparedFile => ({
  path,
  status,
  changes,
  patch: "@@ -1 +1 @@",
  previousPath,
});

const same = (before: string | null, head: string | null): FileVersions => ({ mergeBase: before, main: before, head });

describe("auto-merge eligibility", () => {
  it("accepts an edited skill and an edited routine body", () => {
    const files = [file("agent/skills/desk-booking/SKILL.md"), file("agent/routines/work-start/ROUTINE.md")];
    const versions = new Map([
      ["agent/skills/desk-booking/SKILL.md", same(SKILL, `${SKILL}Confirm first.\n`)],
      ["agent/routines/work-start/ROUTINE.md", same(ROUTINE, `${ROUTINE}Be brief.\n`)],
    ]);
    expect(eligibility(files, versions)).toEqual({
      ok: true,
      targets: [
        { kind: "skill", name: "desk-booking", path: "agent/skills/desk-booking/SKILL.md" },
        { kind: "routine", name: "work-start", path: "agent/routines/work-start/ROUTINE.md" },
      ],
    });
  });

  it("accepts a new skill", () => {
    const path = "agent/skills/new-thing/SKILL.md";
    expect(eligibility([file(path, "added")], new Map([[path, same(null, SKILL)]])).ok).toBe(true);
  });

  it("rejects anything outside top-level skill and routine files, including subagent skills", () => {
    for (const path of [
      "agent/subagents/self-modify/skills/x/SKILL.md",
      "agent/skills/desk-booking/helper.ts",
      "agent/skills/desk-booking/notes.md",
      "agent/skills/Desk/SKILL.md",
      "agent/routines/work-start/README.md",
      "lib/routines.ts",
    ]) {
      const result = eligibility([file(path)], new Map([[path, same("a", "b")]]));
      expect(result.ok, path).toBe(false);
    }
  });

  it("never merges proactive-style", () => {
    const path = "agent/routines/proactive-style/ROUTINE.md";
    expect(eligibility([file(path)], new Map([[path, same(ROUTINE, `${ROUTINE}x\n`)]])).ok).toBe(false);
  });

  it("rejects new routines and changed routine frontmatter", () => {
    const path = "agent/routines/new-one/ROUTINE.md";
    expect(eligibility([file(path, "added")], new Map([[path, same(null, ROUTINE)]])).ok).toBe(false);
    const existing = "agent/routines/work-start/ROUTINE.md";
    const moved = ROUTINE.replace("description: Morning nudge", "description: Morning nudge\ncron: '* * * * *'");
    const result = eligibility([file(existing)], new Map([[existing, same(ROUTINE, moved)]]));
    expect(result).toEqual({ ok: false, reasons: [`${existing}: the routine's frontmatter changed`] });
    const stripped = eligibility([file(existing)], new Map([[existing, same(ROUTINE, "# no frontmatter\n")]]));
    expect(stripped.ok).toBe(false);
  });

  it("rejects deletes and renames", () => {
    const path = "agent/skills/desk-booking/SKILL.md";
    expect(eligibility([file(path, "removed")], new Map()).ok).toBe(false);
    expect(eligibility([file(path, "renamed", 0, "agent/skills/old/SKILL.md")], new Map([[path, same(null, SKILL)]])).ok).toBe(false);
  });

  it("rejects files main changed after the branch was created", () => {
    const path = "agent/skills/desk-booking/SKILL.md";
    const versions = new Map([[path, { mergeBase: SKILL, main: `${SKILL}main\n`, head: `${SKILL}head\n` }]]);
    expect(eligibility([file(path)], versions).ok).toBe(false);
  });

  it("rejects big changes, secrets and new links", () => {
    const path = "agent/skills/desk-booking/SKILL.md";
    expect(eligibility([file(path, "modified", MAX_CHANGED_LINES + 1)], new Map([[path, same(SKILL, `${SKILL}x`)]])).ok).toBe(false);
    const secret = `${SKILL}Use ${"gh"}p_wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx\n`;
    expect(eligibility([file(path)], new Map([[path, same(SKILL, secret)]])).ok).toBe(false);
    const linked = `${SKILL}See https://evil.example.com/collect\n`;
    expect(eligibility([file(path)], new Map([[path, same(SKILL, linked)]]))).toEqual({
      ok: false,
      reasons: [`${path}: adds links to evil.example.com`, `${path}: adds domains evil.example.com`],
    });
    const known = `${SKILL}See https://manfrod.d.alergeek.me/a\n`;
    expect(eligibility([file(path)], new Map([[path, same(known, `${known}And https://manfrod.d.alergeek.me/b\n`)]])).ok).toBe(true);
  });

  it("rejects a huge single-line file quickly without scanning it", () => {
    const path = "agent/skills/desk-booking/SKILL.md";
    const huge = `${SKILL}${"a@b.".repeat(250_000)}`;
    const started = performance.now();
    const result = eligibility([file(path)], new Map([[path, same(SKILL, huge)]]));
    expect(performance.now() - started).toBeLessThan(200);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons[0]).toMatch(/too large to check/);
  });

  it("rejects a line longer than the limit even in a small file", () => {
    const path = "agent/skills/desk-booking/SKILL.md";
    const long = `${SKILL}${"x".repeat(MAX_LINE_CHARS + 1)}\n`;
    const result = eligibility([file(path)], new Map([[path, same(SKILL, long)]]));
    expect(result).toEqual({
      ok: false,
      reasons: [`${path}: too large to check (a line of ${MAX_LINE_CHARS + 1} characters; the limit is ${MAX_LINE_CHARS})`],
    });
  });

  it("rejects a pull request without files", () => {
    expect(eligibility([], new Map()).ok).toBe(false);
  });

  it("treats only pull requests touching skills or routines as candidates", () => {
    expect(isCandidate([file("lib/x.ts")])).toBe(false);
    expect(isCandidate([file("lib/x.ts"), file("agent/routines/work-start/ROUTINE.md")])).toBe(true);
  });

  it("reads the frontmatter block only when it is closed", () => {
    expect(frontmatter(ROUTINE)).toBe("---\nname: work-start\ndescription: Morning nudge\n---");
    expect(frontmatter("---\nname: x\n")).toBeNull();
    expect(frontmatter("# title")).toBeNull();
  });

  it("keeps the merge-deciding code out of self-modify's reach", () => {
    expect(pathViolation("lib/self-modify-merge/eligibility.ts")).toBe("protected path");
    for (const path of [
      "lib/inngest/functions.ts",
      "lib/inngest/runtime.ts",
      "lib/config.ts",
      "agent/hooks/audit.ts",
      "agent/hooks/card-stream.ts",
      "agent/channels/jobs.ts",
      "agent/tools/integrations.ts",
      "agent/lib/define-tool.ts",
      "lib/rehearsal/guard.ts",
      "agent/subagents/self-modify/hooks/rehearsal.ts",
      "app/(panel)/admin/access/actions.ts",
    ]) {
      expect(pathViolation(path), path).toBe("protected path");
    }
    expect(pathViolation("agent/skills/desk-booking/SKILL.md")).toBeNull();
  });
});

describe("CI state", () => {
  const actions = "github-actions";

  it("is green only when the required checks completed and nothing failed", () => {
    expect(ciState([])).toBe("pending");
    expect(ciState([{ name: "test", status: "in_progress", conclusion: null, app: actions }])).toBe("pending");
    expect(ciState([{ name: "test", status: "completed", conclusion: "success", app: actions }])).toBe("green");
    expect(ciState([{ name: "other", status: "completed", conclusion: "success", app: actions }])).toBe("pending");
    expect(
      ciState([
        { name: "test", status: "completed", conclusion: "success", app: actions },
        { name: "lint", status: "completed", conclusion: "failure", app: actions },
      ]),
    ).toBe("failed");
  });

  it("requires the test run from GitHub Actions with conclusion success", () => {
    expect(ciState([{ name: "test", status: "completed", conclusion: "success", app: "some-other-app" }])).toBe("pending");
    expect(ciState([{ name: "test", status: "completed", conclusion: "skipped", app: actions }])).toBe("failed");
    expect(ciState([{ name: "test", status: "completed", conclusion: "neutral", app: actions }])).toBe("failed");
  });
});

describe("file list", () => {
  const paths = (count: number) => Array.from({ length: count }, (_, index) => ({ path: `agent/skills/s${index}/SKILL.md` }));

  it("accepts a consistent list within the limit", () => {
    expect(fileListProblems(paths(2), 2, paths(2))).toEqual([]);
  });

  it("blocks more than ten files, a count mismatch and lists that disagree", () => {
    expect(fileListProblems(paths(MAX_FILES + 1), MAX_FILES + 1, paths(MAX_FILES + 1))).toEqual([
      `${MAX_FILES + 1} files changed; the limit is ${MAX_FILES}`,
    ]);
    expect(fileListProblems(paths(2), 3, paths(2))).toEqual(["GitHub listed 2 files but the pull request reports 3"]);
    expect(fileListProblems(paths(2), 2, [{ path: "agent/skills/other/SKILL.md" }, ...paths(1)])).toEqual([
      "the pull request's file list differs from the comparison with main",
    ]);
  });
});

describe("new references", () => {
  it("flags Slack mentions and IDs, emails and domains that the previous version did not have", () => {
    expect(newReferences("Ask in the thread.", "Ask <@U01ABCDEF12> in <#C01ABCDEF12|ops>, ping <!channel>.")).toEqual([
      "adds Slack mentions or IDs <@U01ABCDEF12>, <#C01ABCDEF12|ops>, <!channel>, U01ABCDEF12, C01ABCDEF12",
    ]);
    expect(newReferences("", "DM W0123ABCDE about it")).toEqual(["adds Slack mentions or IDs W0123ABCDE"]);
    expect(newReferences("", "Mail ops@corp.example.com")).toEqual([
      "adds email addresses ops@corp.example.com",
      "adds domains corp.example.com",
    ]);
    expect(newReferences("", "Upload it to drop.example.io")).toEqual(["adds domains drop.example.io"]);
  });

  it("needs a digit in a bare Slack ID", () => {
    expect(newReferences("", "Check the CONFIGURATION and the GUIDELINES first.")).toEqual([]);
    expect(newReferences("", "Post in C0CONFIGUR")).toEqual(["adds Slack mentions or IDs C0CONFIGUR"]);
  });

  it("stays fast on long lines built to make the patterns backtrack", () => {
    const line = (unit: string) => unit.repeat(Math.floor((MAX_LINE_CHARS - 1) / unit.length));
    const started = performance.now();
    for (const unit of ["a", "a.", "a@", "a-", "<@", "x://", "C1", "a.a@"]) newReferences("", line(unit));
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("allows references already present and ordinary text", () => {
    const before = "Ask <@U01ABCDEF12>, mail ops@corp.example.com or see https://docs.example.io/a";
    expect(newReferences(before, `${before}\nThen https://docs.example.io/b, per SKILL.md and lib/routines.ts.`)).toEqual([]);
    expect(newReferences("", "Confirm the WARSZAWA office and the desk number first.")).toEqual([]);
  });
});

describe("daily limit", () => {
  const now = new Date("2026-11-17T12:00:00Z");
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

  it("allows at most five merges in a rolling 24 hours", () => {
    expect(underDailyLimit([], now)).toBe(true);
    expect(
      underDailyLimit(
        Array.from({ length: DAILY_LIMIT - 1 }, (_, index) => hoursAgo(index + 1)),
        now,
      ),
    ).toBe(true);
    expect(
      underDailyLimit(
        Array.from({ length: DAILY_LIMIT }, (_, index) => hoursAgo(index + 1)),
        now,
      ),
    ).toBe(false);
    expect(underDailyLimit([...Array.from({ length: DAILY_LIMIT - 1 }, () => hoursAgo(1)), hoursAgo(25)], now)).toBe(true);
  });
});

describe("kill switch", () => {
  it("is on unless an admin turned it off", () => {
    expect(isEnabledValue(undefined)).toBe(true);
    expect(isEnabledValue("on")).toBe(true);
    expect(isEnabledValue("off")).toBe(false);
  });
});

describe("deployed commit contains the merge", () => {
  it("counts identical and ahead only, never an unknown commit", () => {
    expect(containsMerge("identical")).toBe(true);
    expect(containsMerge("ahead")).toBe(true);
    expect(containsMerge("behind")).toBe(false);
    expect(containsMerge("diverged")).toBe(false);
    expect(containsMerge(null)).toBe(false);
  });
});

describe("security review", () => {
  const input: ReviewInput = {
    files: [{ path: "agent/skills/a/SKILL.md", status: "modified", before: "a", after: "b", patch: null }],
    evidence: { finding: null, conversations: [] },
  };
  const pass = async () => ({ pass: true, reason: "fine" });

  it("passes only when both judges pass", async () => {
    expect(await securityReview(input, { one: pass, two: pass })).toEqual({ pass: true, transient: false, reasons: [] });
    const blocked = await securityReview(input, { one: pass, two: async () => ({ pass: false, reason: "sends data out" }) });
    expect(blocked).toEqual({ pass: false, transient: false, reasons: ["two: sends data out"] });
  });

  it("fails closed when a judge errors or none runs", async () => {
    const failed = await securityReview(input, {
      one: pass,
      two: async () => {
        throw new Error("timeout");
      },
    });
    expect(failed).toEqual({ pass: false, transient: true, reasons: ["two failed: timeout"] });
    expect(await securityReview(input, {})).toEqual({ pass: false, transient: false, reasons: ["no security judge ran"] });
    const both = await securityReview(input, {
      one: async () => ({ pass: false, reason: "new recipient" }),
      two: async () => {
        throw new Error("timeout");
      },
    });
    expect(both.transient).toBe(false);
  });

  it("reads only a well-formed verdict", () => {
    expect(parseVerdict('```json\n{"verdict":"pass","reason":"ok"}\n```')).toEqual({ pass: true, reason: "ok" });
    expect(parseVerdict('{"verdict":"block","reason":"exfiltration"}')).toEqual({ pass: false, reason: "exfiltration" });
    expect(parseVerdict("looks fine to me")).toBeNull();
    expect(parseVerdict('{"verdict":"maybe","reason":"?"}')).toBeNull();
  });
});

describe("deployed commit", () => {
  it("is read from the file baked into the image and must be a full SHA", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readAppCommit } = await import("../../lib/config.ts");
    const dir = mkdtempSync(join(tmpdir(), "app-commit-"));
    const sha = "0123456789abcdef0123456789abcdef01234567";
    writeFileSync(join(dir, "ok"), `${sha}\n`);
    writeFileSync(join(dir, "empty"), "");
    expect(readAppCommit(join(dir, "ok"))).toBe(sha);
    expect(readAppCommit(join(dir, "empty"))).toBeUndefined();
    expect(readAppCommit(join(dir, "missing"))).toBeUndefined();
  });
});
