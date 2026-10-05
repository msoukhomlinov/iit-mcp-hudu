#!/usr/bin/env node
/**
 * main.ts — the process entry point: validate config, build the logger, pick a transport.
 *
 * Nothing else lives here. Both transports register the same tool surface from the same factory
 * (`createMcpServerFactory`), so "which transport" is the only decision this file makes.
 */
import { createMcpHandler } from '@modelcontextprotocol/server';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { installHttpLifecycle } from './lifecycle.js';
import { startHttpServer } from './http.js';
import { startStdio } from './stdio.js';
import { createMcpServerFactory } from './tools.js';

function main(): void {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    // A config failure predates the logger, and its message names variables only — never a value.
    // Exit non-zero so an orchestrator treats a mis-configured container as failed rather than
    // healthy-but-useless.
    if (err instanceof ConfigError) {
      process.stderr.write(err.message + '\n');
      process.exit(1);
    }
    throw err;
  }

  const log = createLogger(config.LOG_LEVEL);

  if (
    config.MCP_TRANSPORT === 'http'
    && config.HUDU_BASE_URL === undefined
    && config.HUDU_ALLOWED_BASE_HOSTS === undefined
  ) {
    log.warn('http transport, no HUDU_BASE_URL and no HUDU_ALLOWED_BASE_HOSTS: any caller-named origin will be dialled');
  }

  if (config.MCP_TRANSPORT === 'stdio') {
    const handle = startStdio(config, log);
    process.on('uncaughtException', (err) => {
      log.error('uncaught exception', { err: err instanceof Error ? (err.stack ?? err.message) : String(err) });
      void handle.close().finally(() => process.exit(1));
    });
    return;
  }

  // The handler is built here and passed in: http.ts owns the listener and the auth gate, and
  // deliberately knows nothing about tools.
  const mcp = createMcpHandler(createMcpServerFactory(config, log), {
    onerror: (err) => log.error('mcp handler error', { err: err.message }),
  });
  const server = startHttpServer(config, mcp, log);
  // Node's default SIGTERM handling is silent and this branch used to install nothing: a killed
  // container left no process-level record in the server log at all. The stdio transport
  // keeps its handler above, unchanged.
  installHttpLifecycle(server, log);
}

main();
