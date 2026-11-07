const ARRAY_START_RE = /"elements"\s*:\s*\[/;

export function createElementScanner() {
  let buffer = "";
  let position = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let elementStart = -1;
  let done = false;

  return function push(delta: string): string[] {
    if (done) return [];
    buffer += delta;
    if (position === -1) {
      const match = ARRAY_START_RE.exec(buffer);
      if (!match) return [];
      position = match.index + match[0].length;
    }
    const completed: string[] = [];
    for (; position < buffer.length; position += 1) {
      const char = buffer[position];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") {
        if (depth === 0) elementStart = position;
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) completed.push(buffer.slice(elementStart, position + 1));
      } else if (char === "]" && depth === 0) {
        done = true;
        position = buffer.length;
        break;
      }
    }
    return completed;
  };
}
