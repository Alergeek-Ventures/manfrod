import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Cron } from "croner";

export interface SkillMeta {
  name: string;
  description: string;
  cron: string | null;
  channel: string | null;
  scope: string;
  requires_mcp: string | null;
}

export interface Skill extends SkillMeta {
  body: string;
}

export function skillsDir(): string {
  return path.join(process.cwd(), "skills");
}

const skillPath = (name: string) => path.join(skillsDir(), name, "SKILL.md");

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

function meta(name: string, frontmatter: Record<string, string>): SkillMeta {
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
    return readFileSync(skillPath(name), "utf8");
  } catch {
    return null;
  }
}

export function list(): SkillMeta[] {
  let entries: string[];
  try {
    entries = readdirSync(skillsDir());
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    try {
      if (!statSync(skillPath(entry)).isFile()) return [];
    } catch {
      return [];
    }
    const parsed = parse(read(entry) ?? "");
    return parsed ? [meta(entry, parsed.frontmatter)] : [];
  });
}

export function listCronSkills(): SkillMeta[] {
  return list().filter((skill) => skill.cron);
}

export function getBody(name: string): string | null {
  return parse(read(name) ?? "")?.body ?? null;
}

export function get(name: string): Skill | null {
  const parsed = parse(read(name) ?? "");
  return parsed ? { ...meta(name, parsed.frontmatter), body: parsed.body } : null;
}

export function catalogText(): string | null {
  const skills = list();
  if (skills.length === 0) return null;
  return `[Available Skills — call use_skill(name) to load full instructions when relevant]\n${skills
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join("\n")}`;
}

export type ParsedCron =
  | { kind: "standard"; cron: Cron }
  | { kind: "random"; start: string; end: string; dates: Cron }
  | null;

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
