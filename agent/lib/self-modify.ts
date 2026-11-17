import { defineState } from "eve/context";
import type { SandboxSession } from "eve/sandbox";
import { getUser, isAdmin } from "../../lib/accounts.ts";
import type { ToolCtx } from "../../lib/agent/context.ts";
import type { SelfReviewFinding } from "../../lib/db/schema.ts";
import { ACTIVE_STATUSES, SELF_REVIEW_KIND, SELF_REVIEW_SLACK_ID } from "../../lib/self-review/rules.ts";
import { SELF_MODIFY_BRANCH_PREFIX } from "../../lib/self-modify-pulls.ts";
import { getFinding } from "../../lib/self-review/store.ts";

export const REPO_DIR = "/workspace/repo";
export const BASE_TAG = "manfrod-base";
export const TARGET_BRANCH = "main";
export const BRANCH_PREFIX = SELF_MODIFY_BRANCH_PREFIX;
export const MAX_FILES = 40;
export const MAX_BYTES = 500_000;

const ALLOWED = ["agent/", "lib/", "app/", "components/", "hooks/", "test/", "db/migrations/", "db/drizzle/"];
const BLOCKED = [
  "agent/agent.ts",
  "agent/lib/define-tool.ts",
  "agent/lib/e2b-sandbox.ts",
  "agent/lib/http.ts",
  "agent/lib/self-modify.ts",
  "agent/subagents/self-modify/",
  "agent/tools/github-",
  "agent/tools/link-github.ts",
  "agent/tools/http-request.ts",
  "agent/tools/request-capability.ts",
  "agent/tools/request-secret.ts",
  "agent/tools/self-modify-impact.ts",
  "lib/accounts.ts",
  "lib/agent/context.ts",
  "lib/auth.ts",
  "lib/auth-client.ts",
  "lib/auth-constants.ts",
  "lib/db/index.ts",
  "lib/github.ts",
  "lib/github/",
  "app/github/",
  "lib/sandboxes.ts",
  "lib/secrets.ts",
  "lib/security/",
  "lib/self-modify-lessons.ts",
  "lib/self-modify-merge/",
  "lib/self-modify-pulls.ts",
  "lib/self-review/",
  "lib/slack/secret-modal.ts",
  "lib/tasks/capabilities.ts",
  "lib/vault.ts",
  "lib/web/session.ts",
];

export interface Proposal {
  baseSha: string | null;
  branch: string | null;
  headSha: string | null;
  pullNumber: number | null;
  pullUrl: string | null;
}

export const proposal = defineState<Proposal>("manfrod.self-modify.proposal", () => ({
  baseSha: null,
  branch: null,
  headSha: null,
  pullNumber: null,
  pullUrl: null,
}));

export interface Change {
  path: string;
  status: "A" | "M" | "D";
  mode: string;
}

export type Requester = { kind: "admin"; name: string | null } | { kind: "self_review"; finding: SelfReviewFinding };

export async function authorize(ctx: ToolCtx): Promise<Requester | string> {
  const user = await getUser(ctx.userId);
  if (isAdmin(user)) return { kind: "admin", name: user?.name ?? null };
  if (ctx.kind === SELF_REVIEW_KIND && ctx.findingId && user?.slackId === SELF_REVIEW_SLACK_ID) {
    const finding = await getFinding(ctx.findingId);
    if (finding && (ACTIVE_STATUSES as readonly string[]).includes(finding.status)) return { kind: "self_review", finding };
  }
  return "Only an admin or Manfrod's self-review can do that.";
}

const MIGRATIONS_DIR = "db/migrations/";
const MIGRATION_NAME = /^db\/migrations\/\d{4}_[a-z0-9_]+\.sql$/;
const DESTRUCTIVE_SQL = /\b(drop|truncate)\b|\bdelete\s+from\b/i;

export function migrationViolation(change: Pick<Change, "path" | "status">, content: string | null): string | null {
  if (!change.path.startsWith(MIGRATIONS_DIR)) return null;
  if (change.status !== "A") return "existing migrations can't be changed; add a new numbered file";
  if (!MIGRATION_NAME.test(change.path)) return "migrations must be named db/migrations/NNNN_name.sql";
  if (content !== null && DESTRUCTIVE_SQL.test(content)) return "destructive SQL (DROP, TRUNCATE, DELETE FROM) isn't allowed in migrations";
  return null;
}

export function pathViolation(path: string): string | null {
  if (path.split("/").some((part) => part === ".." || part === ".git")) return "unsafe path";
  if (BLOCKED.some((prefix) => path === prefix || path.startsWith(prefix))) return "protected path";
  if (!ALLOWED.some((prefix) => path === prefix || path.startsWith(prefix))) return "outside the allowed paths";
  return null;
}

const NEW_TOOL = /^agent\/tools\/([a-z0-9-]+)\.ts$/;
const QUOTES = new Set(["'", '"', "`"]);

function skipString(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length && source[index] !== quote) index += source[index] === "\\" ? 2 : 1;
  return index + 1;
}

function readString(source: string, start: number): { value: string; end: number } | null {
  let index = start;
  while (/\s/.test(source[index] ?? "")) index += 1;
  if (source[index] !== "'" && source[index] !== '"') return null;
  const end = skipString(source, index);
  return { value: source.slice(index + 1, end - 1), end };
}

const DECLARATION_ENDS = new Set([
  "function",
  "class",
  "const",
  "let",
  "var",
  "interface",
  "enum",
  "async",
  "default",
  "abstract",
  "declare",
  "namespace",
]);

export function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  let inDeclaration = false;
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index);
      index = newline === -1 ? source.length : newline;
    } else if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      index = close === -1 ? source.length : close + 2;
    } else if (QUOTES.has(char)) {
      index = skipString(source, index);
    } else if (char === ";" || char === "=" || char === "(") {
      inDeclaration = false;
      index += 1;
    } else if (char === "}") {
      index += 1;
      if (!/^\s*from\b/.test(source.slice(index))) inDeclaration = false;
    } else if (/[A-Za-z_$]/.test(char) && !/[\w$.]/.test(source[index - 1] ?? "")) {
      const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(index))![0];
      index += word.length;
      let next = index;
      while (/\s/.test(source[next] ?? "")) next += 1;
      const specifier =
        word === "import" && source[next] === "("
          ? readString(source, next + 1)
          : word === "import" || (word === "from" && inDeclaration)
            ? readString(source, index)
            : null;
      if (specifier) {
        found.push(specifier.value);
        index = specifier.end;
        inDeclaration = false;
      } else if (word === "import" || word === "export") {
        inDeclaration = source[next] !== "(";
      } else if (DECLARATION_ENDS.has(word)) {
        inDeclaration = false;
      }
    } else {
      index += 1;
    }
  }
  return found;
}

export function missingToolTests(changes: Pick<Change, "path" | "status">[], contents: Map<string, Uint8Array>): string[] {
  const imported = changes
    .filter((change) => change.status !== "D" && change.path.startsWith("test/"))
    .flatMap((change) => importSpecifiers(new TextDecoder().decode(contents.get(change.path) ?? new Uint8Array())));
  return changes.flatMap((change) => {
    const name = change.status === "A" ? NEW_TOOL.exec(change.path)?.[1] : undefined;
    if (!name || imported.some((specifier) => specifier.endsWith(`/agent/tools/${name}.ts`))) return [];
    return [`${change.path}: a new tool needs a test under test/ that imports it and covers its access rules`];
  });
}

export async function sh(sandbox: SandboxSession, command: string, abortSignal?: AbortSignal) {
  const result = await sandbox.run({ command, workingDirectory: REPO_DIR, abortSignal });
  if (result.exitCode !== 0)
    throw new Error(`\`${command}\` failed with exit ${result.exitCode}: ${(result.stderr || result.stdout).slice(-2000)}`);
  return result.stdout;
}

const SNAPSHOT_FILE = "/tmp/manfrod-snapshot-file";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function snapshotTree(sandbox: SandboxSession): Promise<string> {
  return (await sh(sandbox, "git add -A && git write-tree")).trim();
}

export async function isSnapshot(sandbox: SandboxSession, tree: string): Promise<boolean> {
  if (!/^[0-9a-f]{40}$/.test(tree)) return false;
  const result = await sandbox.run({ command: `git cat-file -t ${tree}`, workingDirectory: REPO_DIR });
  return result.exitCode === 0 && result.stdout.trim() === "tree";
}

export async function snapshotFile(sandbox: SandboxSession, tree: string, path: string): Promise<Uint8Array | null> {
  await sh(sandbox, `git cat-file blob ${quote(`${tree}:${path}`)} > ${SNAPSHOT_FILE}`);
  return sandbox.readBinaryFile({ path: SNAPSHOT_FILE });
}

export async function localChanges(sandbox: SandboxSession, tree: string): Promise<Change[]> {
  const raw = await sh(sandbox, `git diff --raw --no-renames -z ${BASE_TAG} ${tree}`);
  const fields = raw.split("\0").filter((field) => field !== "");
  const changes: Change[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const match = /^:\d{6} (\d{6}) [0-9a-f]+ [0-9a-f]+ ([ADM])$/.exec(fields[index]);
    const path = fields[index + 1];
    if (!match || path === undefined) throw new Error("Could not parse the local git diff.");
    changes.push({ path, status: match[2] as Change["status"], mode: match[1] });
  }
  return changes;
}
