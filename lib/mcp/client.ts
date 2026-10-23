import { logger } from "../log.ts";

const log = logger("Mcp.Client");
const PROTOCOL_VERSION = "2025-06-18";

export type McpResult<T> = { ok: true; value: T } | { ok: false; error: "unauthorized" | string };

export interface RemoteTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

async function rawPost(url: string, accessToken: string | null, sessionId: string | null, body: unknown) {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
}

function parseBody(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) return null;
    try {
      return JSON.parse(dataLine.slice(6));
    } catch {
      return null;
    }
  }
}

async function initialize(url: string, accessToken: string): Promise<McpResult<string | null>> {
  let response: Response;
  try {
    response = await rawPost(url, accessToken, null, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "manfrod", version: "1.0" } },
    });
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, error: "unauthorized" };
  if (response.status !== 200) {
    log.warn(`Mcp.Client: initialize failed for ${url}: HTTP ${response.status} ${await response.text().catch(() => "")}`);
    return { ok: false, error: `unexpected_status_${response.status}` };
  }
  await response.text().catch(() => "");
  const sessionId = response.headers.get("mcp-session-id");
  void rawPost(url, accessToken, sessionId, { jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
  return { ok: true, value: sessionId };
}

async function rpc(
  url: string,
  accessToken: string,
  sessionId: string | null,
  method: string,
  params: unknown,
): Promise<McpResult<Record<string, any>>> {
  let response: Response;
  try {
    response = await rawPost(url, accessToken, sessionId, { jsonrpc: "2.0", id: 2, method, params });
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, error: "unauthorized" };
  const text = await response.text().catch(() => "");
  if (response.status !== 200) {
    log.warn(`Mcp.Client: ${method} failed for ${url}: HTTP ${response.status} ${text}`);
    return { ok: false, error: `unexpected_status_${response.status}` };
  }
  const body = parseBody(text);
  if (!body) return { ok: false, error: "unparseable_response" };
  if (body.result !== undefined) return { ok: true, value: body.result as Record<string, any> };
  if (body.error !== undefined) return { ok: false, error: `rpc_error: ${JSON.stringify(body.error)}` };
  return { ok: false, error: "unparseable_response" };
}

export async function listTools(url: string, accessToken: string): Promise<McpResult<RemoteTool[]>> {
  const session = await initialize(url, accessToken);
  if (!session.ok) return session;
  const result = await rpc(url, accessToken, session.value, "tools/list", {});
  if (!result.ok) return result;
  return { ok: true, value: Array.isArray(result.value.tools) ? result.value.tools : [] };
}

export async function callTool(
  url: string,
  accessToken: string,
  name: string,
  args: unknown,
): Promise<McpResult<Record<string, any>>> {
  const session = await initialize(url, accessToken);
  if (!session.ok) return session;
  return rpc(url, accessToken, session.value, "tools/call", { name, arguments: args });
}

export function formatResult(result: Record<string, any>): string {
  if (Array.isArray(result.content)) {
    return result.content
      .map((part: Record<string, unknown>) =>
        part.type === "text" && typeof part.text === "string" ? part.text : JSON.stringify(part),
      )
      .join("\n");
  }
  return JSON.stringify(result);
}

export async function discoverName(url: string): Promise<string | null> {
  try {
    const response = await rawPost(url, null, null, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "manfrod", version: "1.0" } },
    });
    if (response.status !== 200) return null;
    const body = parseBody(await response.text());
    const info = (body?.result as Record<string, any> | undefined)?.serverInfo;
    return info?.title ?? info?.name ?? null;
  } catch {
    return null;
  }
}

export async function discoverLogo(url: string): Promise<string | null> {
  const origin = new URL(url).origin;
  for (const suffix of ["/favicon.svg", "/favicon.ico"]) {
    try {
      const response = await fetch(origin + suffix, { signal: AbortSignal.timeout(8_000) });
      if (response.status === 200 && (response.headers.get("content-type") ?? "").startsWith("image/")) {
        return origin + suffix;
      }
    } catch {}
  }
  return null;
}
