import { isUuid } from "../accounts.ts";
import { config } from "../config.ts";
import { LINEAR_TOOL_ACCESS, channelLinearScope, linearToolNames, type LinearScope } from "../linear/scope.ts";
import { logger } from "../log.ts";
import { listConnections, mcpAvailability, providersForUser, type McpAvailability } from "../mcp/index.ts";
import { channelAudience } from "../memory/access.ts";

const log = logger("IntegrationsPrompt");

export interface McpProviderState {
  name: string;
  availability: McpAvailability;
}

export interface IntegrationsState {
  linear: LinearScope | null;
  mcp: McpProviderState[] | null;
}

function linearLine(scope: LinearScope): string {
  const names = linearToolNames(scope);
  const reads = names.filter((name) => !LINEAR_TOOL_ACCESS[name].write).join(", ");
  const writes = names.filter((name) => LINEAR_TOOL_ACCESS[name].write).join(", ");
  if (scope.kind === "dm") {
    return `- Linear: works for any project whose channel this person is a member of; pass that channel as \`channel\` to ${names.join(", ")}. Writing needs that project connected through the Linear app, otherwise the tool returns the setup step.`;
  }
  if (scope.kind === "none") {
    const why = scope.projectName ? `project ${scope.projectName} has no Linear connected` : "this channel belongs to no project";
    return `- Linear: ${why}, so there are no linear-* tools here; someone in the project can connect it with /linear-status in its channel.`;
  }
  const team = scope.teamName ? ` (Linear team ${scope.teamName})` : "";
  const project = `${scope.projectName ? `project ${scope.projectName}` : "this channel's project"}${team}`;
  if (scope.mode === "app")
    return `- Linear: ${project} is connected through the Linear app, so you can read and write: ${names.join(", ")}.`;
  return `- Linear: ${project} is connected with a read-only API key. Reading works (${reads}); ${writes} return the setup step until someone in the project runs /linear-status here and connects the Linear app.`;
}

function mcpLines(providers: McpProviderState[], appUrl: string): string[] {
  const named = (availability: McpAvailability) =>
    providers.filter((provider) => provider.availability === availability).map((provider) => provider.name);
  const usable = named("usable");
  const reconnect = named("reconnect");
  const elsewhere = named("elsewhere");
  const lines: string[] = [];
  if (usable.length > 0) {
    lines.push(
      `- MCP servers this person connected: ${usable.join(", ")}. Their tools are the ones whose description starts with "[<server> MCP]"; if a server's tools are missing from your list, it didn't answer this turn, so say that instead of saying you can't.`,
    );
  }
  if (reconnect.length > 0) {
    lines.push(
      `- Awaiting reconnect, so their tools are unavailable: ${reconnect.join(", ")}; the person reconnects at ${appUrl}/integrations.`,
    );
  }
  if (elsewhere.length > 0) lines.push(`- Connected but turned off for this kind of conversation: ${elsewhere.join(", ")}.`);
  if (lines.length === 0) lines.push(`- MCP servers: this person has none connected; they can add them at ${appUrl}/integrations.`);
  return lines;
}

export function integrationsSection({ linear, mcp }: IntegrationsState, appUrl: string): string {
  if (!linear && !mcp) return "";
  return [
    "[Your integrations in this conversation]",
    "This is what you can use in this turn. It overrides anything said earlier in this thread, in your notes or in your own earlier replies: if an earlier reply said you lacked something listed here as usable, say briefly that it's available now and use it.",
    ...(linear ? [linearLine(linear)] : []),
    ...(mcp ? mcpLines(mcp, appUrl) : []),
  ].join("\n");
}

async function mcpStates(userId: string, channel: string | null): Promise<McpProviderState[]> {
  const [providers, connections, audience] = await Promise.all([
    providersForUser(userId),
    listConnections(userId),
    channelAudience(channel),
  ]);
  return providers.map((provider) => ({
    name: provider.name,
    availability: mcpAvailability(provider, connections.get(provider.id), audience),
  }));
}

export async function integrationsPrompt(userId: string | null, channel: string | null): Promise<string> {
  try {
    const person = userId && isUuid(userId) ? userId : null;
    const [linear, mcp] = await Promise.all([channel ? channelLinearScope(channel) : null, person ? mcpStates(person, channel) : null]);
    return integrationsSection({ linear, mcp }, config.appUrl);
  } catch (error) {
    log.warn(`Integrations section skipped: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}
