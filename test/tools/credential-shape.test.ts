/**
 * credential-shape.test.ts — the two dispatch-time halves of the credential-shape gate.
 *
 * C1b: a per-request `x-hudu-api-key` whose shape is malformed is refused BEFORE a client is
 * constructed, so nothing is dialed. C1c: when a real auth failure comes back on a credential whose
 * shape this server already knows is anomalous, the refusal says so — value-free — instead of the
 * byte-identical `Bad credentials` a rotated key produces.
 *
 * Hudu is stubbed at `globalThis.fetch`, and the default `connect` stub throws if a request is ever
 * made, so "nothing was dialed" is an assertion here, not a convention.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, connectForRequest } from '../helpers/mcp-session.js';
import { loadConfig } from '../../src/config.js';

afterEach(() => vi.unstubAllGlobals());

const QUOTED_KEY = "'quoted$key'";
const CLEAN_KEY = 'clean-key';

describe('C1b: pre-dispatch shape validation on the per-request credential', () => {
  it.each([
    ['single quotes preserved', "'a$b'"],
    ['double quotes preserved', '"a$b"'],
    ['a lone embedded quote', "ab'cd"],
  ])('refuses a malformed x-hudu-api-key before any client is built: %s', async (_what, key) => {
    const session = await connectForRequest(key, () => Response.json({}), [], {}, 'https://hudu.example.com');
    const result = await session.call('hudu_get_api_info', {});
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text);
    // The typed refusal, consistent with the existing envelope taxonomy (POLICY_DENIED /
    // CONFIG_ERROR are the caller-side refusals): a validation category and no retry, because
    // nothing about the request will change if a retry loop forms.
    expect(body.code).toBe('CREDENTIAL_MALFORMED');
    expect(body.category).toBe('validation');
    expect(body.retryable).toBe(false);
    // No 401 shape: nothing was dialed, so an auth status would be a lie about the wire.
    expect(body.httpStatus).toBeUndefined();
    expect(body.suggestedAction).toContain('shell sourcing');
    // The wire is the proof: a malformed value must not reach even client construction.
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('names the anomaly but never a character of the key', async () => {
    const session = await connectForRequest("SENTINEL-'a$b'", () => Response.json({}), [], {}, 'https://hudu.example.com');
    const result = await session.call('hudu_get_api_info', {});
    const text = JSON.stringify(result);
    expect(text).not.toContain('SENTINEL');
    expect(text).not.toContain('a$b');
    // `surrounding_single_quotes` needs the value to START with a quote, which a prefixed sentinel
    // cannot be; the embedded quote still trips the gate, which is what the sentinel checks.
    expect(text).toContain('embedded_quotes');
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('logs one value-free refusal line per serving unit, and the key is in none of the logs', async () => {
    const logs: any[] = [];
    const session = await connectForRequest("'caller-secret-77'", () => Response.json({}), logs, {}, 'https://hudu.example.com');
    await session.call('hudu_get_api_info', {});
    // One line per serving unit — the three tool clients (read/write/delete) resolve through the
    // same request into the same cached placeholder, and each resolution logs the refusal it made.
    const refusals = logs.filter((l) => l.msg === 'refused a malformed Hudu credential before dialing');
    expect(refusals.length).toBeGreaterThan(0);
    for (const line of refusals) {
      expect(line.source).toBe('x-hudu-api-key');
      expect(line.anomalies).toEqual(['surrounding_single_quotes', 'embedded_quotes']);
      expect(typeof line.length).toBe('number');
    }
    expect(JSON.stringify(logs)).not.toContain('caller-secret-77');
    await session.close();
  });

  it('leaves a clean caller key on the ordinary path', async () => {
    const session = await connectForRequest(CLEAN_KEY, (key) => Response.json({ version: `as-${key}`, date: '2026-01-01' }));
    const result = await session.call('hudu_get_api_info', {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.record.version).toBe(`as-${CLEAN_KEY}`);
    expect(session.urls).toHaveLength(1);
    await session.close();
  });

  it('applies the same gate to the server-held HUDU_API_KEY default when the request brings none', async () => {
    // The default key is what actually reaches Hudu for a key-less request, so it is the value the
    // gate must check — the request-level header is simply absent here.
    const session = await connectForRequest(undefined, () => Response.json({}), [], { HUDU_API_KEY: QUOTED_KEY, HUDU_BASE_URL: 'https://default.hudu.invalid' }, null);
    const result = await session.call('hudu_get_api_info', {});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).code).toBe('CREDENTIAL_MALFORMED');
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('never presents a malformed caller key to the default origin either', async () => {
    const session = await connectForRequest(QUOTED_KEY, () => Response.json({}), [], {}, '   ');
    const result = await session.call('hudu_get_api_info', {});
    expect(result.isError).toBe(true);
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('refuses a NUL-bearing server-held key at BOOT, before any header machinery can throw', async () => {
    // A NUL byte is not a legal header character, so the shape gate's reason for flagging it is
    // different from the others: it would otherwise surface as a framework TypeError inside header
    // construction, before any auth strategy (and so any refusal) runs. At boot the operator gets a
    // typed config refusal instead.
    expect(() => loadConfig({ HUDU_BASE_URL: 'https://hudu.example.com', HUDU_API_KEY: 'abc\u0000def' })).toThrow(/nul_byte/);
  });

  it('flags a CR or edge whitespace in the boot credential, where the value is the server-held one', async () => {
    // Node's `Headers` strips CR and edge whitespace out of a header value, so a per-request header
    // CANNOT carry those anomalies by the time the server reads it. They are real for the
    // server-held value (a CRLF-edited .env), which is why the boot gate covers them.
    for (const bad of ['abc\r', 'abc\r\n', ' abc', 'abc ']) {
      expect(() => loadConfig({ HUDU_BASE_URL: 'https://hudu.example.com', HUDU_API_KEY: bad })).toThrow(/HUDU_API_KEY/);
    }
  });
});

describe('C1c: auth-failure diagnostics on an anomalous credential', () => {
  const refused = () => new Response(JSON.stringify({ error: 'Bad credentials' }), { status: 401, headers: { 'content-type': 'application/json' } });

  it('refuses a shape-anomalous credential instead of dialing, so no 401 can follow it', async () => {
    // A malformed credential is refused pre-dial, so it never becomes a 401 at all — which is the
    // point: the incident's opaque 401 came from a credential the server COULD have recognized as
    // malformed without asking the vendor.
    const session = await connectForRequest("'env$secret'", refused, [], {}, 'https://hudu.example.com');
    const result = await session.call('hudu_get_api_info', {});
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text);
    expect(body.code).toBe('CREDENTIAL_MALFORMED');
    expect(body.retryable).toBe(false);
    expect(JSON.stringify(result)).not.toContain('env$secret');
    // `refused` would have answered 401; it was never called, so no wire was touched.
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('annotates a genuine 401 whose credential was clean on the wire', async () => {
    // The annotation half of C1c: a value this server holds and has already measured as ANOMALOUS
    // (its shape was recorded when the serving unit started) is named in the refusal — value-free —
    // so a mangled load is distinguishable from a rotated key without another dial.
    //
    // The wire 401 below is deliberately produced for a CLEAN request-time key while the
    // environment's default is anomalous: the annotation reads the server's own view of the values
    // it holds, which is exactly what the control specifies (node-hudu 0.12.0 carries no shape
    // diagnostic of its own).
    const s = await connectForRequest(CLEAN_KEY, refused, [], { HUDU_API_KEY: "'env$secret'", HUDU_BASE_URL: 'https://default.hudu.invalid' }, 'https://default.hudu.invalid');
    const result = await s.call('hudu_get_api_info', {});
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text);
    // The code, the status and the message stay EXACTLY today's: existing tests pin those bytes.
    expect(body.code).toBe('UNAUTHORIZED');
    expect(body.httpStatus).toBe(401);
    expect(body.message).toBe('Bad credentials');
    // The diagnostic is additive.
    expect(body.credentialShape).toBe('anomalous');
    expect(body.anomalies).toContain('surrounding_single_quotes');
    expect(body.suggestedAction).toContain('shell sourcing');
    // It says what to suspect, and it says not to re-dial — the account may lock.
    expect(body.suggestedAction).toContain('do NOT re-dial');
    expect(JSON.stringify(result)).not.toContain('env$secret');
    await s.close();
  });

  it('annotates the stdio path from the server-held credential too', async () => {
    await expect(
      connect(refused, { HUDU_API_KEY: "'env$secret'" }).then(async (s) => {
        const result = await s.call('hudu_get_api_info', {});
        const body = JSON.parse(result.content[0]!.text);
        expect(body).toMatchObject({ code: 'UNAUTHORIZED', httpStatus: 401, message: 'Bad credentials' });
        expect(body.anomalies).toContain('surrounding_single_quotes');
        await s.close();
      }),
    ).resolves.toBeUndefined();
  });

  it('keeps the exact legacy envelope when the credential is clean', async () => {
    // The value the server holds is clean, so nothing is inferred and nothing is added: this is the
    // envelope every pre-existing test pins, unchanged.
    const s = await connectForRequest(CLEAN_KEY, refused);
    const result = await s.call('hudu_get_api_info', {});
    expect(JSON.parse(result.content[0]!.text)).toEqual({ error: true, code: 'UNAUTHORIZED', httpStatus: 401, message: 'Bad credentials' });
    await s.close();

    const stdio = await connect(refused);
    const legacy = await stdio.call('hudu_get_api_info', {});
    expect(JSON.parse(legacy.content[0]!.text)).toEqual({ error: true, code: 'UNAUTHORIZED', httpStatus: 401, message: 'Bad credentials' });
    await stdio.close();
  });
});
