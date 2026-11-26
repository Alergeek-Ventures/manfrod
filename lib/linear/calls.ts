import * as client from "./client.ts";
import type { LResult } from "./client.ts";
import { authorization, getConnection, type LinearConnection } from "./index.ts";
import { formatLocal } from "../time.ts";
import { type IssueFields, resolveIssueFields } from "./resolve.ts";

export interface Requester {
  name: string | null;
  email: string | null;
  image: string | null;
}

export function stateSince(issue: {
  state?: { name: string } | null;
  history?: { nodes: { createdAt: string; toState?: { name: string } | null }[] };
}): string | null {
  const name = issue.state?.name;
  if (!name) return null;
  const entered = (issue.history?.nodes ?? []).filter((entry) => entry.toState?.name === name).map((entry) => entry.createdAt);
  return entered.sort().at(-1) ?? null;
}

function stateLabel(issue: any): string {
  const since = stateSince(issue);
  return `${issue.state?.name ?? "?"}${since ? ` since ${formatLocal(new Date(since))}` : ""}`;
}

export function formatIssue(issue: any): string {
  return `${issue.identifier} [${stateLabel(issue)}] ${issue.title} (${issue.assignee?.name ?? "unassigned"}) — ${issue.url}`;
}

function formatIssues(issues: any[]): string {
  if (issues.length === 0) return "Brak issues.";
  return issues.map(formatIssue).join("\n");
}

function authError(error: string): string {
  if (error === "expired" || error === "not_installed")
    return "Autoryzacja aplikacji Manfrod w Linearze wygasła albo została odinstalowana — trzeba połączyć projekt ponownie przez `/linear-status`.";
  return `Nie udało się uwierzytelnić w Linear: ${error}`;
}

async function withConnection(
  projectId: string,
  run: (auth: string, teamId: string, connection: LinearConnection) => Promise<string>,
): Promise<string> {
  const connection = await getConnection(projectId);
  if (!connection?.linearTeamId) return "Linear nie jest połączony dla tego projektu.";
  const auth = await authorization(connection);
  if (!auth.ok) return authError(auth.error);
  return run(auth.value, connection.linearTeamId, connection);
}

export const READ_ONLY_KEY_RESULT =
  "Nothing written: this project's Linear is connected with a read-only API key. Someone in the project has to run `/linear-status` in the project's Slack channel and connect the Linear app; writing works right after that, no new tool is needed. Tell the person exactly this.";

function withAppConnection(projectId: string, run: (auth: string, teamId: string) => Promise<string>): Promise<string> {
  return withConnection(projectId, (auth, teamId, connection) =>
    connection.mode === "app" ? run(auth, teamId) : Promise.resolve(READ_ONLY_KEY_RESULT),
  );
}

const onBehalfOf = (requester: Requester | null) =>
  requester?.name ? { createAsUser: requester.name, ...(requester.image ? { displayIconUrl: requester.image } : {}) } : {};

export const listIssues = (projectId: string, limit?: number, state?: string) =>
  withConnection(projectId, async (auth, teamId) => {
    const result = await client.listIssues(auth, teamId, limit ?? 25, state?.trim() || undefined);
    return result.ok ? formatIssues(result.value) : `Nie udało się pobrać issues z Linear: ${result.error}`;
  });

export async function teamActivity(projectId: string, since: Date): Promise<client.TeamActivity | null> {
  const connection = await getConnection(projectId);
  if (!connection?.linearTeamId) return null;
  const auth = await authorization(connection);
  if (!auth.ok) return null;
  const result = await client.teamActivity(auth.value, connection.linearTeamId, since);
  return result.ok ? result.value : null;
}

export const getIssue = (projectId: string, identifier: string) =>
  withConnection(projectId, async (auth, teamId) => {
    const result = await client.getIssue(auth, teamId, identifier);
    if (!result.ok) return `Nie udało się pobrać issue z Linear: ${result.error}`;
    const issue = result.value;
    if (!issue) return `Nie znaleziono issue ${identifier}.`;
    const links = ((issue.attachments?.nodes ?? []) as { url: string }[]).map((attachment) => attachment.url);
    return `${issue.identifier} [${stateLabel(issue)}] ${issue.title} (${issue.assignee?.name ?? "unassigned"})\n${issue.description ?? "(no description)"}\n${issue.url}${links.length > 0 ? `\nLinked: ${links.join(", ")}` : ""}`;
  });

export const searchIssues = (projectId: string, term: string, limit?: number) =>
  withConnection(projectId, async (auth, teamId) => {
    const result = await client.searchIssues(auth, teamId, term, limit ?? 25);
    return result.ok ? formatIssues(result.value) : `Nie udało się wyszukać w Linear: ${result.error}`;
  });

export const listProjects = (projectId: string) =>
  withConnection(projectId, async (auth, teamId) => {
    const result = await client.listProjects(auth, teamId);
    if (!result.ok) return `Nie udało się pobrać projektów z Linear: ${result.error}`;
    if (result.value.length === 0) return "Brak projektów.";
    return result.value.map((project) => `${project.name} [${project.state}] — ${project.url}`).join("\n");
  });

export const getCycles = (projectId: string, limit?: number) =>
  withConnection(projectId, async (auth, teamId) => {
    const result = await client.listCycles(auth, teamId, limit ?? 10);
    if (!result.ok) return `Nie udało się pobrać cykli z Linear: ${result.error}`;
    if (result.value.length === 0) return "Brak cykli.";
    return result.value.map((cycle) => `Cycle ${cycle.number} ${cycle.name ?? ""} (${cycle.startsAt} → ${cycle.endsAt})`).join("\n");
  });

export type IssueInput = IssueFields & { parent?: string };

async function resolveParent(auth: string, teamId: string, parent: string | undefined): Promise<LResult<Record<string, unknown>>> {
  if (!parent) return { ok: true, value: {} };
  const found = await client.getIssue(auth, teamId, parent);
  if (!found.ok) return { ok: false, error: `Nie udało się pobrać issue nadrzędnego z Linear: ${found.error}` };
  if (!found.value) return { ok: false, error: `Nie znaleziono issue nadrzędnego ${parent} w zespole tego projektu.` };
  return { ok: true, value: { parentId: found.value.id } };
}

async function resolveFields(auth: string, teamId: string, { parent, ...fields }: IssueInput, requester: Requester | null) {
  const parentInput = await resolveParent(auth, teamId, parent);
  if (!parentInput.ok) return parentInput;
  const needsContext = fields.assignee || fields.state || fields.project || fields.cycle || (fields.labels && fields.labels.length > 0);
  const context = needsContext ? await client.teamContext(auth, teamId) : null;
  if (context && !context.ok) return { ok: false as const, error: `Nie udało się pobrać danych zespołu z Linear: ${context.error}` };
  const resolved = resolveIssueFields(
    context?.value ?? { states: [], members: [], labels: [], projects: [], cycles: [] },
    fields,
    requester?.email ?? null,
  );
  return resolved.ok ? { ok: true as const, value: { ...resolved.value, ...parentInput.value } } : resolved;
}

export const createIssue = (projectId: string, fields: IssueInput & { title: string }, requester: Requester | null) =>
  withAppConnection(projectId, async (auth, teamId) => {
    const resolved = await resolveFields(auth, teamId, fields, requester);
    if (!resolved.ok) return resolved.error;
    const result = await client.createIssue(auth, { teamId, ...resolved.value, ...onBehalfOf(requester) });
    return result.ok ? `Utworzono ${formatIssue(result.value)}` : `Nie udało się utworzyć issue w Linear: ${result.error}`;
  });

const CURRENT_VALUES: Record<string, (issue: any) => unknown> = {
  title: (issue) => issue.title,
  description: (issue) => issue.description,
  priority: (issue) => issue.priority,
  dueDate: (issue) => issue.dueDate,
  estimate: (issue) => issue.estimate,
  assigneeId: (issue) => issue.assignee?.id,
  stateId: (issue) => issue.state?.id,
  projectId: (issue) => issue.project?.id,
  cycleId: (issue) => issue.cycle?.id,
  parentId: (issue) => issue.parent?.id,
};

export function issueChanges(issue: any, input: Record<string, unknown>): { changes: Record<string, unknown>; unchanged: string[] } {
  const changes: Record<string, unknown> = {};
  const unchanged: string[] = [];
  for (const [field, value] of Object.entries(input)) {
    if (field === "labelIds") {
      const present = new Set(((issue.labels?.nodes ?? []) as { id: string }[]).map((label) => label.id));
      const added = (value as string[]).filter((id) => !present.has(id));
      if (added.length > 0) changes.labelIds = added;
      else unchanged.push(field);
    } else if (field in CURRENT_VALUES && CURRENT_VALUES[field](issue) === value) unchanged.push(field);
    else changes[field] = value;
  }
  return { changes, unchanged };
}

function alreadyNote(issue: any, unchanged: string[]): string {
  const fields = unchanged.filter((field) => field !== "stateId").map((field) => field.replace(/Ids?$/, ""));
  const state = unchanged.includes("stateId") ? `in ${stateLabel(issue)}` : "";
  const rest = fields.length > 0 ? `set to the requested ${fields.join(", ")}` : "";
  return [state, rest].filter(Boolean).join(" and ");
}

export const updateIssue = (projectId: string, identifier: string, fields: IssueInput, requester: Requester | null) =>
  withAppConnection(projectId, async (auth, teamId) => {
    const found = await client.getIssue(auth, teamId, identifier);
    if (!found.ok) return `Nie udało się pobrać issue z Linear: ${found.error}`;
    if (!found.value) return `Nie znaleziono issue ${identifier} w zespole tego projektu.`;
    const resolved = await resolveFields(auth, teamId, fields, requester);
    if (!resolved.ok) return resolved.error;
    if (Object.keys(resolved.value).length === 0) return "Nie podano żadnych zmian.";
    const { changes, unchanged } = issueChanges(found.value, resolved.value);
    const already = unchanged.length > 0 ? `${found.value.identifier} was already ${alreadyNote(found.value, unchanged)}` : "";
    if (Object.keys(changes).length === 0) return `${already}; nothing changed.`;
    const { labelIds, ...input } = changes;
    const result = await client.updateIssue(auth, found.value.id, { ...input, ...(labelIds ? { addedLabelIds: labelIds } : {}) });
    if (!result.ok) return `Nie udało się zaktualizować issue w Linear: ${result.error}`;
    return `Zaktualizowano ${formatIssue(result.value)}${already ? ` (${already}, left as it was)` : ""}`;
  });

export const commentIssue = (projectId: string, identifier: string, body: string, requester: Requester | null) =>
  withAppConnection(projectId, async (auth, teamId) => {
    const found = await client.getIssue(auth, teamId, identifier);
    if (!found.ok) return `Nie udało się pobrać issue z Linear: ${found.error}`;
    if (!found.value) return `Nie znaleziono issue ${identifier} w zespole tego projektu.`;
    const result = await client.createComment(auth, { issueId: found.value.id, body, ...onBehalfOf(requester) });
    return result.ok
      ? `Dodano komentarz do ${found.value.identifier} — ${result.value.url}`
      : `Nie udało się dodać komentarza: ${result.error}`;
  });
