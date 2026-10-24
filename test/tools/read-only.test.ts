/**
 * read-only.test.ts — HUDU_READ_ONLY is a hard override of the write policy: the full matrix
 * (READ_ONLY unset / true / false x policy deny / allow_list / all). `true` registers no write or
 * delete tool and refuses every mutation whatever the policy or allow-list say; unset or `false`
 * leaves HUDU_WRITE_POLICY in charge (default `deny`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { connect } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

const base = { HUDU_API_KEY: 'k'.repeat(20), HUDU_BASE_URL: 'https://hudu.invalid' };

describe('HUDU_READ_ONLY parsing', () => {
  it('is false when unset, and reads true / false', () => {
    expect(loadConfig({ ...base }).HUDU_READ_ONLY).toBe(false);
    expect(loadConfig({ ...base, HUDU_READ_ONLY: 'false' }).HUDU_READ_ONLY).toBe(false);
    expect(loadConfig({ ...base, HUDU_READ_ONLY: 'true' }).HUDU_READ_ONLY).toBe(true);
    expect(() => loadConfig({ ...base, HUDU_READ_ONLY: 'maybe' })).toThrow(/HUDU_READ_ONLY/);
  });
  it('leaves the default policy at deny', () => {
    expect(loadConfig({ ...base }).HUDU_WRITE_POLICY).toBe('deny');
  });
});

const policies = ['deny', 'allow_list', 'all'] as const;
const readOnly = [undefined, true, false] as const;

describe('HUDU_READ_ONLY x HUDU_WRITE_POLICY matrix', () => {
  for (const ro of readOnly) {
    for (const policy of policies) {
      const writesExpected = ro !== true && policy !== 'deny';
      it(`READ_ONLY=${String(ro)} policy=${policy}: write/delete tools ${writesExpected ? 'registered' : 'absent'}`, async () => {
        const session = await connect(() => Response.json({ company: { id: 1, name: 'x' } }), {
          HUDU_WRITE_POLICY: policy,
          HUDU_WRITE_ALLOW: policy === 'allow_list' ? ['companies.update'] : [],
          ...(ro === undefined ? {} : { HUDU_READ_ONLY: ro }),
        });
        const names = (await session.list()).map((t) => t.name);
        expect(names.includes('hudu_write')).toBe(writesExpected);
        expect(names.includes('hudu_delete')).toBe(writesExpected);
        if (!writesExpected) {
          expect(names).not.toContain('hudu_write');
          expect(names).not.toContain('hudu_delete');
          // The reads stay reachable, and a mutation through hudu_read is refused before any request.
          const refused = await session.call('hudu_read', { operation: 'companies.update', input: { id: 1, data: { name: 'x' } } });
          expect(refused.isError).toBe(true);
          expect(session.methods.every((m) => m === 'GET')).toBe(true);
        }
        await session.close();
      });
    }
  }

  it('READ_ONLY=true beats an allow-list that names the operation', async () => {
    const session = await connect(undefined, { HUDU_READ_ONLY: true, HUDU_WRITE_POLICY: 'allow_list', HUDU_WRITE_ALLOW: ['companies.update'] });
    const result = await session.call('hudu_read', { operation: 'companies.update', input: { id: 1, data: { name: 'x' } } });
    expect(result.isError).toBe(true);
    expect(session.urls).toEqual([]);
    await session.close();
  });
});
