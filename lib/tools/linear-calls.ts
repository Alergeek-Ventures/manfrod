import * as client from "../linear/client.ts";
import { getConnection } from "../linear/index.ts";

function formatIssues(issues: any[]): string {
  if (issues.length === 0) return "Brak issues.";
  return issues
    .map((issue) => `${issue.identifier} [${issue.state?.name ?? "?"}] ${issue.title} (${issue.assignee?.name ?? "unassigned"}) — ${issue.url}`)
    .join("\n");
}

async function withConnection(projectId: string, run: (apiKey: string, teamId: string) => Promise<string>): Promise<string> {
  const connection = await getConnection(projectId);
  if (!connection?.apiKey || !connection.linearTeamId) return "Linear nie jest połączony dla tego projektu.";
  return run(connection.apiKey, connection.linearTeamId);
}

export const listIssues = (projectId: string, limit?: number) =>
  withConnection(projectId, async (apiKey, teamId) => {
    const result = await client.listIssues(apiKey, teamId, limit ?? 25);
    return result.ok ? formatIssues(result.value) : `Nie udało się pobrać issues z Linear: ${result.error}`;
  });

export const getIssue = (projectId: string, identifier: string) =>
  withConnection(projectId, async (apiKey, teamId) => {
    const result = await client.getIssue(apiKey, teamId, identifier);
    if (!result.ok) return `Nie udało się pobrać issue z Linear: ${result.error}`;
    const issue = result.value;
    if (!issue) return `Nie znaleziono issue ${identifier}.`;
    return `${issue.identifier} [${issue.state?.name ?? "?"}] ${issue.title} (${issue.assignee?.name ?? "unassigned"})\n${issue.description ?? "(no description)"}\n${issue.url}`;
  });

export const searchIssues = (projectId: string, term: string, limit?: number) =>
  withConnection(projectId, async (apiKey, teamId) => {
    const result = await client.searchIssues(apiKey, teamId, term, limit ?? 25);
    return result.ok ? formatIssues(result.value) : `Nie udało się wyszukać w Linear: ${result.error}`;
  });

export const listProjects = (projectId: string) =>
  withConnection(projectId, async (apiKey, teamId) => {
    const result = await client.listProjects(apiKey, teamId);
    if (!result.ok) return `Nie udało się pobrać projektów z Linear: ${result.error}`;
    if (result.value.length === 0) return "Brak projektów.";
    return result.value.map((project) => `${project.name} [${project.state}] — ${project.url}`).join("\n");
  });

export const getCycles = (projectId: string, limit?: number) =>
  withConnection(projectId, async (apiKey, teamId) => {
    const result = await client.listCycles(apiKey, teamId, limit ?? 10);
    if (!result.ok) return `Nie udało się pobrać cykli z Linear: ${result.error}`;
    if (result.value.length === 0) return "Brak cykli.";
    return result.value.map((cycle) => `Cycle ${cycle.number} ${cycle.name ?? ""} (${cycle.startsAt} → ${cycle.endsAt})`).join("\n");
  });
