import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, connectForRequest } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

const DEFAULT_BASE = 'https://default.hudu.invalid';
const info = (key: string | null) => Response.json({ version: `as-${key}`, date: '2026-01-01' });

describe('http defaults: HUDU_BASE_URL / HUDU_API_KEY', () => {
  const defaults = { HUDU_BASE_URL: DEFAULT_BASE, HUDU_API_KEY: 'default-key' };

  it('a request with neither header runs against the default origin as the default key', async () => {
    const s = await connectForRequest(undefined, info, [], defaults, null);
    const r = await s.call('hudu_get_api_info', {});
    expect(r.structuredContent.record.version).toBe('as-default-key');
    expect(s.urls[0]).toMatch(/^https:\/\/default\.hudu\.invalid\//);
    await s.close();
  });

  it('a caller key with no origin runs against the default origin as the caller', async () => {
    const s = await connectForRequest('caller-key', info, [], defaults, null);
    const r = await s.call('hudu_get_api_info', {});
    expect(r.structuredContent.record.version).toBe('as-caller-key');
    expect(s.urls[0]).toMatch(/^https:\/\/default\.hudu\.invalid\//);
    await s.close();
  });

  it('never presents the default key to a caller-named origin', async () => {
    const s = await connectForRequest(undefined, info, [], defaults, 'https://attacker.invalid');
    const r = await s.call('hudu_get_api_info', {});
    expect(r.isError).toBe(true);
    expect(s.urls).toEqual([]);
    await s.close();
  });

  it('naming the default origin explicitly still gets the default key', async () => {
    const s = await connectForRequest(undefined, info, [], defaults, `${DEFAULT_BASE}/`);
    const r = await s.call('hudu_get_api_info', {});
    expect(r.structuredContent.record.version).toBe('as-default-key');
    await s.close();
  });

  it('a default key alone (no origin anywhere) still fails closed', async () => {
    const s = await connectForRequest(undefined, info, [], { HUDU_API_KEY: 'default-key' }, null);
    const r = await s.call('hudu_get_api_info', {});
    expect(r.isError).toBe(true);
    expect(s.urls).toEqual([]);
    await s.close();
  });
});

describe('http defaults with an unusable or foreign header origin', () => {
  const defaults = { HUDU_BASE_URL: DEFAULT_BASE, HUDU_API_KEY: 'default-key' };

  it('fails closed before dialing a caller-named origin when the list is unset', async () => {
    const s = await connectForRequest('caller-key', info, [], defaults, 'https://other.invalid');
    const r = await s.call('hudu_get_api_info', {});
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).toContain('x-hudu-base-url host not allowed');
    expect(s.urls).toEqual([]);
    await s.close();
  });

  it('an unparsable header origin never pairs with the default key, even with no default origin', async () => {
    // Both origins parse to `undefined`; that must not read as "the default origin".
    for (const overrides of [{ HUDU_API_KEY: 'default-key' }, defaults]) {
      const s = await connectForRequest(undefined, info, [], overrides, 'not-a-url');
      const r = await s.call('hudu_get_api_info', {});
      expect(r.isError).toBe(true);
      expect(s.urls).toEqual([]);
      await s.close();
    }
  });

  it('a blank header origin falls back to the default origin', async () => {
    const s = await connectForRequest('caller-key', info, [], defaults, '   ');
    const r = await s.call('hudu_get_api_info', {});
    expect(r.structuredContent.record.version).toBe('as-caller-key');
    expect(s.urls[0]).toMatch(/^https:\/\/default\.hudu\.invalid\//);
    await s.close();
  });
});

describe('http bring-your-own-origin mode', () => {
  it('still dials a caller-named origin when neither a default nor allow-list is set', async () => {
    const s = await connectForRequest('caller-key', info, [], {}, 'https://other.invalid');
    const r = await s.call('hudu_get_api_info', {});
    expect(r.structuredContent.record.version).toBe('as-caller-key');
    expect(s.urls[0]).toMatch(/^https:\/\/other\.invalid\//);
    await s.close();
  });
});

describe('http HUDU_ALLOWED_BASE_HOSTS', () => {
  const allow = { HUDU_ALLOWED_BASE_HOSTS: ['*.corp.example.com'] };

  it('serves an allowed caller-named origin', async () => {
    const s = await connectForRequest('k', info, [], allow, 'https://a.corp.example.com');
    const r = await s.call('hudu_get_api_info', {});
    expect(r.isError).toBeUndefined();
    expect(s.urls[0]).toMatch(/^https:\/\/a\.corp\.example\.com\//);
    await s.close();
  });

  it('fails closed on a disallowed origin without dialing it, even with a caller key', async () => {
    const s = await connectForRequest('k', info, [], allow, 'http://169.254.169.254');
    const r = await s.call('hudu_get_api_info', {});
    expect(r.isError).toBe(true);
    expect(s.urls).toEqual([]);
    await s.close();
  });

  it('does not apply to the operator-set default origin', async () => {
    const s = await connectForRequest(
      undefined, info, [],
      { ...allow, HUDU_BASE_URL: DEFAULT_BASE, HUDU_API_KEY: 'default-key' },
      null,
    );
    const r = await s.call('hudu_get_api_info', {});
    expect(r.isError).toBeUndefined();
    await s.close();
  });

  it('refuses another origin when a default exists, with or without a caller key', async () => {
    const overrides = { ...allow, HUDU_BASE_URL: DEFAULT_BASE, HUDU_API_KEY: 'default-key' };
    for (const key of [undefined, 'caller-key']) {
      const s = await connectForRequest(key, info, [], overrides, 'https://other.invalid');
      const r = await s.call('hudu_get_api_info', {});
      expect(r.isError).toBe(true);
      expect(s.urls).toEqual([]);
      await s.close();
    }
  });

  it('still serves tools/list for a keyless request naming a disallowed origin', async () => {
    const s = await connectForRequest(undefined, info, [], allow, 'https://other.invalid');
    expect((await s.list()).length).toBeGreaterThan(0);
    expect(s.urls).toEqual([]);
    await s.close();
  });
});

describe('literal-IP base hosts', () => {
  it('a stdio operator base of a literal private IP is trusted at the process boundary', async () => {
    // The floor applies to caller-named origins only: the operator's own HUDU_BASE_URL under
    // stdio is trusted at the process boundary, and an on-prem Hudu on a private IP must not
    // fail to boot because of the upgrade.
    const session = await connect(() => Response.json({ version: '2.45.1' }), { HUDU_BASE_URL: 'https://10.0.0.5' });
    const result = await session.call('hudu_get_api_info', {});
    expect(result.isError).toBeUndefined();
    expect(session.urls[0]).toMatch(/^https:\/\/10\.0\.0\.5\//);
    await session.close();
  });

  it('a caller-named literal private IP fails closed before any dial, even when the hostname allow-list permits it', async () => {
    const s = await connectForRequest('caller-key', info, [], { HUDU_BASE_URL: DEFAULT_BASE, HUDU_API_KEY: 'default-key', HUDU_ALLOWED_BASE_HOSTS: ['10.0.0.5'] }, 'https://10.0.0.5');
    const r = await s.call('hudu_get_api_info', {});
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).toContain('x-hudu-base-url invalid');
    expect(s.urls).toEqual([]);
    await s.close();
  });
});

describe('0.12.0 preset knobs: the env overrides', () => {
  // A fresh Response per dial: a consumed body cannot be re-read, so the stub must not hand
  // back one Response object twice.
  const article = () => Response.json({ id: 22, title: 't', body: 'b' });
  const read = { operation: 'articles.get', input: { id: 22 } };

  it('HUDU_CACHE_PRESET=off: two identical single-record reads both dial', async () => {
    const session = await connect(article, { HUDU_CACHE_PRESET: 'off' });
    for (let i = 0; i < 2; i++) {
      const r = await session.call('hudu_read', read);
      expect(r.isError).toBeUndefined();
    }
    expect(session.urls).toHaveLength(2);
    await session.close();
  });

  it('the default (on) cache serves the second identical read from the cache', async () => {
    const session = await connect(article, {});
    for (let i = 0; i < 2; i++) {
      const r = await session.call('hudu_read', read);
      expect(r.isError).toBeUndefined();
    }
    expect(session.urls).toHaveLength(1);
    await session.close();
  });

  it('the default cooldown arms when a 429 spends its retries: the next call is a local notSent refusal', async () => {
    const always429 = () => new Response('rate limited', { status: 429 });
    const session = await connect(always429, { HUDU_CACHE_PRESET: 'off' });
    // The gate arms when the 429's retries are SPENT (SDK issue #77): the first call spends the
    // profile's 1 retry — two wire attempts — and arms the per-tenant deadline afterwards.
    const first = await session.call('hudu_read', read);
    expect(first.isError).toBe(true);
    expect(session.urls).toHaveLength(2);
    // The gate is now armed: the next call is refused locally and never re-dials the vendor.
    const second = await session.call('hudu_read', read);
    expect(second.isError).toBe(true);
    // The envelope is double-encoded in the content text; parse it rather than string-matching.
    const env2 = JSON.parse(second.content[0].text);
    expect(env2.notSent).toBe(true);
    expect(session.urls).toHaveLength(2);
    await session.close();
  });

  it('HUDU_COOLDOWN=off: no gate arms, so the profile retry means two wire attempts', async () => {
    const always429 = () => new Response('rate limited', { status: 429 });
    const session = await connect(always429, { HUDU_CACHE_PRESET: 'off', HUDU_COOLDOWN: 'off' });
    const r = await session.call('hudu_read', read);
    expect(r.isError).toBe(true);
    // A vendor 429 (a sent call) must not be flagged notSent; the flag marks local refusals.
    const env1 = JSON.parse(r.content[0].text);
    expect(env1.notSent).toBeUndefined();
    expect(env1.httpStatus).toBe(429);
    expect(session.urls).toHaveLength(2);
    await session.close();
  });

  it('HUDU_TIMEOUT_MS wins over the profile deadline: an env 150 ms aborts a stalling vendor', async () => {
    // A wiring regression pin: removing `timeoutMs: config.HUDU_TIMEOUT_MS` from the options
    // literal would leave every other test green — the deadline would silently fall back to the
    // agent profile's 20 s. A vendor that never answers must be aborted by the ENV deadline.
    const session = await connect(undefined, { HUDU_TIMEOUT_MS: 150 });
    // The harness stub never honours the deadline's signal, so replace it with a vendor that
    // answers after 3 s — or rejects with the deadline's signal, whichever comes first.
    const dials: string[] = [];
    vi.stubGlobal(
      'fetch',
      async (url: unknown, init?: RequestInit) => {
        dials.push(String(url));
        return new Promise<Response>((resolve, reject) => {
          const t = setTimeout(() => resolve(Response.json({ version: 'late' })), 3000);
          (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      },
    );
    const started = Date.now();
    const r = await session.call('hudu_get_api_info', {});
    const elapsed = Date.now() - started;
    expect(r.isError).toBe(true);
    // The env deadline fired — not the 3 s stub and not the profile's 20 s.
    expect(elapsed).toBeLessThan(1500);
    expect(dials).toHaveLength(1);
    const env = JSON.parse(r.content[0].text);
    expect(env.category).toBe('timeout');
    await session.close();
  });
});
