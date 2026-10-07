#!/usr/bin/env node
/**
 * main.ts — the process entry point: validate config, build the logger, pick a transport.
 *
 * Nothing else lives here. Both transports register the same tool surface from the same factory
 * (`createMcpServerFactory`), so "which transport" is the only decision this file makes.
 */
import { createMcpHandler } from '@modelcontextprotocol/server';
import { ConfigError, loadConfig } from './config.js';
import { runDoctor } from './doctor.js';
import { createLogger } from './logger.js';
import { installHttpLifecycle } from './lifecycle.js';
import { startHttpServer } from './http.js';
import { startStdio } from './stdio.js';
import { createMcpServerFactory } from './tools.js';

/**
 * `doctor` — the zero-wire preflight subcommand.
 *
 * Prints the credential shape report (length, two-character prefix, anomaly names; never a value)
 * and exits. It is a SUBCOMMAND rather than a flag so it is unmistakable in a shell history and in
 * a runbook, and it exits non-zero when a credential would be refused, so a deployment gate can use
 * it directly.
 *
 * It dials nothing by construction — see `src/doctor.ts`, which imports no Hudu client. The whole
 * point is that the question "did my credential load intact?" gets a cheap, local answer, because
 * the alternative answer is a real auth failure against a vendor account where repeats risk a lock.
 */
function runDoctorCommand(): void {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stdout.write(JSON.stringify({ ok: false, stage: 'config', error: err.message }, null, 2) + '\n');
      process.exit(1);
    }
    throw err;
  }
  const report = runDoctor(config);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  // Non-zero: a runbook step (`doctor && live-run`) must stop on a bad credential, not proceed to
  // the dial the report just said not to make.
  process.exit(report.ok ? 0 : 1);
}

function main(): void {
  // `doctor` is matched before anything else, so it never builds a logger, a transport or a client.
  if (process.argv[2] === 'doctor') {
    runDoctorCommand();
    return;
  }
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
