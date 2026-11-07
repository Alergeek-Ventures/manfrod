const ELEMENTS_KEY = "elements";
const ROOT_DEPTH = 1;
const ARRAY_DEPTH = 2;
const MATCHING: Record<string, string> = { "}": "{", "]": "[" };

export function createElementScanner() {
  const open: string[] = [];
  let inString = false;
  let escaped = false;
  let rootString: string | null = null;
  let lastString: string | null = null;
  let key: string | null = null;
  let inElements = false;
  let element: string[] | null = null;
  let done = false;

  const depth = () => open.length;

  return function push(delta: string): string[] {
    if (done) return [];
    const completed: string[] = [];
    let sliceStart = element ? 0 : -1;
    for (let position = 0; position < delta.length && !done; position += 1) {
      const char = delta[position];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') {
          inString = false;
          if (rootString !== null) lastString = rootString;
          rootString = null;
          continue;
        }
        if (rootString !== null && rootString.length <= ELEMENTS_KEY.length) rootString += char;
        continue;
      }
      switch (char) {
        case '"':
          inString = true;
          if (depth() === ROOT_DEPTH) rootString = "";
          break;
        case ":":
          if (depth() === ROOT_DEPTH) key = lastString;
          break;
        case ",":
          if (depth() === ROOT_DEPTH) key = lastString = null;
          break;
        case "{":
        case "[":
          if (inElements && depth() === ARRAY_DEPTH && char === "{") {
            element = [];
            sliceStart = position;
          }
          if (depth() === ROOT_DEPTH && char === "[" && key === ELEMENTS_KEY) inElements = true;
          open.push(char);
          break;
        case "}":
        case "]":
          if (open.at(-1) !== MATCHING[char]) break;
          open.pop();
          if (inElements && depth() === ARRAY_DEPTH && element) {
            element.push(delta.slice(sliceStart, position + 1));
            completed.push(element.join(""));
            element = null;
            sliceStart = -1;
          }
          if (inElements && depth() === ROOT_DEPTH) done = true;
          break;
      }
    }
    if (element && sliceStart !== -1) element.push(delta.slice(sliceStart));
    return completed;
  };
}
