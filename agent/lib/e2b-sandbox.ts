import { createHash } from "node:crypto";
import {
  ALL_TRAFFIC,
  CommandExitError,
  NotFoundError,
  Sandbox,
  type SandboxNetworkRule as E2BNetworkRule,
  type SandboxNetworkUpdate,
} from "e2b";
import type { SandboxNetworkPolicy, SandboxNetworkRule } from "eve/sandbox";
import {
  defineSandboxProvider,
  SANDBOX_AGENT_ENV,
  SandboxSessionGoneError,
  SandboxTemplateNotProvisionedError,
  type SandboxConnection,
} from "eve/sandbox/provider";

export const E2B_TEMPLATE = "manfrod-sandbox";

const PROVIDER = "e2b";
const WORKSPACE_ROOT = "/workspace";
const METADATA_KEY = "eveSandbox";
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

type Extensions = { setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void> };

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

function toRule(rule: SandboxNetworkRule): E2BNetworkRule {
  if (rule.match !== undefined || !("transform" in rule)) {
    throw new Error("E2B sandboxes support only unconditional header transforms in network rules.");
  }
  return { transform: { headers: Object.assign({}, ...rule.transform.map((transform) => transform.headers ?? {})) } };
}

export function toE2BNetwork(policy: SandboxNetworkPolicy): SandboxNetworkUpdate {
  if (policy === "allow-all") return {};
  if (policy === "deny-all") return { denyOut: [ALL_TRAFFIC] };
  const allow = policy.allow ?? [];
  const domains = Array.isArray(allow) ? [...allow] : Object.keys(allow);
  const rules = Array.isArray(allow)
    ? undefined
    : Object.fromEntries(Object.entries(allow).map(([domain, list]) => [domain, list.map(toRule)]));
  return {
    allowOut: [...domains, ...(policy.subnets?.allow ?? [])],
    denyOut: [ALL_TRAFFIC, ...(policy.subnets?.deny ?? [])],
    ...(rules ? { rules } : {}),
  };
}

async function exec(sandbox: Sandbox, command: string, signal?: AbortSignal) {
  try {
    return await sandbox.commands.run(command, { cwd: "/", timeoutMs: 60_000, signal });
  } catch (error) {
    if (error instanceof CommandExitError) return error;
    throw error;
  }
}

function connect(sandbox: Sandbox): SandboxConnection<Extensions> {
  return {
    workspaceRoot: WORKSPACE_ROOT,

    async spawn({ abortSignal, command, env, workingDirectory }) {
      abortSignal?.throwIfAborted();
      const encoder = new TextEncoder();
      const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
      const stream = () => new ReadableStream<Uint8Array>({ start: (controller) => void controllers.push(controller) });
      const stdout = stream();
      const stderr = stream();
      const push = (controller: ReadableStreamDefaultController<Uint8Array>, data: string) => {
        try {
          controller.enqueue(encoder.encode(data));
        } catch {}
      };
      const handle = await sandbox.commands.run(`exec setsid -w /bin/bash -lc ${shellQuote(command)}`, {
        background: true,
        cwd: workingDirectory,
        envs: { ...env },
        timeoutMs: 0,
        onStdout: (data) => push(controllers[0], data),
        onStderr: (data) => push(controllers[1], data),
      });
      const kill = async () => {
        await exec(sandbox, `kill -KILL -- -${handle.pid} 2>/dev/null; true`).catch(() => undefined);
        await handle.kill().catch(() => undefined);
      };
      abortSignal?.addEventListener("abort", kill, { once: true });
      const exitCode = handle
        .wait()
        .then(
          (result) => result.exitCode,
          (error) => {
            if (error instanceof CommandExitError) return error.exitCode;
            throw error;
          },
        )
        .finally(() => {
          abortSignal?.removeEventListener("abort", kill);
          for (const controller of controllers) {
            try {
              controller.close();
            } catch {}
          }
        });
      exitCode.catch(() => undefined);
      return { pid: handle.pid, stdout, stderr, kill, wait: async () => ({ exitCode: await exitCode }) };
    },

    async readFile({ abortSignal, path }) {
      try {
        return await sandbox.files.read(path, { format: "bytes", signal: abortSignal });
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },

    async writeFiles({ abortSignal, files }) {
      if (files.length === 0) return;
      await sandbox.files.write(
        files.map((file) => ({ path: file.path, data: new Blob([file.content.slice()]) })),
        { signal: abortSignal },
      );
    },

    async removePath({ abortSignal, force, path, recursive }) {
      const target = shellQuote(path);
      const flag = force ? "-f " : "";
      const script = recursive
        ? `rm -r ${flag}-- ${target}`
        : `if [ -d ${target} ] && [ ! -L ${target} ]; then rmdir -- ${target}; else rm ${flag}-- ${target}; fi`;
      const result = await exec(sandbox, script, abortSignal);
      if (result.exitCode !== 0) throw new Error(`Could not remove ${path}: ${result.stderr.trim()}`);
    },

    async stop() {
      try {
        await sandbox.pause();
      } catch (error) {
        if (error instanceof NotFoundError) return;
        if ((await sandbox.getInfo()).state !== "paused") throw error;
      }
    },

    extensions: {
      setNetworkPolicy: (policy) => sandbox.updateNetwork(toE2BNetwork(policy)),
    },
  };
}

export const E2BSandbox = defineSandboxProvider({
  name: PROVIDER,
  environment(options: { template?: string; timeoutMs?: number; envs?: Record<string, string> }) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const keyFor = (sessionId: string) => createHash("sha256").update(`manfrod:${sessionId}`).digest("hex").slice(0, 32);

    const find = async (key: string) => {
      const found = await Sandbox.list({ query: { metadata: { [METADATA_KEY]: key } } }).nextItems();
      return found.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    };

    const create = async (key: string, template: string, networkPolicy: SandboxNetworkPolicy | undefined) => {
      let sandbox: Sandbox;
      try {
        sandbox = await Sandbox.create(template, {
          metadata: { [METADATA_KEY]: key },
          envs: { ...SANDBOX_AGENT_ENV, ...options.envs },
          timeoutMs,
          lifecycle: { onTimeout: "pause" },
          ...(networkPolicy && networkPolicy !== "allow-all" ? { network: toE2BNetwork(networkPolicy) } : {}),
        });
      } catch (error) {
        if (error instanceof NotFoundError) {
          throw new SandboxTemplateNotProvisionedError({
            providerName: PROVIDER,
            reason: `E2B template "${template}" does not exist; build it with pnpm sandbox:template.`,
            templateKey: template,
          });
        }
        throw error;
      }
      const [oldest] = await find(key);
      if (!oldest || oldest.sandboxId === sandbox.sandboxId) return sandbox;
      await sandbox.kill();
      return Sandbox.connect(oldest.sandboxId, { timeoutMs });
    };

    return {
      async prepare(ctx) {
        if (!ctx.isEmpty) throw new Error("The E2B sandbox cannot seed workspace or skill files; bake them into the template.");
        return { template: options.template ?? E2B_TEMPLATE };
      },

      async start(ctx, open: { networkPolicy?: SandboxNetworkPolicy } | undefined, artifact) {
        const key = keyFor(ctx.session.id);
        const [existing] = await find(key);
        const sandbox = existing
          ? await Sandbox.connect(existing.sandboxId, { timeoutMs })
          : await create(key, artifact.template, open?.networkPolicy);
        return { connection: connect(sandbox), state: { sandboxId: sandbox.sandboxId } };
      },

      async resume(_ctx, _artifact, state) {
        try {
          return connect(await Sandbox.connect(state.sandboxId, { timeoutMs }));
        } catch (error) {
          if (error instanceof NotFoundError) throw new SandboxSessionGoneError(`E2B sandbox ${state.sandboxId} is gone.`);
          throw error;
        }
      },

      async onSessionEnd(ctx, state) {
        const ids = new Set((await find(keyFor(ctx.session.id))).map((sandbox) => sandbox.sandboxId));
        if (state) ids.add(state.sandboxId);
        await Promise.all([...ids].map((id) => Sandbox.kill(id)));
      },
    };
  },
});
