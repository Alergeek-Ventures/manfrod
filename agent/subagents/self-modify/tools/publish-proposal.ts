import { randomBytes } from "node:crypto";
import { z } from "zod";
import { requireAdmin } from "../../../../lib/agent/context.ts";
import { getUser } from "../../../../lib/accounts.ts";
import {
  commitTree,
  createBlob,
  createBranch,
  createCommit,
  createDraftPull,
  createTree,
  moveBranch,
  type TreeEntry,
} from "../../../../lib/github.ts";
import { matches as secretRule } from "../../../../lib/security/gitleaks.ts";
import { defineManfrodTool } from "../../../lib/define-tool.ts";
import {
  BRANCH_PREFIX,
  localChanges,
  MAX_BYTES,
  MAX_FILES,
  pathViolation,
  proposal,
  REPO_DIR,
  TARGET_BRANCH,
} from "../../../lib/self-modify.ts";
import { environment } from "../sandbox.ts";

const MODES = new Set(["100644", "100755"]);

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Publish every change in the checkout as one commit on a GitHub pull request against main. The first call opens it as a draft; later calls add a commit to it. Validates allowed paths, file count, size and secrets first, and lists what it rejected.",
  inputSchema: z.object({
    title: z
      .string()
      .min(1)
      .max(100)
      .describe("Pull request title in English, conventional-commit style, e.g. 'fix(skills): confirm before booking a desk'"),
    description: z
      .string()
      .min(1)
      .max(4000)
      .describe("Minimal English pull request description: a sentence or two per change, no headings"),
    commit_message: z.string().min(1).max(200).describe("Commit message for this round of changes"),
  }),
  label: { start: ({ title }) => `Publishing: ${title}`, complete: (_input, output) => output.split("\n")[0] },
  async execute({ title, description, commit_message }, ctx, runtime) {
    const refusal = await requireAdmin(ctx.userId);
    if (refusal) return refusal;
    const state = proposal.get();
    if (!state.baseSha) return "Nothing is checked out; call checkout-repo first.";
    const sandbox = await runtime.getSandbox(environment);

    const changes = await localChanges(sandbox);
    if (changes.length === 0) return "There are no changes to publish.";
    const problems = changes.flatMap((change) => {
      const violation = pathViolation(change.path);
      if (violation) return [`${change.path}: ${violation}`];
      if (change.status !== "D" && !MODES.has(change.mode)) return [`${change.path}: unsupported file mode ${change.mode}`];
      return [];
    });
    if (changes.length > MAX_FILES) problems.push(`${changes.length} files changed; the limit is ${MAX_FILES}`);

    const entries: TreeEntry[] = [];
    const contents = new Map<string, Uint8Array>();
    let bytes = 0;
    for (const change of changes) {
      if (change.status === "D") continue;
      const content = await sandbox.readBinaryFile({ path: `${REPO_DIR}/${change.path}` });
      if (!content) {
        problems.push(`${change.path}: could not be read`);
        continue;
      }
      bytes += content.byteLength;
      const rule = secretRule(new TextDecoder().decode(content));
      if (rule) problems.push(`${change.path}: looks like it contains a secret (${rule})`);
      contents.set(change.path, content);
    }
    if (bytes > MAX_BYTES) problems.push(`${bytes} bytes changed; the limit is ${MAX_BYTES}`);
    if (problems.length > 0) return `Nothing was published. Fix these first:\n${problems.map((problem) => `- ${problem}`).join("\n")}`;

    for (const change of changes) {
      const content = contents.get(change.path);
      entries.push({ path: change.path, mode: change.mode as TreeEntry["mode"], sha: content ? await createBlob(content) : null });
    }
    const tree = await createTree(await commitTree(state.baseSha), entries);
    const commit = await createCommit(commit_message, tree, state.headSha ?? state.baseSha);

    let { branch, pullNumber, pullUrl } = state;
    if (branch) {
      await moveBranch(branch, commit);
    } else {
      branch = `${BRANCH_PREFIX}${randomBytes(4).toString("hex")}`;
      await createBranch(branch, commit);
    }
    if (!pullNumber || !pullUrl) {
      const requester = (await getUser(ctx.userId))?.name;
      const footer = `\n\n---\nProposed by Manfrod's self-modify agent${requester ? ` at the request of ${requester}` : ""}.`;
      ({ number: pullNumber, url: pullUrl } = await createDraftPull(branch, TARGET_BRANCH, title, description + footer));
    }
    proposal.update((current) => ({ ...current, branch, headSha: commit, pullNumber, pullUrl }));

    const listed = changes.map((change) => `- ${change.status} ${change.path}`).join("\n");
    return `Published commit ${commit.slice(0, 7)} to pull request ${pullUrl}\nChanged files:\n${listed}`;
  },
});
