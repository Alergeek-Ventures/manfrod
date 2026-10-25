import { describe, expect, it } from "vitest";
import type { TeamContext } from "../../lib/linear/client.ts";
import { resolveIssueFields } from "../../lib/linear/resolve.ts";

const context: TeamContext = {
  states: [
    { id: "s-todo", name: "Todo" },
    { id: "s-progress", name: "In Progress" },
  ],
  members: [{ id: "u-kamil", name: "Kamil Marczak", displayName: "kamil", email: "kamil@example.com" }],
  labels: [
    { id: "l-bug", name: "Bug" },
    { id: "l-infra", name: "Infra" },
  ],
  projects: [{ id: "p-core", name: "Core" }],
  cycles: [
    { id: "c-12", number: 12, name: null, isActive: true, isNext: false },
    { id: "c-13", number: 13, name: "Launch", isActive: false, isNext: true },
  ],
};

describe("resolveIssueFields", () => {
  it("maps names to Linear ids case-insensitively", () => {
    const result = resolveIssueFields(
      context,
      { title: "Fix it", priority: 2, assignee: "KAMIL", state: "in progress", labels: ["bug", "Infra"], project: "core" },
      null,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        title: "Fix it",
        priority: 2,
        assigneeId: "u-kamil",
        stateId: "s-progress",
        labelIds: ["l-bug", "l-infra"],
        projectId: "p-core",
      },
    });
  });

  it("resolves the assignee by email and treats me as the requester", () => {
    expect(resolveIssueFields(context, { assignee: "kamil@example.com" }, null)).toEqual({ ok: true, value: { assigneeId: "u-kamil" } });
    expect(resolveIssueFields(context, { assignee: "me" }, "kamil@example.com")).toEqual({ ok: true, value: { assigneeId: "u-kamil" } });
  });

  it("resolves cycles by keyword, number or name", () => {
    expect(resolveIssueFields(context, { cycle: "current" }, null)).toEqual({ ok: true, value: { cycleId: "c-12" } });
    expect(resolveIssueFields(context, { cycle: "next" }, null)).toEqual({ ok: true, value: { cycleId: "c-13" } });
    expect(resolveIssueFields(context, { cycle: "12" }, null)).toEqual({ ok: true, value: { cycleId: "c-12" } });
    expect(resolveIssueFields(context, { cycle: "launch" }, null)).toEqual({ ok: true, value: { cycleId: "c-13" } });
    expect(resolveIssueFields(context, { cycle: "99" }, null)).toMatchObject({ ok: false });
  });

  it("lists the available options for unknown names", () => {
    expect(resolveIssueFields(context, { state: "Shipped" }, null)).toEqual({
      ok: false,
      error: 'Nieznany status "Shipped". Dostępne: Todo, In Progress',
    });
    expect(resolveIssueFields(context, { labels: ["Bug", "Nope"] }, null)).toMatchObject({ ok: false });
  });
});
