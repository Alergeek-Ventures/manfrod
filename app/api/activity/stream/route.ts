import { eq } from "drizzle-orm";
import { isAdmin } from "@/lib/accounts.ts";
import { db, tables } from "@/lib/db/index.ts";
import { toActivity } from "@/lib/events/index.ts";
import { subscribeAuditEvents } from "@/lib/events/listener.ts";
import { serializeActivity } from "@/lib/web/activity.ts";
import { currentUser } from "@/lib/web/session.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PING_INTERVAL_MS = 25_000;

export async function GET(request: Request) {
  const user = await currentUser();
  if (!user || !isAdmin(user)) return new Response("forbidden", { status: 403 });

  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          close();
        }
      };
      const unsubscribe = await subscribeAuditEvents(async (id) => {
        const [row] = await db.select().from(tables.auditEvents).where(eq(tables.auditEvents.id, id)).limit(1);
        if (row) send(`data: ${JSON.stringify(serializeActivity(toActivity(row)))}\n\n`);
      });
      const ping = setInterval(() => send(": ping\n\n"), PING_INTERVAL_MS);
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        unsubscribe();
        try {
          controller.close();
        } catch {}
      };
      cleanup = close;
      request.signal.addEventListener("abort", close);
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
  });
}
