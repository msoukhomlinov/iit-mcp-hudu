/**
 * search-policy.test.ts — the pure failure/metadata sanitizers. Pairs with
 * `src/tools/search-policy.ts`.
 */
import { describe, expect, it } from 'vitest';
import { credentialRefused, sanitizeIndexMeta, sanitizeSearchFailures } from '../../src/tools/search-policy.js';

const hudu401 = (resource: string) => ({ resource, code: 'UNAUTHORIZED', message: 'Bad credentials' });

describe('search failure sanitization', () => {
  it('collapses an auth failure so the credential scope never reaches the model', () => {
    const out = sanitizeSearchFailures([
      { resource: 'asset_passwords', code: 'UNAUTHORIZED', message: 'Bad credentials' },
      { resource: 'articles', code: 'SERVER_ERROR', message: 'upstream exploded' },
    ]);
    expect(out[0]).toEqual({
      resource: 'asset_passwords',
      code: 'UNAVAILABLE',
      message: 'Resource unavailable to this deployment; it returned no results.',
    });
    expect(out[1]).toEqual({ resource: 'articles', code: 'SERVER_ERROR', message: 'Resource read failed; it returned no results.' });
    // The whole point: neither the upstream auth code nor its message survives.
    expect(JSON.stringify(out)).not.toContain('Bad credentials');
    expect(JSON.stringify(out)).not.toContain('UNAUTHORIZED');
  });

  it('treats a missing failure list as no failures', () => {
    expect(sanitizeSearchFailures(undefined)).toEqual([]);
  });

  it('collapses a background index-build auth error, leaving the rest of the index block alone', () => {
    const out = sanitizeIndexMeta({ state: 'warm', docs: { articles: 3 }, lastBuildError: { code: 'UNAUTHORIZED', message: 'Bad credentials' } });
    expect(out.lastBuildError).toEqual({
      code: 'UNAVAILABLE',
      message: 'Resource unavailable to this deployment; it returned no results.',
    });
    expect(out.state).toBe('warm');
    expect(out.docs).toEqual({ articles: 3 });
    expect(JSON.stringify(out)).not.toContain('Bad credentials');
    expect(JSON.stringify(out)).not.toContain('UNAUTHORIZED');
  });

  it('leaves a null build error and a non-object index untouched', () => {
    expect(sanitizeIndexMeta({ state: 'cold', lastBuildError: null })).toEqual({ state: 'cold', lastBuildError: null });
    expect(sanitizeIndexMeta(null)).toBeNull();
  });
});

describe('credential refusal detection', () => {
  it('flags a key Hudu refused on every scope resource', () => {
    const meta = {
      resources: ['articles', 'assets'],
      failed: [
        hudu401('articles'),
        hudu401('assets'),
        // The auto tier records the background build failure in the same list; it is the same refusal.
        { resource: 'index', code: 'UNAUTHORIZED', message: 'background index build failed: Bad credentials' },
      ],
    };
    expect(credentialRefused(meta, [])).toBe(true);
  });

  it('falls back to `errors` when `failed` is absent', () => {
    const meta = { resources: ['articles'], errors: [hudu401('articles')] };
    expect(credentialRefused(meta, [])).toBe(true);
  });

  it('does not flag a key that lacks one resource while another answered', () => {
    const meta = { resources: ['articles', 'assets'], failed: [hudu401('assets')] };
    expect(credentialRefused(meta, [])).toBe(false);
  });

  it('does not flag a mixed refusal plus backend failure', () => {
    const meta = {
      resources: ['articles', 'assets'],
      failed: [hudu401('articles'), { resource: 'assets', code: 'SERVER_ERROR', message: 'upstream exploded' }],
    };
    expect(credentialRefused(meta, [])).toBe(false);
  });

  it('never flags a call that answered with hits', () => {
    const meta = { resources: ['articles'], failed: [{ resource: 'articles', code: 'FORBIDDEN', message: 'Bad credentials' }] };
    expect(credentialRefused(meta, [{ id: 1 }])).toBe(false);
  });

  it('treats a failure-less search as no refusal', () => {
    expect(credentialRefused({ resources: ['articles'], failed: [] }, [])).toBe(false);
  });

  it('does not count the index build entry as a scope-resource refusal', () => {
    const meta = { resources: ['articles'], failed: [{ resource: 'index', code: 'UNAUTHORIZED', message: 'background index build failed' }] };
    expect(credentialRefused(meta, [])).toBe(false);
  });

  it('is not fooled by the keyless AUTH_ERROR (no upstream refusal occurred)', () => {
    const meta = {
      resources: ['articles', 'assets'],
      failed: [
        { resource: 'articles', code: 'AUTH_ERROR', message: 'no server credential' },
        { resource: 'assets', code: 'AUTH_ERROR', message: 'no server credential' },
      ],
    };
    expect(credentialRefused(meta, [])).toBe(false);
  });

  it('tolerates an untyped meta from the invoke path', () => {
    const meta = { resources: ['articles', 'assets'], failed: [hudu401('articles'), hudu401('assets')] } as Record<string, unknown>;
    expect(credentialRefused(meta, [])).toBe(true);
  });
});
