import { defineAgent } from "eve";
import { CONTEXT_WINDOW_TOKENS } from "../../../../../lib/agent/model-router.ts";
import { AGENT_MODEL, openrouterProvider } from "../../../../../lib/llm/index.ts";

export default defineAgent({
  description:
    "Writes the code for a plan you made, in your checkout, on a cheaper model. Give it the plan with the files to change, the approach, the tests to add and the rules that apply; it edits files, runs format, typecheck and tests, and reports what it changed and anything it could not follow. Continue the same task to send it review findings or corrections.",
  defaultTools: false,
  modelContextWindowTokens: CONTEXT_WINDOW_TOKENS,
  model: openrouterProvider().chat(AGENT_MODEL, { usage: { include: true } }),
  modelOptions: { promptCache: { anthropic: {} } },
});
