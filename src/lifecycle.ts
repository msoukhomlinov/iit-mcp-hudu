/**
 * lifecycle.ts — process-level crash, signal and exit logging for the http transport.
 *
 * Node's default SIGTERM handling is silent: a killed container leaves zero log lines, and the
 * only way to learn the process died was to watch the port free (a server that died mid-run left no crash line at all). The http transport installs process-level handlers here so a crash,
 * a signal or a clean exit always leaves a record in the server log:
 *
 * - `uncaughtException` / `unhandledRejection` → a structured error line, then exit 1
 * - `SIGTERM` / `SIGINT` → a "shutting down" line (signal + exit code), a short grace period for
 *   in-flight work, a final "server closed" line, then exit 0
 *
 * The stdio transport keeps its own handler in main.ts, unchanged: its process life is tied to
 * the client, and no orchestrator signals it.
 */
import type { Logger } from './logger.js';

/** The slice of `node:http`'s Server that shutdown needs: stop accepting, then force-close sockets. */
export interface CloseableServer {
  close(callback?: (err?: Error) => void): void;
  closeAllConnections?(): void;
}

/** How long shutdown waits for in-flight work before force-closing keep-alive sockets. */
export const SHUTDOWN_GRACE_MS = 2000;

/**
 * Install the process-level lifecycle handlers for the http transport.
 *
 * `exit` is a parameter so a test can watch the code without killing the test runner — the same
 * pattern as `startHttpServer`'s listen-failure path.
 */
export function installHttpLifecycle(
  server: CloseableServer,
  log: Logger,
  exit: (code: number) => void = process.exit,
): void {
  // Node's default unhandledRejection handling already terminates — silently. The handler turns
  // that into a log line and an explicit exit code; uncaughtException gets the same treatment.
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { err: describe(err) });
    exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { err: describe(reason) });
    exit(1);
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A second signal mid-shutdown is a nudge, not a new shutdown: without the guard the log would
  // carry two "shutting down" lines and two forced exits.
  let shuttingDown = false;

  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info('shutting down', { signal, exitCode: 0 });

    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      log.info('server closed', { signal });
      exit(0);
    };

    server.close(() => finish());
    // MCP clients hold keep-alive connections, which can hold `close` open indefinitely. After
    // the grace window force-close them and finish no matter what `close` says. `unref` keeps
    // the timer from pinning the event loop on the fast path.
    setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, SHUTDOWN_GRACE_MS).unref();
  }
}

/** An Error as its stack (or message); anything else stringified. Same shape as main.ts' stdio handler. */
function describe(value: unknown): string {
  return value instanceof Error ? (value.stack ?? value.message) : String(value);
}
