import { currentTraceId } from "./trace";

// JSON lines in production (one object per line: time, level, service, msg, trace, fields), a
// short readable line on a terminal. No dependencies; LOG_LEVEL filters.

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  service: string;
  level?: LogLevel;
  /** Readable lines instead of JSON (default: when stdout is a terminal). */
  pretty?: boolean;
  /** Where lines go (default: stdout, errors to stderr). Tests capture it. */
  write?: (line: string, level: LogLevel) => void;
}

/** An Error as plain fields: JSON.stringify drops an Error's message and stack. */
function plain(value: unknown): unknown {
  if (value instanceof Error) {
    const out: LogFields = { name: value.name, message: value.message };
    if (value.stack) out.stack = value.stack.split("\n").slice(0, 8).join("\n");
    const reason = (value as { reason?: unknown }).reason;
    if (reason !== undefined) out.reason = reason;
    return out;
  }
  return value;
}

const COLORS: Record<LogLevel, string> = { debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" };

export function createLogger(options: LoggerOptions, base: LogFields = {}): Logger {
  const min = LOG_LEVELS.indexOf(options.level ?? "info");
  const pretty = options.pretty ?? process.stdout.isTTY === true;
  const write =
    options.write ??
    ((line: string, level: LogLevel) => (level === "error" ? process.stderr : process.stdout).write(`${line}\n`));

  const log = (level: LogLevel, msg: string, fields: LogFields = {}) => {
    if (LOG_LEVELS.indexOf(level) < min) return;
    const trace = currentTraceId();
    const all: LogFields = { ...base, ...(trace ? { trace } : {}) };
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) all[key] = plain(value);
    if (pretty) {
      const time = new Date().toISOString().slice(11, 19);
      const rest = Object.entries(all)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      write(
        `${time} ${COLORS[level]}${level.padEnd(5)}\x1b[0m ${options.service} ${msg}${rest ? ` ${rest}` : ""}`,
        level,
      );
      return;
    }
    write(JSON.stringify({ time: new Date().toISOString(), level, service: options.service, msg, ...all }), level);
  };

  return {
    debug: (msg, fields) => log("debug", msg, fields),
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),
    child: (fields) => createLogger(options, { ...base, ...fields }),
  };
}

/** LOG_LEVEL from the environment, or info (error under tests, which would otherwise drown in job lines). */
export function logLevelFromEnv(env: Record<string, string | undefined> = process.env): LogLevel {
  const value = env.LOG_LEVEL ?? "";
  if ((LOG_LEVELS as readonly string[]).includes(value)) return value as LogLevel;
  return env.NODE_ENV === "test" ? "error" : "info";
}
