import { and, eq, like, lt, or, sql } from "drizzle-orm";
import { db, tables } from "./db/index.ts";

const { sandboxFiles } = tables;

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

const inSession = (sessionId: string) => eq(sandboxFiles.sessionId, sessionId);

export async function readSandboxFile(sessionId: string, path: string): Promise<Buffer | null> {
  const [row] = await db
    .select({ content: sandboxFiles.content })
    .from(sandboxFiles)
    .where(and(inSession(sessionId), eq(sandboxFiles.path, path)))
    .limit(1);
  return row?.content ?? null;
}

export async function writeSandboxFiles(sessionId: string, files: readonly { path: string; content: Uint8Array }[]) {
  const byPath = new Map(files.map((file) => [file.path, Buffer.from(file.content)]));
  if (byPath.size === 0) return;
  await db
    .insert(sandboxFiles)
    .values([...byPath].map(([path, content]) => ({ sessionId, path, content })))
    .onConflictDoUpdate({
      target: [sandboxFiles.sessionId, sandboxFiles.path],
      set: { content: sql`excluded.content`, insertedAt: sql`timezone('UTC'::text, now())` },
    });
}

export async function removeSandboxPath(sessionId: string, path: string, recursive: boolean): Promise<number> {
  const exact = eq(sandboxFiles.path, path);
  const target = recursive ? or(exact, like(sandboxFiles.path, `${escapeLike(path.replace(/\/+$/, ""))}/%`)) : exact;
  const removed = await db
    .delete(sandboxFiles)
    .where(and(inSession(sessionId), target))
    .returning({ path: sandboxFiles.path });
  return removed.length;
}

export async function deleteSandboxFiles(sessionId: string) {
  await db.delete(sandboxFiles).where(inSession(sessionId));
}

export async function deleteSandboxFilesOlderThan(days: number) {
  await db.delete(sandboxFiles).where(lt(sandboxFiles.insertedAt, new Date(Date.now() - days * 24 * 60 * 60 * 1000)));
}
