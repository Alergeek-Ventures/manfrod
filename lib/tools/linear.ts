import { getActiveMapping } from "../memory/access.ts";
import { getCycles, getIssue as fetchIssue, listIssues, listProjects, searchIssues } from "./linear-calls.ts";

export { fetchIssue, getCycles, listIssues, listProjects, searchIssues };

export async function linearProjectForChannel(channelId: string | null): Promise<string | null> {
  if (!channelId) return null;
  const mapping = await getActiveMapping(channelId);
  return mapping?.projectId ?? null;
}
