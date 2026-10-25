/**
 * refusing-states.test.ts — every refusing client state answers the AUTH_ERROR (or
 * CREDENTIAL_MALFORMED) envelope on the search and batch-read paths, before any request (issue #35).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectForRequest, type Json } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

const never = () => { throw new Error('no Hudu request may be issued'); };
const DEFAULTS = { HUDU_BASE_URL: 'https://hudu.invalid', HUDU_API_KEY: 'default-key' };
type Sess = Awaited<ReturnType<typeof connectForRequest>>;

const states: Record<string, { open: () => Promise<Sess>; code: string }> = {
  'malformed key': { open: () => connectForRequest("'env$secret'", never), code: 'CREDENTIAL_MALFORMED' },
  'refused origin': { open: () => connectForRequest('caller-key', never, [], DEFAULTS, 'https://other.invalid'), code: 'AUTH_ERROR' },
  'key but no origin': { open: () => connectForRequest('caller-key', never, [], {}, null), code: 'AUTH_ERROR' },
  'invalid base URL': { open: () => connectForRequest('caller-key', never, [], {}, 'ftp://nope'), code: 'AUTH_ERROR' },
  'keyless request': { open: () => connectForRequest(undefined, never), code: 'AUTH_ERROR' },
};
const ITEMS = [{ resource: 'articles', id: 1 }, { resource: 'companies', id: 2 }];
const paths: Record<string, (s: Sess) => Promise<Json>> = {
  hudu_search: (s) => s.call('hudu_search', { mode: 'search', query: 'reset' }),
  'read searchKnowledge': (s) => s.call('hudu_read', { operation: 'operations.searchKnowledge', input: { query: 'reset' } }),
  'read searchAcross (isolating)': (s) => s.call('hudu_read', { operation: 'operations.searchAcrossResources', input: { query: 'reset', opts: { resources: ['articles'], isolateErrors: true } } }),
  hudu_fetch_many: (s) => s.call('hudu_fetch_many', { items: ITEMS }),
  'read fetchMany': (s) => s.call('hudu_read', { operation: 'operations.fetchMany', input: { items: ITEMS } }),
};

describe.each(Object.entries(states))('%s', (_s, { open, code }) => {
  it.each(Object.entries(paths))('%s: top-level refusal, zero requests', async (_p, call) => {
    const s = await open();
    const r = await call(s);
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0]!.text);
    expect(body).toMatchObject({ error: true, code });
    expect(body.results).toBeUndefined();
    expect(s.urls).toEqual([]);
    await s.close();
  });

  it('hudu_read fetchMany with bad input is still refused as input', async () => {
    const s = await open();
    const r = await s.call('hudu_read', { operation: 'operations.fetchMany', input: {} });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text).code).not.toBe(code);
    expect(s.urls).toEqual([]);
    await s.close();
  });
});

describe('a genuine vendor failure keeps its per-item / per-resource shape', () => {
  const vendor = (status: number) => () => new Response(JSON.stringify({ error: 'Bad credentials' }), { status, headers: { 'content-type': 'application/json' } });
  const fetchMany = (s: Sess, name: string) => name === 'hudu_fetch_many'
    ? s.call('hudu_fetch_many', { items: [ITEMS[0]] })
    : s.call('hudu_read', { operation: 'operations.fetchMany', input: { items: [ITEMS[0]] } });
  const payload = (r: Json, name: string) => (name === 'hudu_fetch_many' ? r.structuredContent : r.structuredContent.result);

  it.each(['hudu_fetch_many', 'read fetchMany'])('%s: a 404 on one item is a per-item row, not a top-level error', async (name) => {
    const s = await connectForRequest('valid-key-000', vendor(404));
    const r = await fetchMany(s, name);
    expect(r.isError).toBeUndefined();
    expect(payload(r, name)).toMatchObject({ ok: 0, failed: 1 });
    expect(s.urls).toHaveLength(1);
    await s.close();
  });

  it.each(['hudu_fetch_many', 'read fetchMany'])('%s: a vendor 401 stays a per-item error', async (name) => {
    const s = await connectForRequest('valid-key-000', vendor(401));
    const r = await fetchMany(s, name);
    expect(r.isError).toBeUndefined();
    const out = payload(r, name);
    expect(out).toMatchObject({ ok: 0, failed: 1 });
    expect(out.results[0].error.code).toBe('UNAUTHORIZED');
    expect(s.urls).toHaveLength(1);
    await s.close();
  });

  it.each(['hudu_search', 'read searchKnowledge'])('%s: a vendor 401 on every resource keeps the legacy UNAUTHORIZED envelope', async (name) => {
    const s = await connectForRequest('valid-key-000', vendor(401));
    const r = name === 'hudu_search'
      ? await s.call('hudu_search', { mode: 'search', query: 'reset' })
      : await s.call('hudu_read', { operation: 'operations.searchKnowledge', input: { query: 'reset' } });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text)).toEqual({ error: true, code: 'UNAUTHORIZED', httpStatus: 401, message: 'Bad credentials' });
    expect(s.urls.length).toBeGreaterThan(0);
    await s.close();
  });
});

describe.each(Object.entries(states))('%s: local validation and policy refusals win over the credential refusal', (_s, { open, code }) => {
  it('hudu_search with no query is CONFIG_ERROR', async () => {
    const s = await open();
    const r = await s.call('hudu_search', { mode: 'search' });
    expect(r.isError).toBe(true);
    const c = JSON.parse(r.content[0]!.text).code;
    expect(c).toBe('CONFIG_ERROR');
    expect(c).not.toBe(code);
    expect(s.urls).toEqual([]);
    await s.close();
  });

  it.each(['hudu_fetch_many', 'read fetchMany'])('%s: a credential item is POLICY_DENIED, not the credential refusal', async (name) => {
    const s = await open();
    const items = [{ resource: 'asset_passwords', id: 1 }];
    const r = name === 'hudu_fetch_many'
      ? await s.call('hudu_fetch_many', { items })
      : await s.call('hudu_read', { operation: 'operations.fetchMany', input: { items } });
    expect(r.isError).toBe(true);
    const c = JSON.parse(r.content[0]!.text).code;
    expect(c).toBe('POLICY_DENIED');
    expect(c).not.toBe(code);
    expect(s.urls).toEqual([]);
    await s.close();
  });
});

describe('a refusing request keeps the excluded-tier error', () => {
  it('hudu_search tier:index with a corpus-excluding scope is its CONFIG_ERROR', async () => {
    const s = await connectForRequest('caller-key', never, [], { HUDU_SEARCH_RESOURCES: ['companies'] }, null);
    const r = await s.call('hudu_search', { mode: 'search', query: 'reset', tier: 'index' });
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0]!.text);
    expect(body.code).toBe('CONFIG_ERROR');
    expect(body.message).toContain('body index is unavailable');
    expect(s.urls).toEqual([]);
    await s.close();
  });
});
