import { defineTool } from "eve/tools";
import type { z } from "zod";
import { toolCtx, type ToolCtx } from "../../lib/agent/context.ts";
import { runWithSecrets } from "../../lib/secrets.ts";

export function defineManfrodTool<S extends z.ZodObject>(definition: {
  description: string;
  inputSchema: S;
  keepSecretPlaceholders?: boolean;
  execute: (input: z.infer<S>, ctx: ToolCtx) => Promise<string>;
}) {
  return defineTool({
    description: definition.description,
    inputSchema: definition.inputSchema,
    execute: (input: z.infer<S>, ctx) => {
      const context = toolCtx(ctx);
      const use = {
        toolName: ctx.toolName,
        userId: context.userId,
        sessionKey: context.sessionKey,
        keepPlaceholders: definition.keepSecretPlaceholders,
      };
      return runWithSecrets(use, input, (resolved) => definition.execute(resolved, context));
    },
  });
}
