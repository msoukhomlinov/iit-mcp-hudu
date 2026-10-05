/**
 * logger.ts — structured JSON logs to stdout, one object per line.
 *
 * Deliberately tiny: a container's log collector wants newline-delimited JSON on stdout and nothing
 * else. No dependency, no transports, no file rotation.
 *
 * On the stdio transport, stdout IS the MCP protocol channel — writing logs there would corrupt
 * every message. Logs go to stderr in that case; see {@link createLogger}.
 */
export const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type Level = (typeof LEVELS)[number];

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * @param minLevel messages below this are dropped.
 * @param write sink for one complete line. Defaults to stderr, which is always safe: on the stdio
 *   transport stdout carries the MCP protocol itself, so a log line written there would be parsed
 *   as a protocol message and break the session.
 */
export function createLogger(minLevel: Level = 'info', write: (line: string) => void = (l) => process.stderr.write(l + '\n')): Logger {
  const threshold = LEVELS.indexOf(minLevel);
  const at = (level: Level) => (msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS.indexOf(level) < threshold) return;
    write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }));
  };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}
