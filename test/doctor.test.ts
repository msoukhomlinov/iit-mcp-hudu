/**
 * doctor.test.ts — C2, the zero-wire credential preflight.
 *
 * Two intake-adjacent surfaces answer "is the credential I loaded shaped like a credential, and is
 * it aimed where I meant?": the `doctor` subcommand and the `GET /doctor` route. Both must dial
 * NOTHING — that is the whole control, because the alternative answer to the same question is a
 * real auth failure against a vendor account where repeats risk a lock (2026-10-07 Autotask).
 *
 * The zero-dial pin is an assertion on `globalThis.fetch`, which is the only way this process can
 * reach Hudu: `src/doctor.ts` imports no client, so the report is computed from the environment
 * alone, and these tests prove it by stubbing fetch to fail loudly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { runDoctor } from '../src/doctor.js';
import { loadConfig } from '../src/config.js';
import { createFetchHandler, DOCTOR_PATH } from '../src/http.js';

afterEach(() => vi.unstubAllGlobals());

const BASE = 'https://hudu.example.com';

/** A fetch stub that fails loudly: any attempt to reach Hudu is a test failure, not a side effect. */
function noWire(): { calls: number } {
  const state = { calls: 0 };
  vi.stubGlobal('fetch', () => {
    state.calls++;
    throw new Error('doctor must never dial');
  });
  return state;
}

describe('C2: zero-wire preflight report', () => {
  it('reports a clean credential as ok, with shape facts and no value', () => {
    const report = runDoctor(loadConfig({ HUDU_BASE_URL: BASE, HUDU_API_KEY: 'eyJhbGciOiJIUzI1NiJ9.payload.sig' }));
    expect(report.ok).toBe(true);
    expect(report.dialed).toBe(0);
    expect(report.transport).toBe('stdio');
    expect(report.credentials).toEqual([
      { name: 'HUDU_API_KEY', status: 'ok', length: 32, prefix2: 'ey', shapeOk: true, anomalies: [], blocks: false },
    ]);
    expect(report.notes.join(' ')).not.toContain('would be refused');
    expect(report.bases).toEqual([{ name: 'HUDU_BASE_URL', present: true, origin: BASE, resolvable: true }]);
    // The whole report, serialized, may not contain the credential — only its length and prefix.
    expect(JSON.stringify(report)).not.toContain('payload.sig');
  });

  it('refuses (ok: false) a malformed credential without dialing, and names the anomalies', () => {
    // A malformed server-held credential does not reach `loadConfig` at all — the boot gate refuses
    // it first (see config.test.ts). The doctor is still the RIGHT venue for it, because it is
    // where the operator finds out WHY, from the same shape vocabulary, without a dial.
    const state = noWire();
    const report = runDoctor({ ...loadConfig({ HUDU_BASE_URL: BASE, HUDU_API_KEY: 'clean-key' }), HUDU_API_KEY: "'a$b c'" });
    expect(report.ok).toBe(false);
    expect(report.dialed).toBe(0);
    expect(state.calls).toBe(0);
    expect(report.credentials[0]).toMatchObject({
      status: 'malformed',
      shapeOk: false,
      anomalies: ['surrounding_single_quotes', 'embedded_quotes'],
      blocks: true,
    });
    expect(report.notes.join(' ')).toContain('account lock');
  });

  it('treats an absent stdio credential as blocking and an absent http one as fine', () => {
    // Under http the credential arrives per request, so "not set" is the valid shape and the report
    // must not claim the deployment is broken.
    const stdio = runDoctor(loadConfig({ MCP_TRANSPORT: 'http', HUDU_ALLOW_ANY_BASE_HOST: 'true' }));
    expect(stdio.ok).toBe(true);
    expect(stdio.credentials[0]).toEqual({ name: 'HUDU_API_KEY', status: 'absent', blocks: false });
    expect(stdio.notes.join(' ')).toContain('x-hudu-api-key');
  });

  it('reports the origin that will actually be dialed, and never a path or userinfo', () => {
    const report = runDoctor(loadConfig({ HUDU_BASE_URL: 'https://user:pw@hudu.example.com/deep/path?x=1', HUDU_API_KEY: 'clean-key' }));
    expect(report.bases[0]).toEqual({ name: 'HUDU_BASE_URL', present: true, origin: 'https://hudu.example.com', resolvable: true });
    // A URL carrying userinfo would otherwise smuggle a credential into every log sink this reaches.
    expect(JSON.stringify(report)).not.toContain('pw');
    expect(JSON.stringify(report)).not.toContain('deep/path');
  });

  it('reports an absent origin as absent rather than unresolvable', () => {
    // An omitted HUDU_BASE_URL is only legal when an allow-list or the BYO opt-in carries the
    // policy, so the report must not describe it as a failure.
    const report = runDoctor(loadConfig({ MCP_TRANSPORT: 'http', HUDU_ALLOW_ANY_BASE_HOST: 'true' }));
    expect(report.bases[0]).toEqual({ name: 'HUDU_BASE_URL', present: false, resolvable: false });
    expect(report.ok).toBe(true);
  });
});

describe('C2: GET /doctor route', () => {
  it('answers the report with no vendor request, and never reaches MCP', async () => {
    const state = noWire();
    const mcp = { calls: 0, fetch: async () => { mcp.calls++; return Response.json({}); } };
    const config = loadConfig({ HUDU_BASE_URL: BASE, HUDU_API_KEY: 'clean-key' });
    const res = await createFetchHandler(mcp, () => runDoctor(config))(new Request(`http://localhost:8787${DOCTOR_PATH}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.dialed).toBe(0);
    // The absent-dial pin, two ways: no fetch reached Hudu, and the MCP handler was never entered —
    // so no tool could have made a request either.
    expect(state.calls).toBe(0);
    expect(mcp.calls).toBe(0);
  });

  it('reports a malformed credential as not-ok without dialing', async () => {
    const state = noWire();
    const config = { ...loadConfig({ HUDU_BASE_URL: BASE, HUDU_API_KEY: 'clean-key' }), HUDU_API_KEY: "'a$b'" };
    const res = await createFetchHandler({ fetch: async () => Response.json({}) }, () => runDoctor(config))(
      new Request(`http://localhost:8787${DOCTOR_PATH}`),
    );
    expect((await res.json()).ok).toBe(false);
    expect(state.calls).toBe(0);
  });

  it('is answered before the MCP handler, under the same trust model as /healthz', async () => {
    // No credential header of any kind is sent: the route reports the SERVER's own environment, and
    // the caller that can reach this listener is the operator who set it.
    const mcp = { calls: 0, fetch: async () => { mcp.calls++; return Response.json({}); } };
    const config = loadConfig({ HUDU_BASE_URL: BASE, HUDU_API_KEY: 'clean-key' });
    await createFetchHandler(mcp, () => runDoctor(config))(new Request(`http://localhost:8787${DOCTOR_PATH}`));
    expect(mcp.calls).toBe(0);
  });

  it('keeps the route absent when no report builder is supplied, so no default leaks a config', async () => {
    const mcp = { calls: 0, fetch: async () => { mcp.calls++; return Response.json({ reached: true }); } };
    const res = await createFetchHandler(mcp)(new Request(`http://localhost:8787${DOCTOR_PATH}`, { method: 'POST', body: '{}' }));
    expect(mcp.calls).toBe(1);
    expect(res.status).toBe(200);
  });
});

describe('C2: `doctor` subcommand', () => {
  // Booted as a real process (`node --import tsx src/main.ts doctor`), the way the runbook runs it:
  // the exit code is what a deployment gate reads, so it has to be the process's own.
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  // A minimal environment: no HUDU_* value from the machine running the tests can leak in, and no
  // proxy variable can route a dial from the child either.
  const MIN_ENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };

  async function doctor(env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', 'doctor'], {
      cwd: ROOT,
      env: { ...MIN_ENV, NO_PROXY: '*', no_proxy: '*', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    const [code] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
    return { code: code ?? 0, stdout, stderr };
  }

  it('prints the report and exits 0 on a clean credential, dialing nothing', async () => {
    const { code, stdout } = await doctor({
      HUDU_BASE_URL: BASE,
      HUDU_API_KEY: 'the-local-test-key',
      // A dead proxy with no NO_PROXY bypass would make any accidental request fail loudly; the
      // assertion is on the report, and the runner has no route to Hudu in any case.
      HTTP_PROXY: 'http://127.0.0.1:1',
    });
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.ok).toBe(true);
    expect(report.dialed).toBe(0);
    expect(report.credentials[0]).toMatchObject({ name: 'HUDU_API_KEY', status: 'ok', prefix2: 'th', shapeOk: true });
    expect(stdout).not.toContain('the-local-test-key');
  });

  it('exits non-zero on a missing stdio credential, naming the variable', async () => {
    const { code, stdout } = await doctor({ HUDU_BASE_URL: BASE });
    expect(code).toBe(1);
    const body = JSON.parse(stdout);
    expect(body.ok).toBe(false);
    expect(body.stage).toBe('config');
    expect(body.error).toContain('HUDU_API_KEY');
  });

  it('exits non-zero on a malformed credential, pointing at the boot refusal and the anomaly', async () => {
    // `doctor` runs the SAME boot schema, so an unmodified environment holding a malformed key
    // stops at the config gate — the refusal is reported verbatim (with the load recipe in it), and
    // the shape vocabulary is in that message. Either route answers non-zero, which is the contract
    // a runbook step (`doctor && live-run`) needs.
    const { code, stdout } = await doctor({ HUDU_BASE_URL: BASE, HUDU_API_KEY: "'env$secret'" });
    expect(code).toBe(1);
    const body = JSON.parse(stdout);
    expect(body.ok).toBe(false);
    expect(body.stage).toBe('config');
    expect(body.error).toContain('surrounding_single_quotes');
    expect(body.error).toContain('shell sourcing');
    expect(stdout).not.toContain('env$secret');
  });

  it('never starts a transport: no serving line, and it exits rather than listening', async () => {
    // The subcommand returns before the logger is built, so a `doctor` run cannot leave a listener
    // or an MCP session behind — which is what makes it safe to call before a live session.
    const { code, stdout, stderr } = await doctor({
      MCP_TRANSPORT: 'http',
      HUDU_ALLOW_ANY_BASE_HOST: 'true',
      HUDU_BASE_URL: BASE,
      HUDU_API_KEY: 'clean-key',
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout).transport).toBe('http');
    expect(stdout).not.toContain('listening');
    expect(stderr).not.toContain('serving');
  });
});
