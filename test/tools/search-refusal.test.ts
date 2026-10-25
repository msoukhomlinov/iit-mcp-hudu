/**
 * search-refusal.test.ts — the search paths answer a refused request exactly as every other tool
 * does (issue #32).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectForRequest, type Json } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

const never = () => { throw new Error('no Hudu request may be issued'); };
const DEFAULTS = { HUDU_BASE_URL: 'https://hudu.invalid', HUDU_API_KEY: 'default-key' };
const MALFORMED_KEY = "'env$secret'";

type Call = (s: Awaited<ReturnType<typeof connectForRequest>>) => Promise<Json>;
const calls: Record<string, Call> = {
  'hudu_search': (s) => s.call('hudu_search', { mode: 'search', query: 'reset' }),
  'hudu_read searchKnowledge': (s) => s.call('hudu_read', { operation: 'operations.searchKnowledge', input: { query: 'reset' } }),
  'hudu_read searchAcross': (s) => s.call('hudu_read', { operation: 'operations.searchAcrossResources', input: { query: 'reset', opts: { resources: ['articles'] } } }),
};

describe.each(Object.entries(calls))('%s on a refused request', (_name, call) => {
  it('answers a malformed header key with CREDENTIAL_MALFORMED, before any request', async () => {
    const s = await connectForRequest(MALFORMED_KEY, never);
    const r = await call(s);
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0]!.text);
    expect(body.code).toBe('CREDENTIAL_MALFORMED');
    expect(body.message).toContain('surrounding_single_quotes');
    expect(s.urls).toEqual([]);
    await s.close();
  });

  it('answers a refused origin with the AUTH_ERROR envelope other tools return, before any request', async () => {
    const s = await connectForRequest('caller-key', never, [], DEFAULTS, 'https://other.invalid');
    const r = await call(s);
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0]!.text);
    expect(body).toMatchObject({ error: true, code: 'AUTH_ERROR', category: 'auth' });
    expect(body.message).toContain('x-hudu-base-url host not allowed');
    expect(s.urls).toEqual([]);
    await s.close();
  });
});
