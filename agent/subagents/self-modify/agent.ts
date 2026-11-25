import { defineAgent } from "eve";
import { CONTEXT_WINDOW_TOKENS } from "../../../lib/agent/model-router.ts";
import { BRAIN_MODEL, openrouterProvider } from "../../../lib/llm/index.ts";

export default defineAgent({
  description:
    "Changes Manfrod's own source code (skills, tools, prompts, instructions) in a sandboxed checkout, verifies it, and opens a GitHub pull request, marked ready for review once CI passes. It first checks its open pull requests: if one already does what is asked it points to it, and if one covers part of it, it adds to that one instead of opening a duplicate. It plans each change itself, has a coder subagent on a cheaper model write it, and an independent reviewer on another model checks every change before it is published. It can also close pull requests it opened earlier. Only admins and your own self-review can use it; if the person asking is not an admin it reports that back. Use it when someone asks you to fix or change your own behavior, add a capability, or close one of your self-modify pull requests. Brief it with the exact request, why it is needed (quote the relevant conversation or feedback) and what good behavior looks like. After calling it, wait for its result with eve__task_wait before replying, then share the pull request link and, in the same reply, whether it merges on its own (its result says so; if it doesn't, say in short why a person has to merge it). The auto-merge outcome and the later check on the deployed version are posted in this thread on their own; to check on them in between, use self-modify-status. When it comes back with a plan and questions instead, ask the person, then continue the same task with their answers.",
  defaultTools: false,
  modelContextWindowTokens: CONTEXT_WINDOW_TOKENS,
  model: openrouterProvider().chat(BRAIN_MODEL, { usage: { include: true } }),
  modelOptions: { promptCache: { anthropic: {} } },
});
