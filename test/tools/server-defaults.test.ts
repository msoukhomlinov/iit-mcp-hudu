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
