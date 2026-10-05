import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHUTDOWN_GRACE_MS, installHttpLifecycle, type CloseableServer } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';

// src/lifecycle.ts owns the http transport's process-level handlers. The handlers are invoked
// directly here with synthetic payloads — no real crash, no real signal, no killed process — and
// the exit code is watched through the injected `exit` rather than `process.exit`.

const EVENTS = ['uncaughtException', 'unhandledRejection', 'SIGTERM', 'SIGINT'] as const;
type EventName = (typeof EVENTS)[number];

interface FakeServer extends CloseableServer {
  closeCalls: number;
  forceCloseCalls: number;
  /** When false, `close` never invokes its callback: a listener that never ends. */
  closeInvokesCallback: boolean;
}

function fakeServer(): FakeServer {
  const s: FakeServer = {
    closeCalls: 0,
    forceCloseCalls: 0,
    closeInvokesCallback: true,
    close(callback) {
      s.closeCalls += 1;
      if (s.closeInvokesCallback && callback) callback();
    },
    closeAllConnections() {
      s.forceCloseCalls += 1;
    },
  };
  return s;
}

describe('installHttpLifecycle', () => {
  let lines: string[];
  let exits: number[];
  let server: FakeServer;
  let saved: Map<EventName, Array<(...args: unknown[]) => unknown>>;

  beforeEach(() => {
    lines = [];
    exits = [];
    server = fakeServer();
    saved = new Map(EVENTS.map((event) => [event, process.listeners(event) as Array<(...args: unknown[]) => unknown>]));
    installHttpLifecycle(server, createLogger('debug', (l) => lines.push(l)), (code) => exits.push(code));
  });

  afterEach(() => {
    // Restore whatever was on the process before this test: vitest's own unhandledRejection
    // handling must survive the suite.
    for (const event of EVENTS) {
      process.removeAllListeners(event);
      for (const listener of saved.get(event) ?? []) process.on(event, listener);
    }
    vi.useRealTimers();
  });

  /** The exactly-one handler this file's install added for `event`. */
  function handler(event: EventName): (payload?: unknown) => unknown {
    const added = (process.listeners(event) as Array<(...args: unknown[]) => unknown>).filter(
      (listener) => !(saved.get(event) ?? []).includes(listener),
    );
    expect(added).toHaveLength(1);
    return added[0]!;
  }

  it('installs one handler per process event and no others', () => {
    for (const event of EVENTS) expect(handler(event)).toBeTypeOf('function');
  });

  it('uncaughtException: a structured error line, then exit 1', () => {
    handler('uncaughtException')(new Error('boom'));
    expect(exits).toEqual([1]);
    const parsed = JSON.parse(lines.at(-1)!);
    expect(parsed).toMatchObject({ level: 'error', msg: 'uncaught exception' });
    expect(typeof parsed.ts).toBe('string');
    expect(parsed.err).toContain('boom');
  });

  it('uncaughtException: a non-Error value is stringified, not lost', () => {
    handler('uncaughtException')('kaput');
    const parsed = JSON.parse(lines.at(-1)!);
    expect(parsed).toMatchObject({ level: 'error', msg: 'uncaught exception', err: 'kaput' });
    expect(exits).toEqual([1]);
  });

  it('unhandledRejection: a structured error line, then exit 1', () => {
    handler('unhandledRejection')(new Error('rejected'));
    expect(exits).toEqual([1]);
    const parsed = JSON.parse(lines.at(-1)!);
    expect(parsed).toMatchObject({ level: 'error', msg: 'unhandled rejection' });
    expect(parsed.err).toContain('rejected');
  });

  it('SIGTERM: "shutting down" line, then "server closed" line, then exit 0', () => {
    handler('SIGTERM')();
    expect(server.closeCalls).toBe(1);
    expect(exits).toEqual([0]);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({ level: 'info', msg: 'shutting down', signal: 'SIGTERM', exitCode: 0 }),
      expect.objectContaining({ level: 'info', msg: 'server closed', signal: 'SIGTERM' }),
    ]);
  });

  it('SIGINT: the same two lines with its own signal name, then exit 0', () => {
    handler('SIGINT')();
    expect(exits).toEqual([0]);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({ level: 'info', msg: 'shutting down', signal: 'SIGINT', exitCode: 0 }),
      expect.objectContaining({ level: 'info', msg: 'server closed', signal: 'SIGINT' }),
    ]);
  });

  it('a second signal mid-shutdown does not double-log or double-exit', () => {
    handler('SIGTERM')();
    handler('SIGTERM')();
    expect(lines).toHaveLength(2);
    expect(exits).toEqual([0]);
  });

  it('force-closes a listener that never ends, after the grace period', () => {
    vi.useFakeTimers();
    server.closeInvokesCallback = false;
    handler('SIGTERM')();
    // The listener never closes: no final line and no exit yet.
    expect(lines.map((l) => JSON.parse(l).msg)).toEqual(['shutting down']);
    expect(exits).toEqual([]);
    vi.advanceTimersByTime(SHUTDOWN_GRACE_MS);
    expect(server.forceCloseCalls).toBe(1);
    expect(exits).toEqual([0]);
    expect(lines.map((l) => JSON.parse(l).msg)).toEqual(['shutting down', 'server closed']);
  });

  it('a slow listener that closes inside the grace period still exits only once', () => {
    vi.useFakeTimers();
    let closeCallback: (() => void) | undefined;
    server.close = (callback) => {
      server.closeCalls += 1;
      closeCallback = callback;
    };
    handler('SIGTERM')();
    vi.advanceTimersByTime(SHUTDOWN_GRACE_MS / 2);
    closeCallback!();
    const firstExit = exits;
    vi.advanceTimersByTime(SHUTDOWN_GRACE_MS); // the grace timer fires after the close already finished
    expect(exits).toEqual([0]);
    expect(firstExit).toEqual(exits);
    expect(lines.filter((l) => JSON.parse(l).msg === 'server closed')).toHaveLength(1);
  });

  it('log lines respect LOG_LEVEL while the exit path does not', () => {
    // A second install on an error-only sink: its info lines must be dropped, its error lines
    // must land, and both of its handlers still exit with the right codes.
    const errOnly: string[] = [];
    const codes: number[] = [];
    installHttpLifecycle(server, createLogger('error', (l) => errOnly.push(l)), (code) => codes.push(code));

    (process.listeners('SIGTERM') as Array<() => void>).at(-1)!();
    expect(errOnly).toEqual([]); // "shutting down" / "server closed" are info-level
    expect(codes).toEqual([0]);

    (process.listeners('uncaughtException') as Array<(err: unknown) => void>).at(-1)!('kaput');
    const parsed = JSON.parse(errOnly.at(-1)!);
    expect(parsed).toMatchObject({ level: 'error', msg: 'uncaught exception', err: 'kaput' });
    expect(codes).toEqual([0, 1]);
  });
});
