import { defineAgent } from "eve";
import { CONTEXT_WINDOW_TOKENS } from "../../../lib/agent/model-router.ts";
import { BRAIN_MODEL, openrouterProvider } from "../../../lib/llm/index.ts";

export default defineAgent({
  description:
    "Changes Manfrod's own source code (skills, tools, prompts, instructions) in a sandboxed checkout, verifies it, and opens a GitHub pull request, marked ready for review once CI passes. It can also close pull requests it opened earlier. Only admins and your own self-review can use it; if the person asking is not an admin it reports that back. Use it when someone asks you to fix or change your own behavior, add a capability, or close one of your self-modify pull requests. Brief it with the exact request, why it is needed (quote the relevant conversation or feedback) and what good behavior looks like. After calling it, wait for its result with eve__task_wait before replying, then share the pull request link.",
  defaultTools: false,
  modelContextWindowTokens: CONTEXT_WINDOW_TOKENS,
  model: openrouterProvider().chat(BRAIN_MODEL, { usage: { include: true } }),
  modelOptions: { promptCache: { anthropic: {} } },
});
