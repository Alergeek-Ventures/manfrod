import { defineTool, type ToolContext, type ToolLabelDefinition } from "eve/tools";
import type { z } from "zod";
import { toolCtx, type ToolCtx } from "../../lib/agent/context.ts";
import { runWithSecrets } from "../../lib/secrets.ts";

export function defineManfrodTool<S extends z.ZodObject>(definition: {
  description: string;
  inputSchema: S;
  keepSecretPlaceholders?: boolean;
  secretHost?: (input: z.infer<S>) => string | null;
  label?: ToolLabelDefinition<z.infer<S>, string>;
  execute: (input: z.infer<S>, ctx: ToolCtx, runtime: ToolContext) => Promise<string>;
}) {
  return defineTool({
    description: definition.description,
    inputSchema: definition.inputSchema,
    ...(definition.label ? { label: definition.label } : {}),
    execute: (input: z.infer<S>, ctx) => {
      const context = toolCtx(ctx);
      const use = {
        toolName: ctx.toolName,
        userId: context.userId,
        sessionKey: context.sessionKey,
        keepPlaceholders: definition.keepSecretPlaceholders,
        destinationHost: definition.secretHost?.(input) ?? null,
      };
      return runWithSecrets(use, input, (resolved) => definition.execute(resolved, context, ctx));
    },
  });
}
