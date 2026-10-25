import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Cron } from "croner";

export interface RoutineMeta {
  name: string;
  description: string;
  cron: string | null;
  channel: string | null;
  scope: string;
  requires_mcp: string | null;
}

export interface Routine extends RoutineMeta {
  body: string;
}

const routinesDir = () => path.join(process.cwd(), "agent", "routines");

const routinePath = (name: string) => path.join(routinesDir(), `${name}.md`);

function unquote(value: string): string {
  const match = /^(["'])(.*)\1$/.exec(value);
  return match ? match[2] : value;
}

function parse(content: string): { frontmatter: Record<string, string>; body: string } | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("---", 3);
  if (end === -1) return null;
  const frontmatter: Record<string, string> = {};
  for (const line of content.slice(3, end).split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    frontmatter[line.slice(0, colon).trim()] = unquote(line.slice(colon + 1).trim());
  }
  return { frontmatter, body: content.slice(end + 3).trim() };
}

function meta(name: string, frontmatter: Record<string, string>): RoutineMeta {
  return {
    name: frontmatter.name || name,
    description: frontmatter.description ?? "",
    cron: frontmatter.cron || null,
    channel: frontmatter.channel || null,
    scope: frontmatter.scope || "channel",
    requires_mcp: frontmatter.requires_mcp || null,
  };
}

function read(name: string): string | null {
  try {
    return readFileSync(routinePath(name), "utf8");
  } catch {
    return null;
  }
}

export function list(): RoutineMeta[] {
  let entries: string[];
  try {
    entries = readdirSync(routinesDir());
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!entry.endsWith(".md")) return [];
    const name = entry.slice(0, -".md".length);
    const parsed = parse(read(name) ?? "");
    return parsed ? [meta(name, parsed.frontmatter)] : [];
  });
}

export function listCronRoutines(): RoutineMeta[] {
  return list().filter((routine) => routine.cron);
}

export function getBody(name: string): string | null {
  return parse(read(name) ?? "")?.body ?? null;
}

export function get(name: string): Routine | null {
  const parsed = parse(read(name) ?? "");
  return parsed ? { ...meta(name, parsed.frontmatter), body: parsed.body } : null;
}

export type ParsedCron = { kind: "standard"; cron: Cron } | { kind: "random"; start: string; end: string; dates: Cron } | null;

export function parseCron(cron: string | null, timezone: string): ParsedCron {
  const random = /^RAND\((\d{2}:\d{2})-(\d{2}:\d{2})\)\s+(.+)$/.exec(cron ?? "");
  try {
    if (random) {
      const [, start, end, rest] = random;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) return null;
      return { kind: "random", start, end, dates: new Cron(`0 0 ${rest}`, { timezone, paused: true }) };
    }
    return cron ? { kind: "standard", cron: new Cron(cron, { timezone, paused: true }) } : null;
  } catch {
    return null;
  }
}
