import { logger } from "../log.ts";

const ENDPOINT = "https://api.linear.app/graphql";
const log = logger("Linear.Client");

export type LResult<T> = { ok: true; value: T } | { ok: false; error: string };

export async function query(authorization: string, document: string, variables: Record<string, unknown> = {}): Promise<LResult<any>> {
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ query: document, variables }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) return { ok: false, error: "unauthorized" };
    const body = (await response.json().catch(() => null)) as Record<string, any> | null;
    if (Array.isArray(body?.errors) && body.errors[0]?.message) {
      log.warn(`Linear.Client: GraphQL error: ${body.errors[0].message}`);
      return { ok: false, error: `{:graphql_error, ${JSON.stringify(body.errors[0].message)}}` };
    }
    if (response.status === 200 && body?.data) return { ok: true, value: body.data };
    log.warn(`Linear.Client: unexpected HTTP ${response.status}: ${JSON.stringify(body)}`);
    return { ok: false, error: `{:unexpected_status, ${response.status}}` };
  } catch (error) {
    log.warn(`Linear.Client: transport error: ${(error as Error).message}`);
    return { ok: false, error: (error as Error).message };
  }
}

const ISSUE_FIELDS = "identifier title state { name } assignee { name } url";

export interface Team {
  id: string;
  name: string;
  key: string;
}

export interface TeamContext {
  states: { id: string; name: string }[];
  members: { id: string; name: string; displayName: string; email: string }[];
  labels: { id: string; name: string }[];
  projects: { id: string; name: string }[];
  cycles: { id: string; number: number; name: string | null; isActive: boolean; isNext: boolean }[];
}

export async function viewer(
  authorization: string,
): Promise<LResult<{ userId: string; organizationId: string; organizationName: string }>> {
  const result = await query(authorization, "query { viewer { id } organization { id name } }");
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      userId: result.value.viewer.id,
      organizationId: result.value.organization.id,
      organizationName: result.value.organization.name,
    },
  };
}

export async function listTeams(authorization: string): Promise<LResult<Team[]>> {
  const result = await query(authorization, "query { teams(first: 100) { nodes { id name key } } }");
  return result.ok ? { ok: true, value: result.value.teams.nodes } : result;
}

export async function teamContext(authorization: string, teamId: string): Promise<LResult<TeamContext>> {
  const result = await query(
    authorization,
    `query($teamId: String!, $teamFilterId: ID!) {
      team(id: $teamId) {
        states { nodes { id name } }
        members(first: 250) { nodes { id name displayName email } }
        projects(first: 100) { nodes { id name } }
        cycles(first: 50, filter: { isPast: { eq: false } }) { nodes { id number name isActive isNext } }
      }
      issueLabels(first: 250, filter: { or: [{ team: { id: { eq: $teamFilterId } } }, { team: { null: true } }] }) { nodes { id name } }
    }`,
    { teamId, teamFilterId: teamId },
  );
  if (!result.ok) return result;
  const { team, issueLabels } = result.value;
  return {
    ok: true,
    value: {
      states: team.states.nodes,
      members: team.members.nodes,
      projects: team.projects.nodes,
      cycles: team.cycles.nodes,
      labels: issueLabels.nodes,
    },
  };
}

export async function listIssues(authorization: string, teamId: string, limit = 25): Promise<LResult<any[]>> {
  const result = await query(
    authorization,
    `query($teamId: ID!, $limit: Int!) { issues(filter: { team: { id: { eq: $teamId } } }, first: $limit, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } } }`,
    { teamId, limit },
  );
  return result.ok ? { ok: true, value: result.value.issues.nodes } : result;
}

export async function getIssue(authorization: string, teamId: string, identifier: string): Promise<LResult<any | null>> {
  const number = Number.parseInt(identifier.split("-").at(-1) ?? "", 10);
  if (Number.isNaN(number)) return { ok: true, value: null };
  const result = await query(
    authorization,
    `query($teamId: ID!, $identifier: Float!) { issues(filter: { team: { id: { eq: $teamId } }, number: { eq: $identifier } }, first: 1) { nodes { id identifier title description state { name } assignee { name } url } } }`,
    { teamId, identifier: number },
  );
  return result.ok ? { ok: true, value: result.value.issues.nodes[0] ?? null } : result;
}

export async function searchIssues(authorization: string, teamId: string, term: string, limit = 25): Promise<LResult<any[]>> {
  const result = await query(
    authorization,
    `query($teamId: String!, $term: String!, $limit: Int!) { searchIssues(teamId: $teamId, term: $term, first: $limit) { nodes { ${ISSUE_FIELDS} } } }`,
    { teamId, term, limit },
  );
  return result.ok ? { ok: true, value: result.value.searchIssues.nodes } : result;
}

export async function listProjects(authorization: string, teamId: string): Promise<LResult<any[]>> {
  const result = await query(authorization, "query($teamId: String!) { team(id: $teamId) { projects { nodes { id name state url } } } }", {
    teamId,
  });
  return result.ok ? { ok: true, value: result.value.team.projects.nodes } : result;
}

export async function listCycles(authorization: string, teamId: string, limit = 10): Promise<LResult<any[]>> {
  const result = await query(
    authorization,
    "query($teamId: String!, $limit: Int!) { team(id: $teamId) { cycles(first: $limit, orderBy: updatedAt) { nodes { number name startsAt endsAt } } } }",
    { teamId, limit },
  );
  return result.ok ? { ok: true, value: result.value.team.cycles.nodes } : result;
}

export async function createIssue(authorization: string, input: Record<string, unknown>): Promise<LResult<any>> {
  const result = await query(
    authorization,
    `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
    { input },
  );
  return result.ok ? { ok: true, value: result.value.issueCreate.issue } : result;
}

export async function updateIssue(authorization: string, id: string, input: Record<string, unknown>): Promise<LResult<any>> {
  const result = await query(
    authorization,
    `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
    { id, input },
  );
  return result.ok ? { ok: true, value: result.value.issueUpdate.issue } : result;
}

export async function createComment(authorization: string, input: Record<string, unknown>): Promise<LResult<any>> {
  const result = await query(
    authorization,
    "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { url } } }",
    {
      input,
    },
  );
  return result.ok ? { ok: true, value: result.value.commentCreate.comment } : result;
}

export async function issueByIdentifier(authorization: string, identifier: string): Promise<LResult<any>> {
  const result = await query(
    authorization,
    `query($id: String!) {
      issue(id: $id) {
        identifier title description url priority priorityLabel dueDate estimate
        state { name } assignee { name } team { id } project { name } cycle { number name } labels { nodes { name } }
      }
    }`,
    { id: identifier },
  );
  return result.ok ? { ok: true, value: result.value.issue } : result;
}
