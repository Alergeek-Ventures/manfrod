import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const truthy = (value) => value === "1" || value === "true";

function parseDotenv(contents) {
  const env = {};
  const lines = contents.split(/\r?\n/);
  const closesQuote = (text, quote) => new RegExp(`(^|[^\\\\])${quote}$`).test(text);
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index].trim();
    const opening = /^(?:export )?[A-Za-z_][A-Za-z0-9_]*=(["'])(.*)$/.exec(line);
    if (opening && !closesQuote(opening[2], opening[1])) {
      while (index + 1 < lines.length) {
        line += `\n${lines[++index]}`;
        if (closesQuote(lines[index].trimEnd(), opening[1])) break;
      }
    }
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.replace(/^export /, "").indexOf("=");
    if (separator === -1) continue;
    const stripped = line.replace(/^export /, "");
    const key = stripped.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = stripped.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\n", "\n");
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      value = value.split(/\s+#/)[0].trim();
    }
    env[key] = value;
  }
  return env;
}

function infisicalEnv() {
  if (truthy(process.env.CI) || truthy(process.env.AV_SKIP_INFISICAL)) {
    console.error("with-env: skipping Infisical");
    return {};
  }

  const result = spawnSync(
    "infisical",
    ["export", "--env=dev", "--path=/app", "--format=dotenv", "--domain=https://infisical.alergeek.me", "--silent"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 },
  );

  if (result.error || result.status !== 0) {
    console.error(
      'with-env: Infisical export failed. Re-authenticate with `infisical login --domain="https://infisical.alergeek.me"`, or set AV_SKIP_INFISICAL=1 to work offline.',
    );
    process.exit(1);
  }

  return parseDotenv(result.stdout);
}

const env = { ...process.env, ...infisicalEnv() };

if (existsSync(".env.worktree")) {
  Object.assign(env, parseDotenv(readFileSync(".env.worktree", "utf8")));
}

const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: "inherit", env });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
