import { z } from "zod";
import { getAccount } from "../../lib/github/accounts.ts";
import {
  allowsPersonal,
  boardToken,
  connectionMessage,
  decideBoard,
  deniedMessage,
  githubErrorMessage,
  personalToken,
  resolveScope,
} from "../../lib/github/access.ts";
import { fetchBoard, filterItems, formatBoard } from "../../lib/github/board-items.ts";
import { listProjectBoards } from "../../lib/github/projects.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

const MAX_BOARDS = 3;

export default defineManfrodTool({
  description:
    "Read a GitHub Projects task board: items grouped by status, with assignees, iteration, other fields and the linked issue or pull request (number, state, url). In a project channel it defaults to the project's linked boards. Filter by status or assignee to keep it short.",
  inputSchema: z.object({
    board: z.string().optional().describe("Board as \"owner/number\" or a linked board's title; omit for this project's boards"),
    status: z.string().optional().describe("Only items whose status contains this text, e.g. 'In progress'"),
    assignee: z.string().optional().describe('Only items assigned to this GitHub login, or "me"'),
  }),
  label: { start: ({ board }) => (board ? `Read board ${board}` : "Read the project board") },
  async execute({ board, status, assignee }, ctx) {
    const scope = await resolveScope(ctx);
    const known = board?.trim() && allowsPersonal(scope) ? await listProjectBoards() : [];
    const decision = decideBoard(scope, board, known);
    if (decision.use === "denied") return deniedMessage(scope, decision.reason, "board");

    let login = assignee?.trim();
    if (login?.toLowerCase() === "me") {
      const account = await getAccount(ctx.userId);
      if (!account) return connectionMessage("not_connected");
      login = account.login;
    }

    try {
      if (decision.use === "user") {
        const token = await personalToken(ctx.userId);
        if (!token.ok) return token.message;
        const found = await fetchBoard(token.token, { owner: decision.owner, number: decision.number });
        if (!found) return `ERROR: Board ${decision.owner}/${decision.number} was not found or the person's GitHub account cannot see it.`;
        return formatBoard(found, filterItems(found.items, { status, assignee: login }));
      }
      const sections: string[] = [];
      for (const linked of decision.boards.slice(0, MAX_BOARDS)) {
        const token = await boardToken(scope, linked.ownerLogin, "installation");
        if (!token.ok) {
          sections.push(`${linked.title}: ${token.message}`);
          continue;
        }
        const found = await fetchBoard(token.token, { nodeId: linked.boardNodeId });
        sections.push(
          found
            ? formatBoard(found, filterItems(found.items, { status, assignee: login }))
            : `ERROR: Board ${linked.title} could not be read.`,
        );
      }
      if (decision.boards.length > MAX_BOARDS)
        sections.push(`…${decision.boards.length - MAX_BOARDS} more linked boards, pass board to read one`);
      return sections.join("\n\n");
    } catch (error) {
      return githubErrorMessage(error);
    }
  },
});
