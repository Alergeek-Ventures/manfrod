import { describe, expect, it } from "vitest";
import type { ComparedFile } from "../../lib/github.ts";
import {
  ciState,
  containsMerge,
  DAILY_LIMIT,
  eligibility,
  frontmatter,
  isCandidate,
  MAX_CHANGED_LINES,
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
      reasons: [`${path}: adds links to evil.example.com`],
    });
    const known = `${SKILL}See https://manfrod.d.alergeek.me/a\n`;
    expect(eligibility([file(path)], new Map([[path, same(known, `${known}And https://manfrod.d.alergeek.me/b\n`)]])).ok).toBe(true);
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
    expect(pathViolation("agent/tools/self-modify-impact.ts")).toBe("protected path");
    expect(pathViolation("agent/skills/desk-booking/SKILL.md")).toBeNull();
  });
});

describe("CI state", () => {
  it("is green only when the required checks completed and nothing failed", () => {
    expect(ciState([])).toBe("pending");
    expect(ciState([{ name: "test", status: "in_progress", conclusion: null }])).toBe("pending");
    expect(ciState([{ name: "test", status: "completed", conclusion: "success" }])).toBe("green");
    expect(ciState([{ name: "other", status: "completed", conclusion: "success" }])).toBe("pending");
    expect(
      ciState([
        { name: "test", status: "completed", conclusion: "success" },
        { name: "lint", status: "completed", conclusion: "failure" },
      ]),
    ).toBe("failed");
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
    expect(await securityReview(input, { one: pass, two: pass })).toEqual({ pass: true, reasons: [] });
    const blocked = await securityReview(input, { one: pass, two: async () => ({ pass: false, reason: "sends data out" }) });
    expect(blocked).toEqual({ pass: false, reasons: ["two: sends data out"] });
  });

  it("fails closed when a judge errors or none runs", async () => {
    const failed = await securityReview(input, {
      one: pass,
      two: async () => {
        throw new Error("timeout");
      },
    });
    expect(failed).toEqual({ pass: false, reasons: ["two failed: timeout"] });
    expect((await securityReview(input, {})).pass).toBe(false);
  });

  it("reads only a well-formed verdict", () => {
    expect(parseVerdict('```json\n{"verdict":"pass","reason":"ok"}\n```')).toEqual({ pass: true, reason: "ok" });
    expect(parseVerdict('{"verdict":"block","reason":"exfiltration"}')).toEqual({ pass: false, reason: "exfiltration" });
    expect(parseVerdict("looks fine to me")).toBeNull();
    expect(parseVerdict('{"verdict":"maybe","reason":"?"}')).toBeNull();
  });
});
