import { defineSandboxProvider, SandboxSessionGoneError, type SandboxConnection } from "eve/sandbox/provider";
import { deleteSandboxFiles, readSandboxFile, removeSandboxPath, writeSandboxFiles } from "../../lib/sandbox-files.ts";

function connect(sessionId: string): SandboxConnection {
  return {
    workspaceRoot: "/workspace",
    async spawn() {
      throw new Error("Manfrod's sandbox only stores attachments and cannot run commands.");
    },
    readFile: ({ path }) => readSandboxFile(sessionId, path),
    writeFiles: ({ files }) => writeSandboxFiles(sessionId, files),
    async removePath({ path, force, recursive }) {
      const removed = await removeSandboxPath(sessionId, path, recursive === true);
      if (removed === 0 && !force) throw new Error(`No such file in the attachment sandbox: ${path}`);
    },
    async stop() {},
  };
}

export const AttachmentSandbox = defineSandboxProvider({
  name: "attachments",
  environment() {
    return {
      async prepare() {
        return { version: 1 };
      },
      async start(ctx) {
        return { connection: connect(ctx.session.id), state: { sessionId: ctx.session.id } };
      },
      async resume(_ctx, _artifact, state) {
        if (typeof state?.sessionId !== "string") throw new SandboxSessionGoneError("Attachment sandbox state is missing its session.");
        return connect(state.sessionId);
      },
      async onSessionEnd(ctx) {
        await deleteSandboxFiles(ctx.session.id);
      },
    };
  },
});
