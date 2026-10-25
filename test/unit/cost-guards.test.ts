import { describe, expect, it } from "vitest";
import { MAX_STEPS_PER_TURN, routeStep, StepBudgetExceededError } from "../../lib/agent/model-router.ts";
import { validateCron } from "../../lib/memory/reminders.ts";

describe("agent step budget", () => {
  it("stops a turn after the step limit", async () => {
    const messages = [{ role: "user" as const, content: "loop forever" }];
    for (let step = 0; step < MAX_STEPS_PER_TURN; step += 1) await routeStep("budget-test", messages);
    await expect(routeStep("budget-test", messages)).rejects.toBeInstanceOf(StepBudgetExceededError);
  });

  it("starts a fresh budget for the next user message", async () => {
    const first = [{ role: "user" as const, content: "one" }];
    for (let step = 0; step < MAX_STEPS_PER_TURN; step += 1) await routeStep("budget-reset", first);
    await expect(routeStep("budget-reset", [...first, { role: "user" as const, content: "two" }])).resolves.toBeDefined();
  });
});

describe("recurring reminder interval", () => {
  it("rejects schedules that fire more often than every 30 minutes", () => {
    expect(validateCron("* * * * *")).toMatch(/30 minutes/);
    expect(validateCron("0,10 9 * * *")).toMatch(/30 minutes/);
    expect(validateCron("*/30 * * * *")).toBeNull();
    expect(validateCron("0 8 * * *")).toBeNull();
  });
});
