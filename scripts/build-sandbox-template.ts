import { readFileSync } from "node:fs";
import { defaultBuildLogger, Template } from "e2b";
import { E2B_TEMPLATE } from "../agent/lib/e2b-sandbox.ts";

const { packageManager } = JSON.parse(readFileSync("package.json", "utf8"));

const template = Template({ fileContextPath: process.cwd() })
  .fromNodeImage("24")
  .aptInstall(["git", "ripgrep", "jq"], { noInstallRecommends: true })
  .runCmd(["corepack enable", "mkdir -p /workspace /home/user/deps", "chown user:user /workspace /home/user/deps"], { user: "root" })
  .setUser("user")
  .runCmd(`corepack prepare ${packageManager} --activate`)
  .copy(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"], "/home/user/deps/", { user: "user" })
  .setWorkdir("/home/user/deps")
  .runCmd("pnpm install --frozen-lockfile")
  .setWorkdir("/workspace");

const build = await Template.build(template, E2B_TEMPLATE, {
  cpuCount: 2,
  memoryMB: 4096,
  onBuildLogs: defaultBuildLogger(),
});
console.log(`Built ${build.name} (${build.templateId}, build ${build.buildId})`);
