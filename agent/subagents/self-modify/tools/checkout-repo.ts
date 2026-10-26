import { z } from "zod";
import { branchSha, tarball } from "../../../../lib/github.ts";
import { defineManfrodTool } from "../../../lib/define-tool.ts";
import { BASE_TAG, proposal, REPO_DIR, sh, TARGET_BRANCH } from "../../../lib/self-modify.ts";
import { environment } from "../sandbox.ts";

const ARCHIVE = "/tmp/manfrod.tar.gz";

export default defineManfrodTool({
  description: `Check out the latest ${TARGET_BRANCH} of the Manfrod repository into ${REPO_DIR} and install its dependencies. Call it before anything else. Calling it again discards local changes and starts a new pull request.`,
  inputSchema: z.object({}),
  label: { start: () => `Checking out ${TARGET_BRANCH}`, complete: (_input, output) => output.split("\n")[0] },
  async execute(_input, _ctx, runtime) {
    const sha = await branchSha(TARGET_BRANCH);
    if (!sha) return `Branch ${TARGET_BRANCH} not found.`;
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
    proposal.update(() => ({ baseSha: sha, branch: null, headSha: null, pullNumber: null, pullUrl: null }));
    if (offline.exitCode !== 0) {
      return `Checked out ${TARGET_BRANCH} at ${sha.slice(0, 7)}, but pnpm install failed:\n${(offline.stderr || offline.stdout).slice(-2000)}`;
    }
    return `Checked out ${TARGET_BRANCH} at ${sha.slice(0, 7)} into ${REPO_DIR}; dependencies installed.`;
  },
});
