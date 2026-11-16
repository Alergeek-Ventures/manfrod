import { defineAgent } from "eve";
import { CONTEXT_WINDOW_TOKENS } from "../../../../../lib/agent/model-router.ts";
import { openrouterProvider, REVIEW_MODEL } from "../../../../../lib/llm/index.ts";

export default defineAgent({
  description:
    "An independent code reviewer on a different model. Call it after your change passes format, typecheck and tests, with the original request quoted, your plan, and what you verified. It reads the changes in your checkout, records a verdict and returns its findings; publish-proposal only publishes changes it has reviewed. Continue the same task for a re-review after fixing its findings.",
  defaultTools: false,
  modelContextWindowTokens: CONTEXT_WINDOW_TOKENS,
  model: openrouterProvider().chat(REVIEW_MODEL, { usage: { include: true } }),
});
