import { defineChannel, GET, POST, PUT, type RouteHandlerArgs } from "eve/channels";
import { serve } from "inngest/edge";
import { inngest } from "../../lib/inngest/client.ts";
import { functions } from "../../lib/inngest/functions.ts";
import { withAgentRuntime } from "../../lib/inngest/runtime.ts";
import slack from "./slack.ts";

const handler = serve({ client: inngest, functions, servePath: "/api/inngest" });

function run(request: Request, args: RouteHandlerArgs) {
  return withAgentRuntime(
    {
      sendToSlack: (target, message, auth) => args.to(slack, target).send(message, { auth, turnPolicy: "queue" }),
      waitUntil: (task) => args.waitUntil(task),
    },
    () => handler(request),
  );
}

export default defineChannel({
  routes: [GET("/api/inngest", run), POST("/api/inngest", run), PUT("/api/inngest", run)],
});
