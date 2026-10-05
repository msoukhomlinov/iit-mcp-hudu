import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { request as httpGet } from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

// src/main.ts is the one place that decides which process-level handlers the http transport gets,
// and a unit test of installHttpLifecycle cannot see that wiring. These tests boot the real entry
// point and replay the exact defect repro: SIGTERM to a live server. The http case must
// now leave "shutting down" + "server closed" lines and exit 0; the stdio case pins that its
// behaviour is unchanged — node's default silent SIGTERM, zero lifecycle lines.
//
// The server is booted as `node --import tsx src/main.ts` — one process, so the exit code and
// signal observed here are the server's own. The `tsx` CLI would not do: it wraps the script in a
// relay process that escalates to SIGKILL after 30 ms and rewrites a signal death as
// exit(128+signal), masking exactly the semantics this test pins.
//
// No process here can reach Hudu: the http boot holds no credential (placeholder origin), and the
// stdio boot gets a fake origin plus key that is only used by tool calls, which never happen.

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const READY_TIMEOUT_MS = 20000;
const RUN_TIMEOUT_MS = 60000;

// A minimal environment: no HUDU_* value from the machine running the tests can leak into the
// server process.
const MIN_ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())));
  return port;
}

function boot(env: Record<string, string>): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: ROOT, env: { ...MIN_ENV, ...env } });
}

interface Watch {
  text: () => string;
  close: Promise<[number | null, NodeJS.Signals | null]>;
}

function watch(child: ChildProcessWithoutNullStreams): Watch {
  let text = '';
  child.stderr.on('data', (chunk) => (text += String(chunk)));
  child.stdout.resume(); // never let a full pipe block the child
  // Wait for "close", not "exit": "exit" only means the process is gone, while bytes the child
  // wrote to stderr just before dying can still sit in the pipe, which would let the text()
  // assertions below race the buffered flush. "close" fires after the
  // stdio streams have fully closed, so every buffered stderr byte has already reached the parent.
  return {
    text: () => text,
    close: once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>,
  };
}

async function waitUntil(predicate: () => boolean, what: string, text: () => string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; server log:\n${text()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function probe(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpGet(url, { agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.end(); // `request` sends nothing until end: without this the probe never goes on the wire
  });
}

async function waitHealthy(url: string, text: () => string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (await probe(url)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}; server log:\n${text()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('process lifecycle, as wired by src/main.ts', () => {
  it('http: SIGTERM leaves shutting-down and server-closed lines and exits 0', async () => {
    const port = await freePort();
    const child = boot({ MCP_TRANSPORT: 'http', HUDU_ALLOW_ANY_BASE_HOST: 'true', PORT: String(port), LOG_LEVEL: 'info' });
    const { text, close } = watch(child);

    await waitHealthy(`http://127.0.0.1:${port}/healthz`, text);
    child.kill('SIGTERM');
    const [code, signal] = await close;

    expect(signal).toBeNull(); // exited, not killed
    expect(code).toBe(0);
    expect(text()).toContain('"msg":"shutting down"');
    expect(text()).toContain('"signal":"SIGTERM"');
    expect(text()).toContain('"msg":"server closed"');
    expect(text().match(/http transport, no HUDU_BASE_URL and no HUDU_ALLOWED_BASE_HOSTS: any caller-named origin will be dialled/g)).toHaveLength(1);
  }, RUN_TIMEOUT_MS);

  it('stdio: SIGTERM is still node\'s default silent kill — no lifecycle lines, unchanged', async () => {
    const child = boot({
      MCP_TRANSPORT: 'stdio',
      HUDU_BASE_URL: 'https://hudu.example.com',
      HUDU_API_KEY: 'test-key',
    });
    const { text, close } = watch(child);

    await waitUntil(() => text().includes('"msg":"serving"'), 'the stdio server to log "serving"', text);
    child.kill('SIGTERM');
    const [code, signal] = await close;

    expect(signal).toBe('SIGTERM'); // default handling: killed, not an exit with a recorded code
    expect(code).toBeNull();
    expect(text()).not.toContain('shutting down');
    expect(text()).not.toContain('server closed');
    expect(text()).not.toContain('uncaught exception');
  }, RUN_TIMEOUT_MS);
});
