import { getUser } from "../accounts.ts";
import { getActiveMapping } from "../memory/access.ts";
import {
  commentIssue,
  createIssue,
  getCycles,
  getIssue as fetchIssue,
  listIssues,
  listProjects,
  type Requester,
  searchIssues,
  updateIssue,
} from "./linear-calls.ts";

export { commentIssue, createIssue, fetchIssue, getCycles, listIssues, listProjects, searchIssues, updateIssue };

export async function linearProjectForChannel(channelId: string | null): Promise<string | null> {
  if (!channelId) return null;
  const mapping = await getActiveMapping(channelId);
  return mapping?.projectId ?? null;
}

export async function linearRequester(userId: string | null | undefined): Promise<Requester | null> {
  const user = userId ? await getUser(userId) : null;
  return user ? { name: user.name, email: user.email, image: user.image } : null;
}
