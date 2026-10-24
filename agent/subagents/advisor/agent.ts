import { defineAgent } from "eve";
import { CONTEXT_WINDOW_TOKENS } from "../../../lib/agent/model-router.ts";
import { BRAIN_MODEL, openrouterProvider } from "../../../lib/llm/index.ts";

export default defineAgent({
  description:
    "A senior advisor running on a stronger model. Ask it to think through a hard decision, plan a multi-step task, or check reasoning before acting. Give it a self-contained brief with the relevant facts — it cannot see the conversation, your tools or memory.",
  defaultTools: false,
  modelContextWindowTokens: CONTEXT_WINDOW_TOKENS,
  model: openrouterProvider().chat(BRAIN_MODEL, { usage: { include: true } }),
});
