import { z } from "zod";
import { branchSha, getPull, tarball } from "../../../../lib/github.ts";
import { defineManfrodTool } from "../../../lib/define-tool.ts";
import { authorize, BASE_TAG, BRANCH_PREFIX, proposal, REPO_DIR, sh, TARGET_BRANCH } from "../../../lib/self-modify.ts";
import { environment } from "../sandbox.ts";

const ARCHIVE = "/tmp/manfrod.tar.gz";

export default defineManfrodTool({
  description: `Check out the Manfrod repository into ${REPO_DIR} and install its dependencies: the latest ${TARGET_BRANCH} for a new pull request, or with pull_number the current state of one of your open self-modify pull requests to add to it. Call it before editing. Calling it again discards local changes.`,
  inputSchema: z.object({
    pull_number: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("An open self-modify pull request to continue instead of opening a new one, e.g. 207"),
  }),
  label: {
    start: ({ pull_number }) => (pull_number ? `Checking out pull request #${pull_number}` : `Checking out ${TARGET_BRANCH}`),
    complete: (_input, output) => output.split("\n")[0],
  },
  async execute({ pull_number }, ctx, runtime) {
    const requester = await authorize(ctx);
    if (typeof requester === "string") return requester;
    let continued: { branch: string; pullNumber: number; pullUrl: string } | null = null;
    if (pull_number) {
      if (requester.kind === "self_review" && requester.finding.pullNumber !== pull_number) {
        return "Self-review can only continue the pull request it opened for this finding.";
      }
      const pull = await getPull(pull_number);
      if (!pull) return `Pull request #${pull_number} not found.`;
      if (!pull.branch.startsWith(BRANCH_PREFIX))
        return `Pull request #${pull_number} was not opened by self-modify, so I can't continue it.`;
      if (pull.merged || pull.state === "closed")
        return `Pull request #${pull_number} is already ${pull.merged ? "merged" : "closed"}; start a new one without pull_number.`;
      continued = { branch: pull.branch, pullNumber: pull.number, pullUrl: pull.url };
    }
    const sha = await branchSha(continued?.branch ?? TARGET_BRANCH);
    if (!sha) return `Branch ${continued?.branch ?? TARGET_BRANCH} not found.`;
    const sandbox = await runtime.getSandbox(environment);
    await sandbox.writeFiles({ files: [{ path: ARCHIVE, content: await tarball(sha) }] });
    await sandbox.run({ command: `rm -rf ${REPO_DIR} && mkdir -p ${REPO_DIR}` });
    await sh(
      sandbox,
      [
        `tar -xzf ${ARCHIVE} --strip-components=1`,
        `rm ${ARCHIVE}`,
        "git init -q -b work",
        "git config user.name Manfrod && git config user.email manfrod@alergeek.ventures",
        "git add -A && git commit -qm base",
        `git tag ${BASE_TAG}`,
      ].join(" && "),
    );
    const install = "pnpm install --frozen-lockfile --prefer-offline";
    let offline = await sandbox.run({ command: `${install} --offline`, workingDirectory: REPO_DIR });
    if (offline.exitCode !== 0) {
      await sandbox.setNetworkPolicy({ allow: ["registry.npmjs.org"] });
      try {
        offline = await sandbox.run({ command: install, workingDirectory: REPO_DIR });
      } finally {
        await sandbox.setNetworkPolicy("deny-all");
      }
    }
    proposal.update(() => ({
      baseSha: sha,
      branch: continued?.branch ?? null,
      headSha: continued ? sha : null,
      pullNumber: continued?.pullNumber ?? null,
      pullUrl: continued?.pullUrl ?? null,
    }));
    const what = continued ? `pull request #${continued.pullNumber} (${continued.branch})` : TARGET_BRANCH;
    if (offline.exitCode !== 0) {
      return `Checked out ${what} at ${sha.slice(0, 7)}, but pnpm install failed:\n${(offline.stderr || offline.stdout).slice(-2000)}`;
    }
    const next = continued
      ? " Your next publish-proposal adds a commit to it and replaces its title and description, so describe the whole pull request."
      : "";
    return `Checked out ${what} at ${sha.slice(0, 7)} into ${REPO_DIR}; dependencies installed.${next}`;
  },
});
