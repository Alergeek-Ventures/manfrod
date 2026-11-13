import { graphql } from "./api.ts";

const MAX_PAGES = 5;
const MAX_ITEMS_SHOWN = 150;

const FIELD = "field { ... on ProjectV2FieldCommon { name } }";

const BOARD_FIELDS = `
  title
  url
  closed
  items(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      isArchived
      type
      fieldValues(first: 20) {
        nodes {
          ... on ProjectV2ItemFieldSingleSelectValue { name ${FIELD} }
          ... on ProjectV2ItemFieldIterationValue { title startDate ${FIELD} }
          ... on ProjectV2ItemFieldTextValue { text ${FIELD} }
          ... on ProjectV2ItemFieldDateValue { date ${FIELD} }
          ... on ProjectV2ItemFieldNumberValue { number ${FIELD} }
        }
      }
      content {
        ... on Issue { title number state url repository { nameWithOwner } assignees(first: 10) { nodes { login } } }
        ... on PullRequest { title number state url repository { nameWithOwner } assignees(first: 10) { nodes { login } } }
        ... on DraftIssue { title assignees(first: 10) { nodes { login } } }
      }
    }
  }
`;

const BY_NUMBER = `query($owner: String!, $number: Int!, $after: String) {
  organization(login: $owner) { projectV2(number: $number) { ${BOARD_FIELDS} } }
  user(login: $owner) { projectV2(number: $number) { ${BOARD_FIELDS} } }
}`;

const BY_NODE = `query($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2 { ${BOARD_FIELDS} } } }`;

interface RawFieldValue {
  name?: string;
  title?: string;
  startDate?: string;
  text?: string;
  date?: string;
  number?: number;
  field?: { name?: string };
}

export interface RawItem {
  isArchived: boolean;
  type: string;
  fieldValues: { nodes: (RawFieldValue | null)[] };
  content: {
    title?: string;
    number?: number;
    state?: string;
    url?: string;
    repository?: { nameWithOwner: string };
    assignees?: { nodes: { login: string }[] };
  } | null;
}

export interface RawBoard {
  title: string;
  url: string;
  closed: boolean;
  items: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawItem[] };
}

export interface BoardItem {
  title: string;
  type: string;
  status: string | null;
  iteration: string | null;
  fields: Record<string, string>;
  assignees: string[];
  reference: string | null;
  state: string | null;
  url: string | null;
}

export interface Board {
  title: string;
  url: string;
  items: BoardItem[];
  truncated: boolean;
}

export function toBoardItem(raw: RawItem): BoardItem {
  const fields: Record<string, string> = {};
  let status: string | null = null;
  let iteration: string | null = null;
  for (const value of raw.fieldValues.nodes) {
    const name = value?.field?.name;
    if (!value || !name || name === "Title") continue;
    if (value.title !== undefined) {
      iteration = value.startDate ? `${value.title} (from ${value.startDate})` : value.title;
      continue;
    }
    const text = value.name ?? value.text ?? value.date ?? (value.number === undefined ? undefined : String(value.number));
    if (text === undefined) continue;
    if (name.toLowerCase() === "status") status = text;
    else fields[name] = text;
  }
  const content = raw.content;
  return {
    title: content?.title ?? "(no access to this item)",
    type: raw.type,
    status,
    iteration,
    fields,
    assignees: content?.assignees?.nodes.map((assignee) => assignee.login) ?? [],
    reference: content?.repository && content.number !== undefined ? `${content.repository.nameWithOwner}#${content.number}` : null,
    state: content?.state?.toLowerCase() ?? null,
    url: content?.url ?? null,
  };
}

export function filterItems(items: BoardItem[], filter: { status?: string; assignee?: string }): BoardItem[] {
  const status = filter.status?.trim().toLowerCase();
  const assignee = filter.assignee?.trim().replace(/^@/, "").toLowerCase();
  return items.filter(
    (item) =>
      (!status || (item.status ?? "no status").toLowerCase().includes(status)) &&
      (!assignee || item.assignees.some((login) => login.toLowerCase() === assignee)),
  );
}

export function formatBoard(board: Board, items: BoardItem[]): string {
  const header = `${board.title} ${board.url}`;
  const truncated = board.truncated ? `\n(only the first ${MAX_PAGES * 100} items of the board were read)` : "";
  if (items.length === 0) return `${header}\nNo items match.${truncated}`;
  const groups = new Map<string, BoardItem[]>();
  for (const item of items.slice(0, MAX_ITEMS_SHOWN)) {
    const key = item.status ?? "No status";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const sections = [...groups].map(([status, group]) => {
    const lines = group.map((item) => {
      const parts = [
        item.reference ? `${item.reference} ${item.title}` : `${item.title} (${item.type.toLowerCase().replaceAll("_", " ")})`,
      ];
      if (item.state) parts.push(item.state);
      parts.push(item.assignees.length > 0 ? item.assignees.join(", ") : "unassigned");
      if (item.iteration) parts.push(`iteration: ${item.iteration}`);
      parts.push(...Object.entries(item.fields).map(([name, value]) => `${name}: ${value}`));
      if (item.url) parts.push(item.url);
      return `- ${parts.join(" | ")}`;
    });
    return `${status} (${group.length}):\n${lines.join("\n")}`;
  });
  const more = items.length > MAX_ITEMS_SHOWN ? `\n…${items.length - MAX_ITEMS_SHOWN} more items, filter by status or assignee` : "";
  return `${header}\n${sections.join("\n\n")}${more}${truncated}`;
}

type Locator = { nodeId: string } | { owner: string; number: number };

async function boardPage(token: string, locator: Locator, after: string | null): Promise<RawBoard | null> {
  if ("nodeId" in locator) {
    const data = await graphql<{ node: RawBoard | null }>(token, BY_NODE, { id: locator.nodeId, after });
    return data.node?.items ? data.node : null;
  }
  const data = await graphql<{ organization: { projectV2: RawBoard | null } | null; user: { projectV2: RawBoard | null } | null }>(
    token,
    BY_NUMBER,
    { owner: locator.owner, number: locator.number, after },
  ).catch((error: unknown) => {
    if (error instanceof Error && /Could not resolve/i.test(error.message)) return { organization: null, user: null };
    throw error;
  });
  return data.organization?.projectV2 ?? data.user?.projectV2 ?? null;
}

export async function fetchBoard(token: string, locator: Locator): Promise<Board | null> {
  const items: BoardItem[] = [];
  let after: string | null = null;
  let first: RawBoard | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const board: RawBoard | null = await boardPage(token, locator, after);
    if (!board) return first ? { title: first.title, url: first.url, items, truncated: false } : null;
    first ??= board;
    items.push(...board.items.nodes.filter((item) => !item.isArchived).map(toBoardItem));
    if (!board.items.pageInfo.hasNextPage) return { title: board.title, url: board.url, items, truncated: false };
    after = board.items.pageInfo.endCursor;
  }
  return first ? { title: first.title, url: first.url, items, truncated: true } : null;
}
