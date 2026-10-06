import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';

const valid = {
  HUDU_BASE_URL: 'https://hudu.example.com',
  HUDU_API_KEY: 'k-123',
};

// Opts out of the http allow-list requirement for tests about something else.
const ANY = { HUDU_ALLOW_ANY_BASE_HOST: 'true' };

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const c = loadConfig(valid);
    expect(c.MCP_TRANSPORT).toBe('stdio');
    expect(c.PORT).toBe(8787);
    expect(c.LOG_LEVEL).toBe('info');
    // Fail closed: omitting the policy must not open the write surface.
    expect(c.HUDU_WRITE_POLICY).toBe('deny');
    expect(c.HUDU_WRITE_ALLOW).toEqual([]);
  });

  it('rejects a missing credential', () => {
    expect(() => loadConfig({ HUDU_BASE_URL: valid.HUDU_BASE_URL })).toThrow(ConfigError);
  });

  it('rejects a non-URL base', () => {
    expect(() => loadConfig({ ...valid, HUDU_BASE_URL: 'hudu.example.com' })).toThrow(ConfigError);
  });

  it('reports every problem at once, not just the first', () => {
    try {
      loadConfig({ HUDU_BASE_URL: 'hudu.example.com', PORT: '70000' });
      expect.unreachable('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('HUDU_BASE_URL');
      expect(msg).toContain('PORT');
    }
  });

  it('accepts http transport with no server-held Hudu config at all', () => {
    // Under `http` the origin and the credential both arrive per request, so a server with no
    // tenant-shaped environment at all is the valid shape.
    const c = loadConfig({ MCP_TRANSPORT: 'http', ...ANY });
    expect(c.MCP_TRANSPORT).toBe('http');
    expect(c.HUDU_API_KEY).toBeUndefined();
    expect(c.HUDU_BASE_URL).toBeUndefined();
  });

  it('accepts a default Hudu base URL and key under http', () => {
    const c = loadConfig({ ...valid, MCP_TRANSPORT: 'http', ...ANY });
    expect(c.HUDU_BASE_URL).toBe(valid.HUDU_BASE_URL);
    expect(c.HUDU_API_KEY).toBe(valid.HUDU_API_KEY);
  });

  it('requires a Hudu base URL under stdio, naming the variable', () => {
    // The origin must come from somewhere. Under stdio that somewhere is the environment.
    expect(() => loadConfig({ HUDU_API_KEY: valid.HUDU_API_KEY, MCP_TRANSPORT: 'stdio' })).toThrow(/HUDU_BASE_URL is required/);
  });

  it('treats a blank HUDU_BASE_URL as unset, so a copied .env.example boots under http', () => {
    const c = loadConfig({ MCP_TRANSPORT: 'http', ...ANY, HUDU_BASE_URL: '' });
    expect(c.MCP_TRANSPORT).toBe('http');
    expect(c.HUDU_BASE_URL).toBeUndefined();
  });

  it('ignores the removed MCP_AUTH_TOKEN: a stale environment still boots and the variable is dropped', () => {
    // The shared-secret gate is gone; an environment that still carries the old variable must not
    // fail boot, and the variable must not survive into the parsed config.
    const c = loadConfig({ MCP_TRANSPORT: 'http', ...ANY, MCP_AUTH_TOKEN: 'stale' });
    expect(c.MCP_TRANSPORT).toBe('http');
    expect('MCP_AUTH_TOKEN' in c).toBe(false);
  });

  it('requires a server-held Hudu key under stdio, naming the variable', () => {
    // The key must come from somewhere. Under stdio that somewhere is the environment.
    expect(() => loadConfig({ HUDU_BASE_URL: valid.HUDU_BASE_URL, MCP_TRANSPORT: 'stdio' })).toThrow(/HUDU_API_KEY is required/);
  });

  it('parses HUDU_ALLOWED_BASE_HOSTS to a lowercased list, and leaves it unset when absent or blank', () => {
    expect(loadConfig({ MCP_TRANSPORT: 'http', ...ANY }).HUDU_ALLOWED_BASE_HOSTS).toBeUndefined();
    expect(loadConfig({ MCP_TRANSPORT: 'http', ...ANY, HUDU_ALLOWED_BASE_HOSTS: ' ' }).HUDU_ALLOWED_BASE_HOSTS).toBeUndefined();
    expect(
      loadConfig({ MCP_TRANSPORT: 'http', HUDU_ALLOWED_BASE_HOSTS: 'Hudu.Example.com, *.corp.example.com' }).HUDU_ALLOWED_BASE_HOSTS,
    ).toEqual(['hudu.example.com', '*.corp.example.com']);
  });

  it('refuses to boot under http in bring-your-own-origin mode unless HUDU_ALLOW_ANY_BASE_HOST=true', () => {
    expect(() => loadConfig({ MCP_TRANSPORT: 'http' })).toThrow(/HUDU_ALLOWED_BASE_HOSTS: or HUDU_BASE_URL is required/);
    expect(() => loadConfig({ MCP_TRANSPORT: 'http', HUDU_ALLOWED_BASE_HOSTS: ' ' })).toThrow(ConfigError);
    expect(() => loadConfig({ MCP_TRANSPORT: 'http', HUDU_ALLOW_ANY_BASE_HOST: 'false' })).toThrow(ConfigError);
    // Either an allow-list or a default origin already restricts callers, so neither needs the opt-out.
    expect(loadConfig({ MCP_TRANSPORT: 'http', HUDU_ALLOWED_BASE_HOSTS: 'hudu.example.com' }).MCP_TRANSPORT).toBe('http');
    expect(loadConfig({ MCP_TRANSPORT: 'http', HUDU_BASE_URL: valid.HUDU_BASE_URL }).MCP_TRANSPORT).toBe('http');
    expect(loadConfig({ MCP_TRANSPORT: 'http', HUDU_ALLOW_ANY_BASE_HOST: 'true' }).MCP_TRANSPORT).toBe('http');
    expect(loadConfig(valid).MCP_TRANSPORT).toBe('stdio');
  });

  it('rejects a HUDU_ALLOWED_BASE_HOSTS entry that is not a bare hostname', () => {
    for (const bad of ['https://hudu.example.com', 'hudu.example.com:8443', 'hudu.example.com/x', '*']) {
      expect(() => loadConfig({ MCP_TRANSPORT: 'http', ...ANY, HUDU_ALLOWED_BASE_HOSTS: bad })).toThrow(/not a hostname/);
    }
  });

  it('refuses a structurally impossible entry at boot, naming it', () => {
    // The shape check's middle `[a-z0-9.-]*` once admitted these: they booted cleanly and sat in
    // an ACTIVE list matching no real hostname (night-12 N12-15: `a..b` booted, foreign origins
    // still refused, the entry itself dead). They must fail boot like scheme and port entries do,
    // and the message must name the entry.
    for (const bad of ['a..b', '*.a..b.com', 'a.-b', 'a-b-.c', 'a.' + 'a'.repeat(64)]) {
      try {
        loadConfig({ MCP_TRANSPORT: 'http', HUDU_ALLOWED_BASE_HOSTS: bad });
        expect.unreachable(`should have thrown for ${bad}`);
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain('HUDU_ALLOWED_BASE_HOSTS');
        expect(msg).toContain(bad);
      }
    }
  });

  it('still refuses edge-dot and edge-hyphen labels the shape check covers', () => {
    for (const bad of ['-bad.', 'bad-.', '-bad', 'bad-', '.a', 'a.']) {
      try {
        loadConfig({ MCP_TRANSPORT: 'http', HUDU_ALLOWED_BASE_HOSTS: bad });
        expect.unreachable(`should have thrown for ${bad}`);
      } catch (e) {
        expect((e as Error).message).toContain(bad);
      }
    }
  });

  it('refuses a csv list with one dead entry, naming the dead one', () => {
    try {
      loadConfig({ MCP_TRANSPORT: 'http', HUDU_ALLOWED_BASE_HOSTS: 'hudu.example.com, a..b' });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('a..b');
    }
  });

  it('accepts valid hosts and dots between single labels, so the new check does not over-refuse', () => {
    expect(loadConfig({ MCP_TRANSPORT: 'http', HUDU_ALLOWED_BASE_HOSTS: 'a.b' }).HUDU_ALLOWED_BASE_HOSTS).toEqual(['a.b']);
    expect(
      loadConfig({ MCP_TRANSPORT: 'http', HUDU_ALLOWED_BASE_HOSTS: 'hudu.example.com, *.corp.example.com, a-b.c' }).HUDU_ALLOWED_BASE_HOSTS,
    ).toEqual(['hudu.example.com', '*.corp.example.com', 'a-b.c']);
  });

  it('treats a blank HUDU_API_KEY as unset, so a copied .env.example boots under http', () => {
    // `.env.example` ships `HUDU_API_KEY=` (commented); a value left empty must select the http
    // path an absent variable does, not fail boot on a value that is not a credential.
    const c = loadConfig({ MCP_TRANSPORT: 'http', ...ANY, HUDU_API_KEY: '' });
    expect(c.MCP_TRANSPORT).toBe('http');
    expect(c.HUDU_API_KEY).toBeUndefined();
  });

  it('treats a whitespace-only HUDU_API_KEY as unset under stdio, so it still fails for the missing key', () => {
    expect(() => loadConfig({ HUDU_BASE_URL: valid.HUDU_BASE_URL, HUDU_API_KEY: '   ' })).toThrow(/HUDU_API_KEY is required/);
  });

  it('coerces PORT and rejects an out-of-range one', () => {
    expect(loadConfig({ ...valid, PORT: '9000' }).PORT).toBe(9000);
    expect(() => loadConfig({ ...valid, PORT: '70000' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...valid, PORT: 'http' })).toThrow(ConfigError);
  });

  it('never echoes a credential value in an error', () => {
    try {
      loadConfig({ ...valid, HUDU_API_KEY: '', HUDU_BASE_URL: 'nope' });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain('nope');
    }
  });
});

describe('search resource config', () => {
  it('defaults to unset — the SDK searchable set', () => {
    expect(loadConfig(valid).HUDU_SEARCH_RESOURCES).toBeUndefined();
  });

  it('parses a comma-separated list, trimming and dropping empties', () => {
    expect(loadConfig({ ...valid, HUDU_SEARCH_RESOURCES: 'articles, assets ,' }).HUDU_SEARCH_RESOURCES).toEqual(['articles', 'assets']);
  });

  it('normalises duplicates so a repeated name cannot inflate the effective set', () => {
    expect(loadConfig({ ...valid, HUDU_SEARCH_RESOURCES: 'articles, assets, articles' }).HUDU_SEARCH_RESOURCES).toEqual([
      'articles',
      'assets',
    ]);
  });

  it('rejects an empty list, naming the variable', () => {
    for (const raw of ['', ' , ']) {
      expect(() => loadConfig({ ...valid, HUDU_SEARCH_RESOURCES: raw })).toThrow(/HUDU_SEARCH_RESOURCES/);
    }
  });

  it('rejects an unknown resource name at boot, naming the variable and the name', () => {
    try {
      loadConfig({ ...valid, HUDU_SEARCH_RESOURCES: 'articles,asset_password' });
      expect.unreachable('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('HUDU_SEARCH_RESOURCES');
      expect(msg).toContain('asset_password');
    }
  });
});

describe('write policy config', () => {
  it('parses a comma-separated allow list, trimming and dropping empties', () => {
    const c = loadConfig({ ...valid, HUDU_WRITE_POLICY: 'allow_list', HUDU_WRITE_ALLOW: 'articles.update, assets.create ,' });
    expect(c.HUDU_WRITE_ALLOW).toEqual(['articles.update', 'assets.create']);
  });

  it('accepts all as a deliberate opt-in', () => {
    expect(loadConfig({ ...valid, HUDU_WRITE_POLICY: 'all' }).HUDU_WRITE_POLICY).toBe('all');
  });

  it('rejects an empty allow list under allow_list, naming the variable', () => {
    for (const HUDU_WRITE_ALLOW of [undefined, '', ' , ']) {
      expect(() => loadConfig({ ...valid, HUDU_WRITE_POLICY: 'allow_list', ...(HUDU_WRITE_ALLOW === undefined ? {} : { HUDU_WRITE_ALLOW }) })).toThrow(/HUDU_WRITE_ALLOW/);
    }
  });

  it('rejects an unknown operation key at boot, naming the variable and the key', () => {
    try {
      loadConfig({ ...valid, HUDU_WRITE_POLICY: 'allow_list', HUDU_WRITE_ALLOW: 'articles.updat' });
      expect.unreachable('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('HUDU_WRITE_ALLOW');
      expect(msg).toContain('articles.updat');
    }
  });

  it('rejects an inherited prototype property key, which is not a registry operation', () => {
    // `getCapability` is `CAPABILITY_REGISTRY[name]` on a non-null-prototype object, so an
    // inherited name resolves to a function rather than `undefined`. It must fail boot, not slip
    // through as an allow-listed write, and the error must name both the variable and the key.
    try {
      loadConfig({ ...valid, HUDU_WRITE_POLICY: 'allow_list', HUDU_WRITE_ALLOW: 'constructor' });
      expect.unreachable('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('HUDU_WRITE_ALLOW');
      expect(msg).toContain('constructor');
    }
  });

  it('rejects a read operation key, which would grant nothing', () => {
    expect(() => loadConfig({ ...valid, HUDU_WRITE_POLICY: 'allow_list', HUDU_WRITE_ALLOW: 'api_info.get' })).toThrow(/read operation/);
  });

  it('ignores HUDU_WRITE_ALLOW under deny and all', () => {
    // A key that would fail validation under allow_list is inert when the policy does not read it.
    expect(loadConfig({ ...valid, HUDU_WRITE_POLICY: 'deny', HUDU_WRITE_ALLOW: 'not-an-operation' }).HUDU_WRITE_ALLOW).toEqual(['not-an-operation']);
    expect(loadConfig({ ...valid, HUDU_WRITE_POLICY: 'all', HUDU_WRITE_ALLOW: 'not-an-operation' }).HUDU_WRITE_ALLOW).toEqual(['not-an-operation']);
  });
});


it('defaults to read-only and accepts only explicit true/false strings', () => {
  expect(loadConfig(valid).HUDU_READ_ONLY).toBe(true);
  expect(loadConfig({ ...valid, HUDU_READ_ONLY: 'false' }).HUDU_READ_ONLY).toBe(false);
  for (const value of ['', '0', 'FALSE', 'yes']) {
    expect(() => loadConfig({ ...valid, HUDU_READ_ONLY: value })).toThrow(ConfigError);
  }
});

describe('preset knob config (0.12.0 adoption)', () => {
  it('defaults: the recommended cache preset, the cooldown gate on, a 30 s deadline', () => {
    const c = loadConfig(valid);
    expect(c.HUDU_CACHE_PRESET).toBe('recommended');
    expect(c.HUDU_COOLDOWN).toBe('on');
    expect(c.HUDU_TIMEOUT_MS).toBe(30000);
  });

  it('accepts the explicit alternatives, coercing the timeout to a number', () => {
    const c = loadConfig({ ...valid, HUDU_CACHE_PRESET: 'off', HUDU_COOLDOWN: 'off', HUDU_TIMEOUT_MS: '15000' });
    expect(c.HUDU_CACHE_PRESET).toBe('off');
    expect(c.HUDU_COOLDOWN).toBe('off');
    expect(c.HUDU_TIMEOUT_MS).toBe(15000);
  });

  it('rejects an unknown cache preset or cooldown value, naming the variable', () => {
    expect(() => loadConfig({ ...valid, HUDU_CACHE_PRESET: 'never' })).toThrow(/HUDU_CACHE_PRESET/);
    expect(() => loadConfig({ ...valid, HUDU_COOLDOWN: 'maybe' })).toThrow(/HUDU_COOLDOWN/);
  });

  it('refuses to boot on a non-positive or non-integer HUDU_TIMEOUT_MS', () => {
    for (const bad of ['0', '-1', 'abc', '10.5']) {
      expect(() => loadConfig({ ...valid, HUDU_TIMEOUT_MS: bad })).toThrow(ConfigError);
    }
  });
});
