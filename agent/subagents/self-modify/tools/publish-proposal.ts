import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  branchSha,
  commitTree,
  createBlob,
  createBranch,
  createCommit,
  createDraftPull,
  createTree,
  getPull,
  moveBranch,
  updatePull,
  type TreeEntry,
} from "../../../../lib/github.ts";
import { matches as secretRule } from "../../../../lib/security/gitleaks.ts";
import { PROPOSAL_FOOTER, recordPull } from "../../../../lib/self-modify-pulls.ts";
import { MAX_OPEN_PULLS } from "../../../../lib/self-review/rules.ts";
import { attachCapabilityPull } from "../../../../lib/tasks/capabilities.ts";
import { attachPull, countActive } from "../../../../lib/self-review/store.ts";
import { defineManfrodTool } from "../../../lib/define-tool.ts";
import {
  authorize,
  BRANCH_PREFIX,
  localChanges,
  MAX_BYTES,
  missingToolTests,
  MAX_FILES,
  migrationViolation,
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
    "Publish every change in the checkout as one commit on a GitHub pull request against main. The first call opens it as a draft; later calls, and calls after checking out an open pull request, add a commit to it and replace its title and description, so always describe the whole pull request. Validates allowed paths, file count, size and secrets first, and lists what it rejected.",
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
      .describe("Minimal English description of the whole pull request: a sentence or two per change, no headings"),
    commit_message: z.string().min(1).max(200).describe("Commit message for this round of changes"),
    risks: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        "In English: what you could not verify (e.g. calls to a real external API), new Slack scopes, environment variables or settings a person must add, and anything irreversible the change can do. Write 'None' if there is nothing",
      ),
  }),
  label: { start: ({ title }) => `Publishing: ${title}`, complete: (_input, output) => output.split("\n")[0] },
  async execute({ title, description, commit_message, risks }, ctx, runtime) {
    const requester = await authorize(ctx);
    if (typeof requester === "string") return requester;
    const state = proposal.get();
    if (!state.baseSha) return "Nothing is checked out; call checkout-repo first.";
    if (requester.kind === "self_review" && !state.pullNumber && (await countActive(requester.finding.id)) >= MAX_OPEN_PULLS) {
      return `Self-review already has ${MAX_OPEN_PULLS} pull requests in progress; nothing was published.`;
    }
    const sandbox = await runtime.getSandbox(environment);

    const changes = await localChanges(sandbox);
    if (changes.length === 0) return "There are no changes to publish.";
    const problems = changes.flatMap((change) => {
      const violation = pathViolation(change.path) ?? (change.status === "D" ? migrationViolation(change, null) : null);
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
      const text = new TextDecoder().decode(content);
      const rule = secretRule(text);
      if (rule) problems.push(`${change.path}: looks like it contains a secret (${rule})`);
      const migration = migrationViolation(change, text);
      if (migration) problems.push(`${change.path}: ${migration}`);
      contents.set(change.path, content);
    }
    if (bytes > MAX_BYTES) problems.push(`${bytes} bytes changed; the limit is ${MAX_BYTES}`);
    problems.push(...missingToolTests(changes, contents));
    if (problems.length > 0) return `Nothing was published. Fix these first:\n${problems.map((problem) => `- ${problem}`).join("\n")}`;
    if (state.pullNumber && state.branch) {
      const pull = await getPull(state.pullNumber);
      if (!pull || pull.merged || pull.state === "closed") {
        return `Pull request #${state.pullNumber} was ${pull?.merged ? "merged" : "closed"} after you checked it out; nothing was published. Call checkout-repo without pull_number to start a new pull request.`;
      }
      if ((await branchSha(state.branch)) !== state.headSha) {
        return `Branch ${state.branch} changed after your checkout; nothing was published. Call checkout-repo with pull_number ${state.pullNumber} again and redo your change on top of it.`;
      }
    }

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
    const origin =
      requester.kind === "self_review"
        ? " after its self-review of negative ratings"
        : requester.name
          ? ` at the request of ${requester.name}`
          : "";
    const body = `${description}\n\nRisks and unverified: ${risks.trim()}${PROPOSAL_FOOTER}${origin}.`;
    if (!pullNumber || !pullUrl) {
      ({ number: pullNumber, url: pullUrl } = await createDraftPull(branch, TARGET_BRANCH, title, body));
      if (requester.kind === "self_review") await attachPull(requester.finding.id, pullNumber, pullUrl);
    } else {
      await updatePull(pullNumber, title, body);
    }
    await recordPull(pullNumber, branch, runtime.session.id);
    if (ctx.capabilityRequestId) await attachCapabilityPull(ctx.capabilityRequestId, pullNumber, pullUrl);
    proposal.update((current) => ({ ...current, branch, headSha: commit, pullNumber, pullUrl }));

    const listed = changes.map((change) => `- ${change.status} ${change.path}`).join("\n");
    return `Published commit ${commit.slice(0, 7)} to pull request ${pullUrl}\nChanged files:\n${listed}`;
  },
});
