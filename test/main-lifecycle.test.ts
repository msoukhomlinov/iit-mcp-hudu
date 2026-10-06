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
//
// The http boot's port is a re-roll, not a fixed choice. The probe and the server see different
// port tables — a probe bound on `127.0.0.1` checks the v4 table only, while the server binds no
// host, i.e. dual-stack `::`, which the v6 table governs — and the probe-to-bind window spans a
// full child process boot. Either way a "free" port can still be taken, the server then logs
// `listen failed` / EADDRINUSE and exits 1, and the test re-rolls on a fresh port instead of
// failing on a collision that says nothing about the lifecycle under test.

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const READY_TIMEOUT_MS = 20000;
const RUN_TIMEOUT_MS = 60000;
/** Fresh ports a stolen-port EADDRINUSE may be re-rolled on before the test gives up. */
const MAX_PORT_ATTEMPTS = 5;

// A minimal environment: no HUDU_* value from the machine running the tests can leak into the
// server process.
const MIN_ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };

// Bind the probe the way the server binds — no host, so the kernel's picker checks the same
// (dual-stack, v6-governed) view of the port table the server's own `::` listen gets. A probe on
// `127.0.0.1` alone checks the v4 table only: a port a v6-side listener already holds passes that
// check yet makes the server's bind fail with EADDRINUSE.
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, resolve));
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

function watchChild(child: ChildProcessWithoutNullStreams): Watch {
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

// Wait until the server answers healthz or logs that it could not bind. The caller owns the
// deadline — one shared deadline across every attempt, not one per boot — so a run that keeps
// losing its ports still fails in bounded time.
async function waitOutcome(
  url: string,
  text: () => string,
  deadline: number,
): Promise<'healthy' | 'listen-failed'> {
  for (;;) {
    if (text().includes('"msg":"listen failed"')) return 'listen-failed';
    if (await probe(url)) return 'healthy';
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}; server log:\n${text()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Boot the http transport until it answers healthz. A stolen port shows up as `listen failed`
// with EADDRINUSE and an exit 1; that re-rolls on a fresh port. Any other way of not coming up is
// a real failure of the thing under test and fails the run immediately.
async function bootHealthyHttp(): Promise<{ child: ChildProcessWithoutNullStreams; watch: Watch }> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    const child = boot({ MCP_TRANSPORT: 'http', HUDU_ALLOW_ANY_BASE_HOST: 'true', PORT: String(port), LOG_LEVEL: 'info' });
    const watch = watchChild(child);
    const outcome = await waitOutcome(`http://127.0.0.1:${port}/healthz`, watch.text, deadline);
    if (outcome === 'healthy') return { child, watch };
    if (!watch.text().includes('EADDRINUSE')) {
      throw new Error(`server did not come up; server log:\n${watch.text()}`);
    }
    if (attempt >= MAX_PORT_ATTEMPTS) {
      throw new Error(`EADDRINUSE on every one of ${attempt} fresh ports; server log:\n${watch.text()}`);
    }
    await watch.close; // the failed boot has exited on its own; drain it before re-booting
  }
}

describe('process lifecycle, as wired by src/main.ts', () => {
  it('http: SIGTERM leaves shutting-down and server-closed lines and exits 0', async () => {
    const { child, watch: { text, close } } = await bootHealthyHttp();

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
    const { text, close } = watchChild(child);

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
