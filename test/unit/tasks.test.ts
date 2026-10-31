import { describe, expect, it } from "vitest";
import type { AgentTask } from "../../lib/db/schema.ts";
import { clampInterval, isFinalCheck, MAX_CHECKS, withinWorkingHours } from "../../lib/tasks/index.ts";
import { checkPrompt } from "../../lib/tasks/run.ts";

const task = (overrides: Partial<AgentTask> = {}): AgentTask =>
  ({
    id: "00000000-0000-4000-8000-000000000001",
    title: "AI subscriptions",
    goal: "Every active developer picks an option",
    successCriteria: "All active developers answered",
    plan: null,
    checks: 1,
    checkEveryMinutes: 120,
    deadline: null,
    insertedAt: new Date("2026-10-29T11:21:00Z"),
    ...overrides,
  }) as AgentTask;

describe("withinWorkingHours", () => {
  it("keeps a time inside working hours", () => {
    const at = new Date("2026-10-29T13:00:00Z");
    expect(withinWorkingHours(at)).toEqual(at);
  });

  it("moves an evening time to the next workday morning", () => {
    expect(withinWorkingHours(new Date("2026-10-29T19:30:00Z")).toISOString()).toBe("2026-10-30T07:00:00.000Z");
  });

  it("moves an early morning time to 8:00 the same day", () => {
    expect(withinWorkingHours(new Date("2026-10-29T04:00:00Z")).toISOString()).toBe("2026-10-29T07:00:00.000Z");
  });

  it("skips the weekend", () => {
    expect(withinWorkingHours(new Date("2026-10-30T18:00:00Z")).toISOString()).toBe("2026-11-02T07:00:00.000Z");
    expect(withinWorkingHours(new Date("2026-10-31T10:00:00Z")).toISOString()).toBe("2026-11-02T07:00:00.000Z");
  });
});

describe("task limits", () => {
  it("clamps the check interval", () => {
    expect(clampInterval(1)).toBe(15);
    expect(clampInterval(60)).toBe(60);
    expect(clampInterval(100_000)).toBe(7 * 24 * 60);
  });

  it("makes the check final at the deadline or the check limit", () => {
    const now = Date.parse("2026-10-30T10:00:00Z");
    expect(isFinalCheck(task(), now)).toBe(false);
    expect(isFinalCheck(task({ deadline: new Date("2026-10-30T09:00:00Z") }), now)).toBe(true);
    expect(isFinalCheck(task({ checks: MAX_CHECKS }), now)).toBe(true);
  });
});

describe("checkPrompt", () => {
  const owner = { name: "Franek", slackId: "U1" };

  it("lists progress and who has not replied, and asks to reschedule", () => {
    const prompt = checkPrompt({
      task: task(),
      owner,
      updates: [{ content: "Asked in the thread", insertedAt: new Date("2026-10-29T11:22:00Z") }],
      contacts: [{ name: "Konrad", slackId: "U2", at: new Date("2026-10-29T12:00:00Z"), replied: false }],
      final: false,
    });
    expect(prompt).toContain("Asked in the thread");
    expect(prompt).toContain("Konrad <@U2>");
    expect(prompt).toContain("no reply yet");
    expect(prompt).toContain("next_check_in_minutes");
    expect(prompt).toContain("no-reply");
  });

  it("tells the last check to close the task", () => {
    const prompt = checkPrompt({ task: task({ checks: MAX_CHECKS }), owner, updates: [], contacts: [], final: true });
    expect(prompt).toContain("This is the last check");
    expect(prompt).not.toContain("next_check_in_minutes");
  });
});
