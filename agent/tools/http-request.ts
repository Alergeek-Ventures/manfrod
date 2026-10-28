import { z } from "zod";
import { defineManfrodTool } from "../lib/define-tool.ts";
import { publicUrlProblem } from "../lib/http.ts";

const TIMEOUT_MS = 30_000;
const MAX_BODY_CHARS = 20_000;

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

export default defineManfrodTool({
  description:
    "Call an HTTPS API or fetch a URL. Put secrets as {{ NAME }} placeholders in the URL, headers or body; each one is filled in only for the hosts it was added for. Use GET to read. Use POST, PUT, PATCH or DELETE only when the person asked for that change or a skill tells you to. Returns the status, content type and up to 20k characters of the body.",
  inputSchema: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).optional().describe("Default GET"),
    url: z.string().describe("Full https:// URL"),
    headers: z.record(z.string(), z.string()).optional().describe('e.g. { "Authorization": "Bearer {{ GITHUB_TOKEN }}" }'),
    body: z.string().optional().describe("Request body; for JSON pass the JSON text and a Content-Type header"),
  }),
  secretHost: ({ url }) => hostOf(url),
  label: { start: ({ method, url }) => `${method ?? "GET"} ${hostOf(url) ?? url}`, complete: (_input, output) => output.split("\n")[0] },
  async execute({ method, url, headers, body }) {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return `Invalid URL: ${url}`;
    }
    const problem = await publicUrlProblem(target);
    if (problem) return `Request refused: ${problem}.`;
    try {
      const response = await fetch(target, {
        method: method ?? "GET",
        headers,
        body: body !== undefined && method && !["GET", "HEAD"].includes(method) ? body : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const type = response.headers.get("content-type") ?? "unknown";
      const location = response.headers.get("location");
      const text = method === "HEAD" ? "" : await response.text();
      const clipped =
        text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n… (${text.length - MAX_BODY_CHARS} more characters)` : text;
      return [
        `HTTP ${response.status} ${response.statusText}`,
        `content-type: ${type}`,
        location ? `location: ${location}` : "",
        "",
        clipped,
      ]
        .filter((line, index) => line !== "" || index === 3)
        .join("\n");
    } catch (error) {
      return `Request failed: ${(error as Error).message}`;
    }
  },
});
