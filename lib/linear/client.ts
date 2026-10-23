import { logger } from "../log.ts";

const ENDPOINT = "https://api.linear.app/graphql";
const log = logger("Linear.Client");

export type LResult<T> = { ok: true; value: T } | { ok: false; error: string };

export async function query(apiKey: string, document: string, variables: Record<string, unknown> = {}): Promise<LResult<any>> {
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: apiKey, "content-type": "application/json" },
      body: JSON.stringify({ query: document, variables }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) return { ok: false, error: "unauthorized" };
    const body = (await response.json().catch(() => null)) as Record<string, any> | null;
    if (response.status === 200 && Array.isArray(body?.errors) && body.errors[0]?.message) {
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

export async function verifyKey(apiKey: string): Promise<LResult<{ id: string; name: string }>> {
  const result = await query(apiKey, "query { organization { teams { nodes { id name } } } }");
  if (!result.ok) return result;
  const [team] = result.value.organization?.teams?.nodes ?? [];
  return team ? { ok: true, value: { id: team.id, name: team.name } } : { ok: false, error: "no_team_scoped" };
}

export async function listIssues(apiKey: string, teamId: string, limit = 25): Promise<LResult<any[]>> {
  const result = await query(
    apiKey,
    `query($teamId: ID!, $limit: Int!) { issues(filter: { team: { id: { eq: $teamId } } }, first: $limit, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } } }`,
    { teamId, limit },
  );
  return result.ok ? { ok: true, value: result.value.issues.nodes } : result;
}

export async function getIssue(apiKey: string, teamId: string, identifier: string): Promise<LResult<any | null>> {
  const number = Number.parseInt(identifier.split("-").at(-1) ?? "", 10);
  const result = await query(
    apiKey,
    `query($teamId: ID!, $identifier: Int!) { issues(filter: { team: { id: { eq: $teamId } }, number: { eq: $identifier } }, first: 1) { nodes { identifier title description state { name } assignee { name } url } } }`,
    { teamId, identifier: number },
  );
  return result.ok ? { ok: true, value: result.value.issues.nodes[0] ?? null } : result;
}

export async function searchIssues(apiKey: string, teamId: string, term: string, limit = 25): Promise<LResult<any[]>> {
  const result = await query(
    apiKey,
    `query($teamId: ID!, $term: String!, $limit: Int!) { issueSearch(filter: { team: { id: { eq: $teamId } } }, term: $term, first: $limit) { nodes { ${ISSUE_FIELDS} } } }`,
    { teamId, term, limit },
  );
  return result.ok ? { ok: true, value: result.value.issueSearch.nodes } : result;
}

export async function listProjects(apiKey: string, teamId: string): Promise<LResult<any[]>> {
  const result = await query(apiKey, "query($teamId: ID!) { team(id: $teamId) { projects { nodes { id name state url } } } }", {
    teamId,
  });
  return result.ok ? { ok: true, value: result.value.team.projects.nodes } : result;
}

export async function listCycles(apiKey: string, teamId: string, limit = 10): Promise<LResult<any[]>> {
  const result = await query(
    apiKey,
    "query($teamId: ID!, $limit: Int!) { team(id: $teamId) { cycles(first: $limit, orderBy: updatedAt) { nodes { number name startsAt endsAt } } } }",
    { teamId, limit },
  );
  return result.ok ? { ok: true, value: result.value.team.cycles.nodes } : result;
}
