import { logger } from "../../lib/log.ts";

const log = logger("dynamic-tools");

const TOOL_CALLBACKS = Symbol.for("eve:durable-dynamic-tool-callbacks");
const TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

function isJsonValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (Array.isArray(value)) {
    seen.add(value);
    const ok = value.every((item) => isJsonValue(item, seen));
    seen.delete(value);
    return ok;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && Object.getPrototypeOf(proto) !== null) return false;
  seen.add(value);
  const ok = Object.values(value).every((item) => item === undefined || isJsonValue(item, seen));
  seen.delete(value);
  return ok;
}

function stampedClosures(callbacks: Record<string, unknown>, prefix = ""): [string, unknown][] {
  return Object.entries(callbacks).flatMap(([phase, stamped]): [string, unknown][] => {
    if (!stamped || typeof stamped !== "object") return [];
    if ("closure" in stamped) return [[`${prefix}${phase}`, stamped.closure]];
    return stampedClosures(stamped as Record<string, unknown>, `${phase}.`);
  });
}

export function dynamicToolProblem(name: string, tool: unknown): string | null {
  if (!TOOL_NAME.test(name)) return "its name is not a valid tool name";
  if (!tool || typeof tool !== "object") return "it is not a tool definition";
  const callbacks = Reflect.get(tool, TOOL_CALLBACKS) as Record<string, unknown> | undefined;
  const bad = stampedClosures(callbacks ?? {})
    .filter(([, closure]) => !isJsonValue(closure))
    .map(([phase]) => phase);
  return bad.length > 0 ? `its ${bad.join(", ")} captures values that are not JSON` : null;
}

export async function dynamicToolSet(source: string, build: () => Promise<Record<string, any>>): Promise<Record<string, any>> {
  let built: Record<string, any>;
  try {
    built = await build();
  } catch (error) {
    log.error(
      `${source} tools failed to load, so this turn runs without them: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
    return {};
  }
  const kept: Record<string, any> = {};
  for (const [name, tool] of Object.entries(built)) {
    const problem = dynamicToolProblem(name, tool);
    if (problem) log.error(`Dropped dynamic tool ${name} from ${source} because ${problem}`);
    else kept[name] = tool;
  }
  return kept;
}
