import type { ToolCtx } from "../../lib/agent/context.ts";

export const NO_REPLY_SENT = "No reply was sent.";

export const DM_NEEDS_REPLY =
  "Not ended: this is a direct message and the person is waiting for you. Reply now in a few sentences: what you did, what you found and anything you assumed. If they only acknowledged or said goodbye, one short line is enough.";

export const isPersonDm = (tool: ToolCtx) => tool.kind === "slack" && (tool.msgCtx.channel?.startsWith("D") ?? false);

export const noReplyResult = (tool: ToolCtx) => (isPersonDm(tool) ? DM_NEEDS_REPLY : NO_REPLY_SENT);
