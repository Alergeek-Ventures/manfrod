import { defineAgent, defineDynamic } from "eve";
import { routeStep } from "../lib/agent/model-router.ts";

export default defineAgent({
  description: "Manfrod — the Alergeek Ventures Slack assistant with a shared notes graph.",
  defaultTools: false,
  build: { externalDependencies: ["sharp", "pg"] },
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) => routeStep(ctx.session.id, ctx.messages),
    },
  }),
});
