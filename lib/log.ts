import { broadcast } from "./events/index.ts";

type Level = "debug" | "info" | "warning" | "error";

const PERSISTED: ReadonlySet<Level> = new Set(["info", "warning", "error"]);

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function write(level: Level, module: string, message: string, error?: unknown): void {
  const line = `[${level}] ${module}: ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warning") console.warn(line);
  else if (level === "debug") {
    if (process.env.LOG_LEVEL === "debug") console.debug(line);
  } else console.info(line);

  if (!PERSISTED.has(level)) return;

  const crash = error instanceof Error ? error : undefined;
  void broadcast("log", {
    source: "logger",
    meta: {
      level,
      message: truncate(message, 2000),
      module,
      crash_reason: crash ? truncate(crash.message, 500) : null,
      stacktrace: crash?.stack ? truncate(crash.stack, 2000) : null,
    },
  });
}

export function logger(module: string) {
  return {
    debug: (message: string) => write("debug", module, message),
    info: (message: string) => write("info", module, message),
    warn: (message: string, error?: unknown) => write("warning", module, message, error),
    error: (message: string, error?: unknown) => write("error", module, message, error),
  };
}

export function inspect(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
