const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const UNORDERED_LIST_RE = /^(\s*)[-*]\s+(.+)$/;
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const BOLD_DOUBLE_STAR_RE = /\*\*(.+?)\*\*/g;
const BOLD_DOUBLE_UNDER_RE = /__(.+?)__/g;
const ITALIC_STAR_RE = /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g;
const STRIKETHROUGH_RE = /~~(.+?)~~/g;
const FENCED_CODE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`]+`/g;
const BOLD_PLACEHOLDER = "\u0000B";
const CODE_BLOCK_PLACEHOLDER = "%%CODEBLOCK_";
const INLINE_CODE_PLACEHOLDER = "%%INLINECODE_";

function extract(text: string, regex: RegExp, prefix: string): { text: string; matches: string[] } {
  const matches = [...text.matchAll(regex)].map((match) => match[0]);
  let replaced = text;
  matches.forEach((match, index) => {
    replaced = replaced.replace(match, `${prefix}${index}%%`);
  });
  return { text: replaced, matches };
}

function restore(text: string, matches: string[], prefix: string): string {
  return matches.reduce((acc, original, index) => acc.replaceAll(`${prefix}${index}%%`, () => original), text);
}

function convertInline(text: string): string {
  return text
    .replace(LINK_RE, "<$2|$1>")
    .replace(BOLD_DOUBLE_STAR_RE, `${BOLD_PLACEHOLDER}$1${BOLD_PLACEHOLDER}`)
    .replace(BOLD_DOUBLE_UNDER_RE, `${BOLD_PLACEHOLDER}$1${BOLD_PLACEHOLDER}`)
    .replace(ITALIC_STAR_RE, "_$1_")
    .replace(STRIKETHROUGH_RE, "~$1~")
    .replaceAll(BOLD_PLACEHOLDER, "*");
}

function convertLine(line: string): string {
  const heading = HEADING_RE.exec(line.trimStart());
  if (heading) return `*${convertInline(heading[2])}*`;
  const list = UNORDERED_LIST_RE.exec(line);
  if (list) return `${list[1]}• ${convertInline(list[2])}`;
  return convertInline(line);
}

export function fromMarkdown(text: string): string {
  const blocks = extract(text, FENCED_CODE_RE, CODE_BLOCK_PLACEHOLDER);
  const inlines = extract(blocks.text, INLINE_CODE_RE, INLINE_CODE_PLACEHOLDER);
  const converted = inlines.text.split("\n").map(convertLine).join("\n");
  return restore(restore(converted, blocks.matches, CODE_BLOCK_PLACEHOLDER), inlines.matches, INLINE_CODE_PLACEHOLDER);
}

const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLS = 20;
const TABLE_SEP_CELL_RE = /^:?-+:?$/;
const BOX_BORDER_RE = /^\s*[─┬┼┴┌┐├┤└┘]+\s*$/u;
const BOX_CONTENT_RE = /^\s*│.+│\s*$/u;
const BOLD_CELL_RE = /\*\*(.+?)\*\*/g;

type Segment = { kind: "text"; text: string } | { kind: "table"; rows: string[][] };

const isTableRow = (line: string) => /^\s*\|.+\|\s*$/.test(line);
const parseRow = (line: string) =>
  line
    .trim()
    .replace(/^\|+|\|+$/g, "")
    .split("|")
    .map((cell) => cell.trim());
const isTableSeparator = (line: string) => {
  const cells = parseRow(line);
  return cells.length > 0 && cells.every((cell) => TABLE_SEP_CELL_RE.test(cell));
};
const isBoxBorder = (line: string) => BOX_BORDER_RE.test(line);
const isBoxContent = (line: string) => BOX_CONTENT_RE.test(line);
const parseBoxRow = (line: string) =>
  line
    .trim()
    .replace(/^│+|│+$/gu, "")
    .split("│")
    .map((cell) => cell.trim());

function segmentLines(lines: string[]): Segment[] {
  const segments: Segment[] = [];
  let textAcc: string[] = [];

  const flush = () => {
    const text = textAcc.join("\n");
    if (text.trim() !== "") segments.push({ kind: "text", text });
    textAcc = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (index + 1 < lines.length && isTableRow(line) && isTableSeparator(lines[index + 1])) {
      const rows = [parseRow(line)];
      let cursor = index + 2;
      while (cursor < lines.length && isTableRow(lines[cursor])) {
        rows.push(parseRow(lines[cursor]));
        cursor += 1;
      }
      flush();
      segments.push({ kind: "table", rows });
      index = cursor;
      continue;
    }

    if (isBoxBorder(line) || isBoxContent(line)) {
      let cursor = index;
      while (cursor < lines.length && (isBoxBorder(lines[cursor]) || isBoxContent(lines[cursor]))) cursor += 1;
      const rows = lines.slice(index, cursor).filter(isBoxContent).map(parseBoxRow);
      if (rows.length === 0) {
        textAcc.push(line);
        index += 1;
      } else {
        flush();
        segments.push({ kind: "table", rows });
        index = cursor;
      }
      continue;
    }

    textAcc.push(line);
    index += 1;
  }
  flush();
  return segments;
}

function boldSegments(text: string) {
  const parts: Record<string, unknown>[] = [];
  let position = 0;
  for (const match of text.matchAll(BOLD_CELL_RE)) {
    const start = match.index!;
    if (start > position) parts.push({ type: "text", text: text.slice(position, start) });
    parts.push({ type: "text", text: match[1], style: { bold: true } });
    position = start + match[0].length;
  }
  if (position < text.length) parts.push({ type: "text", text: text.slice(position) });
  return parts;
}

function tableCell(text: string) {
  if (/\*\*(.+?)\*\*/.test(text)) {
    return { type: "rich_text", elements: [{ type: "rich_text_section", elements: boldSegments(text) }] };
  }
  return { type: "raw_text", text };
}

function segmentToBlocks(segment: Segment): Record<string, unknown>[] {
  if (segment.kind === "text") {
    return [{ type: "section", text: { type: "mrkdwn", text: fromMarkdown(segment.text).slice(0, 2900) } }];
  }
  const rows = segment.rows.slice(0, MAX_TABLE_ROWS).map((row) => row.slice(0, MAX_TABLE_COLS).map(tableCell));
  return [{ type: "table", rows }];
}

export function toBlocks(text: string): { text: string; blocks: Record<string, unknown>[] | null } {
  const segments = segmentLines(text.split("\n"));
  if (segments.some((segment) => segment.kind === "table")) {
    return { text: fromMarkdown(text), blocks: segments.flatMap(segmentToBlocks) };
  }
  return { text: fromMarkdown(text), blocks: null };
}
