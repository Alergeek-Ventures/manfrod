import { defineChannel, GET, POST, PUT, type RouteHandlerArgs } from "eve/channels";
import { serve } from "inngest/edge";
import { inngest } from "../../lib/inngest/client.ts";
import { functions } from "../../lib/inngest/functions.ts";
import { withAgentRuntime, type SessionEvent } from "../../lib/inngest/runtime.ts";
import slack from "./slack.ts";

const handler = serve({ client: inngest, functions, servePath: "/api/inngest" });

function run(request: Request, args: RouteHandlerArgs) {
  return withAgentRuntime(
    {
      sendToSlack: (target, message, auth) => args.to(slack, target).send(message, { auth, turnPolicy: "queue" }),
      startHeadless: async (address, message, auth, history) =>
        (await args.from(address).send(message, { auth, history, turnPolicy: "queue" })).id,
      sessionEvents: async (sessionId) => {
        const events: SessionEvent[] = [];
        const reader = (await args.attachSession(sessionId).getEventStream({ follow: false })).getReader();
        for (let next = await reader.read(); !next.done; next = await reader.read()) events.push(next.value as SessionEvent);
        return events;
      },
      endSession: async (sessionId) => {
        await args.attachSession(sessionId).reset({ reason: "Rehearsal finished" });
      },
      waitUntil: (task) => args.waitUntil(task),
    },
    () => handler(request),
  );
}

export default defineChannel({
  routes: [GET("/api/inngest", run), POST("/api/inngest", run), PUT("/api/inngest", run)],
});
