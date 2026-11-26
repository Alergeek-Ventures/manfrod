import { getActiveMapping } from "../memory/access.ts";
import { getConnection, type LinearMode } from "./index.ts";

export const LINEAR_TOOL_ACCESS = {
  "linear-list-issues": { write: false, projectOnly: false },
  "linear-get-issue": { write: false, projectOnly: false },
  "linear-search-issues": { write: false, projectOnly: false },
  "linear-list-projects": { write: false, projectOnly: true },
  "linear-list-cycles": { write: false, projectOnly: true },
  "linear-create-issue": { write: true, projectOnly: false },
  "linear-update-issue": { write: true, projectOnly: false },
  "linear-comment-issue": { write: true, projectOnly: false },
} as const;

export type LinearToolName = keyof typeof LINEAR_TOOL_ACCESS;

export type LinearScope =
  | { kind: "project"; projectId: string; mode: LinearMode; projectName: string | null; teamName: string | null }
  | { kind: "dm" }
  | { kind: "none"; projectName: string | null };

export interface LinearScopeInput {
  channel: string | null;
  projectId: string | null;
  projectName: string | null;
  mode: LinearMode | null;
  teamName: string | null;
}

export function linearScope({ channel, projectId, projectName, mode, teamName }: LinearScopeInput): LinearScope {
  if (projectId && mode) return { kind: "project", projectId, mode, projectName, teamName };
  if (!projectId && channel?.startsWith("D")) return { kind: "dm" };
  return { kind: "none", projectName };
}

export function linearToolNames(scope: LinearScope): LinearToolName[] {
  const names = Object.keys(LINEAR_TOOL_ACCESS) as LinearToolName[];
  if (scope.kind === "none") return [];
  return scope.kind === "dm" ? names.filter((name) => !LINEAR_TOOL_ACCESS[name].projectOnly) : names;
}

export async function channelLinearScope(channel: string | null): Promise<LinearScope> {
  const mapping = channel ? await getActiveMapping(channel) : null;
  const projectId = mapping?.projectId ?? null;
  const connection = projectId ? await getConnection(projectId) : null;
  return linearScope({
    channel,
    projectId,
    projectName: mapping?.project?.name ?? null,
    mode: connection?.mode ?? null,
    teamName: connection?.linearTeamName ?? null,
  });
}
