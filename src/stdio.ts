/**
 * stdio.ts — the local transport: one process, one connection, no caller authentication.
 *
 * This is the Claude Code / Claude Desktop / VS Code path. There is deliberately no shared secret
 * here: the process boundary IS the trust boundary, because whoever can spawn this process already
 * has the environment the Hudu credential comes from.
 *
 * stdout carries the MCP protocol on this transport, so nothing in this path may write there —
 * that is why {@link createLogger} defaults to stderr.
 *
 */
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { createMcpServerFactory } from './tools.js';

/**
 * Serve MCP over this process's stdin/stdout.
 *
 * Returns the handle rather than awaiting anything: `serveStdio` owns the transport for the life of
 * the process, and the caller needs the handle only to close it on a fatal error.
 */
export function startStdio(config: Config, log: Logger): StdioServerHandle {
  const handle = serveStdio(createMcpServerFactory(config, log), {
    // Reporting only — the SDK still answers the wire. Without this an out-of-band transport error
    // is swallowed and the session simply goes quiet.
    onerror: (err) => log.error('stdio transport error', { err: err.message }),
  });
  log.info('serving', { transport: 'stdio' });
  return handle;
}
