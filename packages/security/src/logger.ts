import { redact } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/** Structured JSON logger. Every field passes through redaction before output. */
export function createLogger(
  base: Record<string, unknown> = {},
  minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info",
  sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < (ORDER[minLevel] ?? 20)) return;
    const record = redact({ ...base, ...fields }) as Record<string, unknown>;
    sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...record }));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger({ ...base, ...fields }, minLevel, sink),
  };
}
