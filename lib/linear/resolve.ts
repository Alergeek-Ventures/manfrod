import type { LResult, TeamContext } from "./client.ts";

export interface IssueFields {
  title?: string;
  description?: string;
  priority?: number;
  assignee?: string;
  state?: string;
  labels?: string[];
  project?: string;
  dueDate?: string;
  estimate?: number;
  cycle?: string;
}

const normalize = (value: string) => value.trim().toLowerCase();

function pick<T extends { id: string; name: string }>(kind: string, items: T[], wanted: string, matches = (item: T) => [item.name]) {
  const target = normalize(wanted);
  const found = items.find((item) => matches(item).some((candidate) => normalize(candidate) === target));
  if (found) return { ok: true as const, value: found.id };
  const available = items.map((item) => item.name).join(", ") || "brak";
  return { ok: false as const, error: `Nieznany ${kind} "${wanted}". Dostępne: ${available}` };
}

function pickCycle(cycles: TeamContext["cycles"], wanted: string): LResult<string> {
  const target = normalize(wanted);
  const found = cycles.find((cycle) =>
    target === "current"
      ? cycle.isActive
      : target === "next"
        ? cycle.isNext
        : String(cycle.number) === target || normalize(cycle.name ?? "") === target,
  );
  if (found) return { ok: true, value: found.id };
  const available = cycles.map((cycle) => (cycle.name ? `${cycle.number} (${cycle.name})` : String(cycle.number))).join(", ") || "brak";
  return { ok: false, error: `Nieznany cykl "${wanted}". Dostępne: current, next, ${available}` };
}

export function resolveIssueFields(
  context: TeamContext,
  fields: IssueFields,
  requesterEmail: string | null,
): LResult<Record<string, unknown>> {
  const input: Record<string, unknown> = {};
  if (fields.title !== undefined) input.title = fields.title;
  if (fields.description !== undefined) input.description = fields.description;
  if (fields.priority !== undefined) input.priority = fields.priority;
  if (fields.dueDate !== undefined) input.dueDate = fields.dueDate;
  if (fields.estimate !== undefined) input.estimate = fields.estimate;

  if (fields.assignee) {
    const wanted = normalize(fields.assignee) === "me" && requesterEmail ? requesterEmail : fields.assignee;
    const assignee = pick("użytkownik", context.members, wanted, (member) => [member.name, member.displayName, member.email]);
    if (!assignee.ok) return assignee;
    input.assigneeId = assignee.value;
  }
  if (fields.state) {
    const state = pick("status", context.states, fields.state);
    if (!state.ok) return state;
    input.stateId = state.value;
  }
  if (fields.project) {
    const project = pick("projekt", context.projects, fields.project);
    if (!project.ok) return project;
    input.projectId = project.value;
  }
  if (fields.cycle) {
    const cycle = pickCycle(context.cycles, fields.cycle);
    if (!cycle.ok) return cycle;
    input.cycleId = cycle.value;
  }
  if (fields.labels && fields.labels.length > 0) {
    const ids: string[] = [];
    for (const name of fields.labels) {
      const label = pick("label", context.labels, name);
      if (!label.ok) return label;
      ids.push(label.value);
    }
    input.labelIds = ids;
  }
  return { ok: true, value: input };
}
