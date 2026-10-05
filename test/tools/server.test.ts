/**
 * server.test.ts — the server factory and per-credential client cache: the caller-facing error
 * surface, the redacted audit hook, and the per-request Hudu credential under `http`.
 * Pairs with `src/tools/server.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HuduClient } from 'node-hudu';
import { boundAuditQuery, ScopedClientCache } from '../../src/tools/server.js';
import { createLogger } from '../../src/logger.js';
import { API_KEY, connect, connectForRequest, type Json } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

describe('error surface', () => {
  it('passes HuduError.code to the caller and the API key to nobody', async () => {
    const session = await connect(() => new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } }));
    const result = await session.call('hudu_get_group', { identifier: 999 });
    expect(result.isError).toBe(true);
    // A model corrects itself off the code; a bare "request failed" makes it retry blindly.
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    await session.close();
  });

  it('bounds the upstream body in the error message on a no-allow-list dial-out', async () => {
    // The live repro (N10-4/N10-14, N12-8b/9b): no HUDU_ALLOWED_BASE_HOSTS, the caller dials
    // example.com, and its multi-kilobyte 404 page used to cross into the envelope verbatim.
    const html = '<html><head><title>404</title></head><body><h1>404 Not Found</h1><p>The requested resource was not found on this server.</p></body></html>'.repeat(60);
    const session = await connectForRequest('key-57', () => new Response(html, { status: 404, headers: { 'content-type': 'text/html' } }), [], {}, 'https://example.com');
    const result = await session.call('hudu_get_api_info', {});
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({ error: true, code: 'NOT_FOUND', status: 404 });
    expect(body.message.length).toBeLessThanOrEqual(200);
    expect(body.message).not.toContain('<');
    expect(body.message).toContain('404');
    expect(body.message).toContain('example.com');
    expect(body.message).not.toContain('was not found');
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    await session.close();
  });

  it('bounds a long upstream JSON error detail on the wire too', async () => {
    const detail = 'Internal error: the vendor could not complete the request. '.repeat(30);
    const session = await connectForRequest('key-57', () => Response.json({ message: detail }, { status: 500 }), [], {}, 'https://example.com');
    const result = await session.call('hudu_get_api_info', {});
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({ error: true, code: 'SERVER_ERROR', status: 500 });
    expect(body.message.length).toBeLessThanOrEqual(200);
    expect(body.message).not.toContain('<');
    expect(body.message).toContain('500');
    expect(body.message).toContain('example.com');
    await session.close();
  });
});

describe('audit hook', () => {
  it('writes one redacted line per Hudu request, and the key is in none of them', async () => {
    const session = await connect(() => Response.json({ version: '2.45.1' }));
    await session.call('hudu_get_api_info', {});
    const audited = session.logs.filter((l) => l.msg === 'hudu request');
    // Without this the tool call is visible to the MCP client and the requests it became are not.
    expect(audited).toHaveLength(session.urls.length);
    expect(audited[0]).toMatchObject({ operation: 'api_info.get', method: 'GET', outcome: 'success' });
    expect(JSON.stringify(session.logs)).not.toContain(API_KEY);
    await session.close();
  });

  it("logs a search query shape without its potentially secret value", async () => {
    const session = await connect(() => Response.json([]));
    const secret = "probe-secret-7c4c0bd6-2a2b-43e6-b3bc-58a4b4204ba6";
    const result = await session.call("hudu_search", { mode: "search", query: secret, limit: 1, snippetChars: 0 });
    expect(result.isError).toBeUndefined();
    const line = session.logs.find((l) => l.msg === "hudu request" && l.query?.search?.type === "string");
    expect(line, "the search request writes an audit line carrying its query").toBeDefined();
    const text = JSON.stringify(line);
    expect(text.length).toBeLessThan(2000);
    expect(text).not.toContain(secret);
    expect(line!.query!.search).toEqual({ type: "string", chars: secret.length });
    for (const field of ["operation", "method", "path", "effect", "dryRun", "outcome", "correlationId", "timestamp"]) {
      expect(line!, field).toHaveProperty(field);
    }
    if (line!.httpStatus !== undefined) expect(line!.httpStatus).toBeGreaterThanOrEqual(100);
    await new Promise((r) => setTimeout(r, 100));
    await session.close();
  });

  it("bounds array and object query values by count", () => {
    const values = Array.from({ length: 100_000 }, (_, index) => index);
    const query = boundAuditQuery({ ids: values, input: { token: "never-log-this", nested: true }, page: 2, archived: false });
    const text = JSON.stringify(query);
    expect(text.length).toBeLessThan(2000);
    expect(text).not.toContain("never-log-this");
    expect(query).toEqual({
      ids: { type: "array", items: 100_000 },
      input: { type: "object", keys: 2 },
      page: 2,
      archived: false,
    });
  });
});

describe('per-request Hudu credential', () => {
  // Under `http` the server holds no Hudu key: the caller supplies one per request in the
  // `x-hudu-api-key` header, and the SDK builds a client scoped to it. These tests drive the
  // factory directly with a request context, which is exactly what `createMcpHandler` does.

  it('answers each concurrent caller from its own credential, never the other’s', async () => {
    const a = await connectForRequest('key-a', (key) =>
      Response.json({ version: `tenant-of-${key}`, date: '2026-01-01' }),
    );
    const b = await connectForRequest('key-b', (key) =>
      Response.json({ version: `tenant-of-${key}`, date: '2026-01-01' }),
    );
    // Interleave the two calls so a shared client would have to serve both from one identity.
    const [ra, rb] = await Promise.all([a.call('hudu_get_api_info', {}), b.call('hudu_get_api_info', {})]);
    expect(ra.isError).toBeUndefined();
    expect(rb.isError).toBeUndefined();
    expect(ra.structuredContent.record.version).toBe('tenant-of-key-a');
    expect(rb.structuredContent.record.version).toBe('tenant-of-key-b');
    await a.close();
    await b.close();
  });

  it('never writes the caller’s Hudu key into a log line or a tool result', async () => {
    const key = 'super-secret-per-request-hudu-key';
    const logs: Json[] = [];
    const session = await connectForRequest(key, () => Response.json({ version: '2.45.1' }), logs);
    const result = await session.call('hudu_get_api_info', {});
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(logs)).not.toContain(key);
    await session.close();
  });

  it('caches scoped clients by (origin, credential) hash: same pair reuses, different pairs do not', () => {
    const cache = new ScopedClientCache(
      (baseUrl, apiKey) => new HuduClient({ baseUrl, apiKey }),
      2,
      createLogger('error', () => {}),
    );
    const a1 = cache.for('https://origin-a.invalid', 'key-a');
    // Same key, different origin: a different client, or one tenant's index would answer the
    // other's search.
    const b = cache.for('https://origin-b.invalid', 'key-a');
    expect(a1).not.toBe(b);
    expect(cache.for('https://origin-a.invalid', 'key-a')).toBe(a1);
    const c = cache.for('https://origin-a.invalid', 'key-c');
    // Capacity 2: (origin-a, key-c) evicts the least-recently-used, which is (origin-b, key-a)
    // after the (origin-a, key-a) hit above. The evicted pair must come back as a fresh client.
    expect(cache.for('https://origin-b.invalid', 'key-a')).not.toBe(b);
    expect(cache.for('https://origin-a.invalid', 'key-c')).toBe(c);
  });

  it('bounds the number of warm scoped clients', () => {
    const evicted: Json[] = [];
    const cache = new ScopedClientCache(
      (baseUrl, apiKey) => new HuduClient({ baseUrl, apiKey }),
      3,
      createLogger('info', (l) => evicted.push(JSON.parse(l))),
    );
    for (let i = 0; i < 12; i++) cache.for('https://hudu.invalid', `key-${i}`);
    expect(evicted.length).toBe(9);
    // The eviction line names no credential: only that the working set moved on.
    expect(JSON.stringify(evicted)).not.toContain('key-');
  });

  it('serves tools/list for a key-less request so a client catalog can sync', async () => {
    // A client catalog sync has no run, so it cannot carry a per-user or per-agent Hudu key.
    // `initialize`/`tools/list` must still answer key-less, or the catalog cannot sync.
    const session = await connectForRequest(undefined, () => {
      throw new Error('a key-less catalog request must not reach Hudu');
    });
    const tools = await session.list();
    expect(tools).toHaveLength(21);
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('fails closed on a key-less tool call and borrows no identity', async () => {
    const session = await connectForRequest(undefined, () => Response.json({ version: 'should-never-be-reached' }));
    const result = await session.call('hudu_get_api_info', {});
    expect(result.isError).toBe(true);
    // The credential-less parent throws before a Hudu request is built, so nothing was fetched.
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('advertises the vendor-safe "auto" default under http, not a cold index build', async () => {
    const session = await connectForRequest('key-a', () => Response.json([]));
    const help = await session.call('hudu_search', { mode: 'help' });
    expect(help.structuredContent.help.defaults.tier).toBe('auto');
    const tool = (await session.list()).find((t) => t.name === 'hudu_search');
    expect(tool!.description).not.toContain('defaults to tier "index"');
    expect(tool!.description).toContain('defaults to tier "auto"');
    await session.close();
  });

  it('answers a first keyed search without awaiting a corpus-wide index build', async () => {
    // A cold scoped client must not await the body-index walk on the caller's first search; some
    // clients enforce a 60s call timeout. "auto" answers from the vendor tier and reports the degradation.
    const session = await connectForRequest('key-a', () => Response.json([]));
    const result = await session.call('hudu_search', { mode: 'search', query: 'reset', limit: 1, snippetChars: 0 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.meta.degraded).toBeTruthy();
    // Let the fire-and-forget background warm settle against this test's stub before afterEach
    // removes the global fetch stub.
    await new Promise((r) => setTimeout(r, 100));
    await session.close();
  });
});
it('scopes each mutation client to the HTTP caller credential', async () => {
  for (const key of ['caller-one', 'caller-two']) {
    const seen: Array<string | null> = [];
    const session = await connectForRequest(key, (credential) => {
      seen.push(credential);
      return Response.json({ company: { id: 1, name: 'changed' } });
    });
    try {
      for (const [name, operation, input] of [
        ['hudu_write', 'companies.update', { id: 1, data: { name: 'changed' } }],
        ['hudu_delete', 'companies.delete', { id: 1 }],
      ] as const) {
        expect((await session.call(name, { operation, input, dry_run: false, confirm: operation })).isError).toBeUndefined();
      }
      expect(seen).toEqual([key, key]);
    } finally { await session.close(); }
  }
});

describe('invalid x-hudu-base-url', () => {
  // The SDK rejects a malformed origin when the scoped client is built. That must not escape the
  // per-request factory: the catalog still syncs, and only the tool call fails, before any dial.
  it.each([
    ['not a URL', 'not-a-url'],
    ['a non-http scheme', 'ftp://hudu.invalid'],
    ['a path', 'https://hudu.invalid/api/v1'],
  ])('serves tools/list but fails closed on tool calls when the base URL is %s', async (_label, base) => {
    const session = await connectForRequest(
      'key-a',
      () => Response.json({ version: 'should-never-be-reached' }),
      [],
      {},
      base,
    );
    expect(await session.list()).toHaveLength(21);
    const result = await session.call('hudu_get_api_info', {});
    expect(result.isError).toBe(true);
    expect(session.urls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('key-a');
    await session.close();
  });
});
