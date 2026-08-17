import type { SharedConfig } from "./types.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
type Fields = Record<string, boolean | number | string | undefined>;

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
}

export const createLogger = (minimum: SharedConfig["logLevel"]): Logger => {
  const write = (level: Level, message: string, fields: Fields = {}) => {
    if (LEVELS[level] < LEVELS[minimum]) return;
    const safeFields = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    const line = JSON.stringify({ severity: level.toUpperCase(), message, ...safeFields });
    if (level === "error") console.error(line);
    else console.log(line);
  };

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields)
  };
};
