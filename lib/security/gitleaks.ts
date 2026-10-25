import { readFileSync } from "node:fs";
import path from "node:path";
import { logger } from "../log.ts";

const log = logger("GitleaksRules");
const SOURCE_URL = "https://raw.githubusercontent.com/gitleaks/gitleaks/master/config/gitleaks.toml";

export interface Rule {
  id: string;
  regex: RegExp;
  keywords: string[];
}

const globalRules = globalThis as unknown as { manfrodGitleaksRules?: Rule[] };

function vendoredPath(): string {
  return process.env.GITLEAKS_TOML_PATH ?? path.join(process.cwd(), "lib", "security", "gitleaks.toml");
}

function scopeInlineFlags(source: string): string {
  let output = "";
  const closers: number[] = [];
  let depth = 0;
  let inClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      output += source.slice(index, index + 2);
      index += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      output += char;
      continue;
    }
    if (char === "[") {
      inClass = true;
      output += char;
      continue;
    }
    const inline = /^\(\?([ims]+)\)/.exec(source.slice(index));
    if (inline) {
      output += `(?${inline[1]}:`;
      closers.push(depth);
      index += inline[0].length - 1;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      while (closers.length > 0 && closers[closers.length - 1] === depth) {
        output += ")";
        closers.pop();
      }
      depth -= 1;
    }
    output += char;
  }
  return output + ")".repeat(closers.length);
}

function compileGoRegex(pattern: string): RegExp | null {
  let source = pattern;
  let flags = "";
  const inline = /^\(\?([imsx]+)\)/.exec(source);
  if (inline) {
    if (inline[1].includes("x")) return null;
    flags = [...new Set(inline[1].split(""))].join("");
    source = source.slice(inline[0].length);
  }
  source = scopeInlineFlags(
    source
      .replace(/\(\?P</g, "(?<")
      .replace(/\\z/g, "$")
      .replace(/\\A/g, "^"),
  );
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function extractQuoted(rest: string): string | null {
  const triple = /^'''(.*)'''$/.exec(rest);
  if (triple) return triple[1];
  const double = /^"(.*)"$/.exec(rest);
  return double ? double[1] : null;
}

export function parse(content: string): Rule[] {
  type Pending = { id: string; regex: string | null; keywords: string[] } | null;
  const entries: NonNullable<Pending>[] = [];
  let pending: Pending = null;

  for (const line of content.split("\n")) {
    if (line.startsWith("[[rules]]")) {
      if (pending) entries.push(pending);
      pending = null;
    } else if (line.startsWith("id = ")) {
      const match = /^"(.*)"$/.exec(line.slice(5));
      if (match) pending = { id: match[1], regex: null, keywords: [] };
    } else if (line.startsWith("regex = ") && pending) {
      const pattern = extractQuoted(line.slice(8));
      if (pattern !== null) pending.regex = pattern;
    } else if (line.startsWith("keywords = ") && pending) {
      pending.keywords = [...line.slice(11).matchAll(/"([^"]*)"/g)].map((match) => match[1].toLowerCase());
    }
  }
  if (pending) entries.push(pending);

  return entries
    .filter((entry) => entry.regex && !entry.id.startsWith("generic-"))
    .flatMap((entry) => {
      const regex = compileGoRegex(entry.regex!);
      return regex ? [{ id: entry.id, regex, keywords: entry.keywords }] : [];
    });
}

export function rules(): Rule[] {
  if (!globalRules.manfrodGitleaksRules) {
    try {
      globalRules.manfrodGitleaksRules = parse(readFileSync(vendoredPath(), "utf8"));
    } catch (error) {
      log.warn(`GitleaksRules: failed to load vendored rules: ${(error as Error).message}`);
      globalRules.manfrodGitleaksRules = [];
    }
  }
  return globalRules.manfrodGitleaksRules;
}

export async function refresh(): Promise<boolean> {
  try {
    const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(15_000) });
    if (response.status !== 200) {
      log.warn(`GitleaksRules: refresh got HTTP ${response.status}, keeping previous cache`);
      return false;
    }
    const parsed = parse(await response.text());
    if (parsed.length === 0) {
      log.warn("GitleaksRules: refresh parsed 0 rules, keeping previous cache");
      return false;
    }
    globalRules.manfrodGitleaksRules = parsed;
    log.info(`GitleaksRules: refreshed ${parsed.length} rules from upstream`);
    return true;
  } catch (error) {
    log.warn(`GitleaksRules: refresh failed (${(error as Error).message}), keeping previous cache`);
    return false;
  }
}

export function matches(text: string): string | null {
  const lowered = text.toLowerCase();
  for (const rule of rules()) {
    const keywordHit = rule.keywords.length === 0 || rule.keywords.some((keyword) => lowered.includes(keyword));
    if (keywordHit && rule.regex.test(text)) return rule.id;
  }
  return null;
}
