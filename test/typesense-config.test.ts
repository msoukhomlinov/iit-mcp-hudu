/**
 * typesense-config.test.ts — the HUDU_TYPESENSE_* surface (issue #56, DESIGN §4 WP-7).
 *
 * The tier is opt-in: these tests pin the two rules that make opting in safe — a half-configured
 * pair fails boot, and an unconfigured deployment is byte-identical to the pre-Typesense server.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { HuduClient } from 'node-hudu';
import { ConfigError, TYPESENSE_DEFAULTS, TYPESENSE_ENV_NAMES, describeTypesense, loadConfig, typesenseSearchBlock } from '../src/config.js';

const valid = {
  HUDU_BASE_URL: 'https://hudu.example.com',
  HUDU_API_KEY: 'k-123',
};

/** Obvious fakes only: no real key ever enters a test, a fixture or a log. */
const TS = {
  HUDU_TYPESENSE_URL: 'https://typesense.example.com',
  HUDU_TYPESENSE_API_KEY: 'test-key-not-real',
};

function bootError(env: Record<string, string>): string {
  try {
    loadConfig({ ...valid, ...env });
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error('expected loadConfig to throw');
}

describe('HUDU_TYPESENSE_* — the off path', () => {
  it('is unconfigured when the pair is unset: no SDK block, and NO boot line at all', () => {
    const config = loadConfig(valid);
    expect(typesenseSearchBlock(config)).toBeUndefined();
    // A disabled feature is invisible: emitting "typesense: disabled" on every stock boot would
    // change the output of deployments that never heard of this feature.
    expect(describeTypesense(config)).toBeUndefined();
  });

  it('treats blank values as unset, so a copied .env.example keeps the tier off', () => {
    const config = loadConfig({ ...valid, HUDU_TYPESENSE_URL: '', HUDU_TYPESENSE_API_KEY: '   ' });
    expect(typesenseSearchBlock(config)).toBeUndefined();
    expect(describeTypesense(config)).toBeUndefined();
  });

  it('accepts the collection, deadline and gate knobs without the pair, and still stays off', () => {
    const config = loadConfig({
      ...valid,
      HUDU_TYPESENSE_ARTICLES_COLLECTION: 'kb_articles',
      HUDU_TYPESENSE_ASSETS_COLLECTION: 'kb_assets',
      HUDU_TYPESENSE_TIMEOUT_MS: '2000',
      HUDU_TYPESENSE_VERIFY_HITS: 'false',
    });
    expect(typesenseSearchBlock(config)).toBeUndefined();
  });
});

describe('HUDU_TYPESENSE_* — the pair is all-or-nothing', () => {
  it('refuses a URL without a key, naming both variables', () => {
    const message = bootError({ HUDU_TYPESENSE_URL: TS.HUDU_TYPESENSE_URL });
    expect(message).toContain('HUDU_TYPESENSE_URL');
    expect(message).toContain('HUDU_TYPESENSE_API_KEY');
    expect(message).toContain('together or not at all');
  });

  it('refuses a key without a URL, naming both variables', () => {
    const message = bootError({ HUDU_TYPESENSE_API_KEY: TS.HUDU_TYPESENSE_API_KEY });
    expect(message).toContain('HUDU_TYPESENSE_URL');
    expect(message).toContain('HUDU_TYPESENSE_API_KEY');
  });

  it('never echoes the key in the refusal', () => {
    const message = bootError({ HUDU_TYPESENSE_API_KEY: TS.HUDU_TYPESENSE_API_KEY });
    expect(message).not.toContain(TS.HUDU_TYPESENSE_API_KEY);
  });
});

describe('HUDU_TYPESENSE_* — the on path', () => {
  it('maps the pair and applies the documented defaults', () => {
    const block = typesenseSearchBlock(loadConfig({ ...valid, ...TS }));
    // `toEqual` is exact in both directions, so an extra key here — `candidateLimit` or
    // `cooldownMs`, which this server does not pin — would fail this test.
    expect(block).toEqual({
      url: TS.HUDU_TYPESENSE_URL,
      apiKey: TS.HUDU_TYPESENSE_API_KEY,
      collections: { articles: TYPESENSE_DEFAULTS.articlesCollection, assets: TYPESENSE_DEFAULTS.assetsCollection },
      timeoutMs: TYPESENSE_DEFAULTS.timeoutMs,
      verifyHits: true,
    });
  });

  it('leaves the candidate count and the cooldown to the SDK, which resolves them today', () => {
    const block = typesenseSearchBlock(loadConfig({ ...valid, ...TS }));
    if (block === undefined) throw new Error('the pair is configured, so the block must exist');
    expect(Object.keys(block)).not.toContain('candidateLimit');
    expect(Object.keys(block)).not.toContain('cooldownMs');
    // Omission alone would be intent without evidence, so read what the library RESOLVES (not the
    // env, not our block): if a node-hudu release recalibrates either knob, this fails and the
    // change is reviewed, instead of a pinned copy silently overriding it.
    const resolved = new HuduClient({ baseUrl: valid.HUDU_BASE_URL, apiKey: valid.HUDU_API_KEY, search: { typesense: block } })
      .config.search?.typesense;
    expect(resolved?.candidateLimit).toBe(40);
    expect(resolved?.cooldownMs).toBe(30_000);
  });

  it('honours the collection names, the deadline and the verification gate', () => {
    const block = typesenseSearchBlock(
      loadConfig({
        ...valid,
        ...TS,
        HUDU_TYPESENSE_ARTICLES_COLLECTION: 'kb_articles',
        HUDU_TYPESENSE_ASSETS_COLLECTION: 'kb_assets',
        HUDU_TYPESENSE_TIMEOUT_MS: '2000',
        HUDU_TYPESENSE_VERIFY_HITS: 'false',
      }),
    );
    expect(block?.collections).toEqual({ articles: 'kb_articles', assets: 'kb_assets' });
    expect(block?.timeoutMs).toBe(2000);
    expect(block?.verifyHits).toBe(false);
  });

  it('reports the collections on the boot line and nothing else', () => {
    const line = describeTypesense(loadConfig({ ...valid, ...TS }));
    expect(line).toBe('typesense: enabled (collections articles, assets)');
    expect(line).not.toContain(TS.HUDU_TYPESENSE_API_KEY);
    expect(line).not.toContain('typesense.example.com');
  });

  it('accepts HUDU_TYPESENSE_VERIFY_HITS spelled in any case and treats a blank as unset', () => {
    // A shell that exports TRUE, and a copied .env.example that leaves the value empty, must both
    // behave like the knob's documented default rather than fail boot.
    expect(typesenseSearchBlock(loadConfig({ ...valid, ...TS, HUDU_TYPESENSE_VERIFY_HITS: 'TRUE' }))?.verifyHits).toBe(true);
    expect(typesenseSearchBlock(loadConfig({ ...valid, ...TS, HUDU_TYPESENSE_VERIFY_HITS: 'False' }))?.verifyHits).toBe(false);
    expect(typesenseSearchBlock(loadConfig({ ...valid, ...TS, HUDU_TYPESENSE_VERIFY_HITS: '   ' }))?.verifyHits).toBe(true);
    expect(typesenseSearchBlock(loadConfig({ ...valid, ...TS, HUDU_TYPESENSE_VERIFY_HITS: '' }))?.verifyHits).toBe(true);
  });

  it('refuses a URL carrying userinfo, and never echoes the credential in the refusal', () => {
    const secret = 'super-secret-userinfo-password';
    const message = bootError({ ...TS, HUDU_TYPESENSE_URL: `https://operator:${secret}@typesense.example.com` });
    expect(message).toContain('must not carry credentials');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('operator:');
    expect(message).toContain('HUDU_TYPESENSE_API_KEY');
  });

  it('accepts a loopback origin, which is how stdio reaches the index through a tunnel', () => {
    const block = typesenseSearchBlock(loadConfig({ ...valid, ...TS, HUDU_TYPESENSE_URL: 'http://127.0.0.1:8108' }));
    expect(block?.url).toBe('http://127.0.0.1:8108');
  });

  it('refuses a URL that carries a path, a query or a fragment', () => {
    for (const url of ['https://typesense.example.com/collections', 'https://typesense.example.com?x=1', 'https://typesense.example.com#x']) {
      expect(bootError({ ...TS, HUDU_TYPESENSE_URL: url })).toContain('origin only');
    }
  });

  it('refuses a scheme that is not http or https', () => {
    expect(bootError({ ...TS, HUDU_TYPESENSE_URL: 'ftp://typesense.example.com' })).toContain('http:// or https://');
  });

  it('refuses a deadline above the documented maximum, naming the variable', () => {
    const message = bootError({ ...TS, HUDU_TYPESENSE_TIMEOUT_MS: String(TYPESENSE_DEFAULTS.maxTimeoutMs + 1) });
    expect(message).toContain('HUDU_TYPESENSE_TIMEOUT_MS');
    expect(message).toContain(String(TYPESENSE_DEFAULTS.maxTimeoutMs));
  });

  it('refuses a deadline that is not a positive whole number', () => {
    for (const raw of ['0', '-1', '1.5', 'soon']) {
      expect(bootError({ ...TS, HUDU_TYPESENSE_TIMEOUT_MS: raw })).toContain('HUDU_TYPESENSE_TIMEOUT_MS');
    }
  });

  it('refuses one collection for both resources, naming the setting to change', () => {
    const message = bootError({ ...TS, HUDU_TYPESENSE_ARTICLES_COLLECTION: 'documents', HUDU_TYPESENSE_ASSETS_COLLECTION: 'documents' });
    expect(message).toContain('different collections');
    expect(message).toContain('HUDU_TYPESENSE_ASSETS_COLLECTION');
  });
});

describe('HUDU_SEARCH_TIER_POLICY=typesense', () => {
  it('fails boot without the endpoint and key, naming the policy and both variables', () => {
    const message = bootError({ HUDU_SEARCH_TIER_POLICY: 'typesense' });
    expect(message).toContain('HUDU_SEARCH_TIER_POLICY');
    expect(message).toContain('HUDU_TYPESENSE_URL');
    expect(message).toContain('HUDU_TYPESENSE_API_KEY');
  });

  it('is accepted when the pair is configured', () => {
    expect(loadConfig({ ...valid, ...TS, HUDU_SEARCH_TIER_POLICY: 'typesense' }).HUDU_SEARCH_TIER_POLICY).toBe('typesense');
  });
});

describe('HUDU_TYPESENSE_* — documentation drift', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const example = readFileSync(`${root}.env.example`, 'utf8');
  const readme = readFileSync(`${root}README.md`, 'utf8');
  // Derived from the SCHEMA, not retyped here: a knob added to code and left out of the docs fails
  // this test. A hand-written list would let the test assert its own copy and stay green.
  const names = TYPESENSE_ENV_NAMES;

  it('the schema carries the six documented knobs', () => {
    expect([...names].sort()).toEqual([
      'HUDU_TYPESENSE_API_KEY',
      'HUDU_TYPESENSE_ARTICLES_COLLECTION',
      'HUDU_TYPESENSE_ASSETS_COLLECTION',
      'HUDU_TYPESENSE_TIMEOUT_MS',
      'HUDU_TYPESENSE_URL',
      'HUDU_TYPESENSE_VERIFY_HITS',
    ]);
  });

  it('documents every variable the schema accepts, in .env.example and in the README', () => {
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(example, `.env.example is missing ${name}`).toContain(name);
      expect(readme, `README.md is missing ${name}`).toContain(name);
    }
  });
});
