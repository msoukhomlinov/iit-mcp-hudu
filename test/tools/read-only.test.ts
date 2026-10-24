/**
 * read-only.test.ts — HUDU_READ_ONLY is a hard override of the write policy: the full matrix
 * (READ_ONLY unset / true / false x policy deny / allow_list / all). `true` registers no write or
 * delete tool and refuses every mutation whatever the policy or allow-list say; unset or `false`
 * leaves HUDU_WRITE_POLICY in charge (default `deny`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { logEffectiveWritePolicy, policyRefusalMessage } from '../../src/policy.js';
import { config } from '../helpers/mcp-session.js';
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

describe('boot logging', () => {
  const lines = (config: Parameters<typeof logEffectiveWritePolicy>[0], env: NodeJS.ProcessEnv) => {
    const out: { level: string; msg: string }[] = [];
    const log = createLogger('debug', (line) => out.push(JSON.parse(line)));
    logEffectiveWritePolicy(config, log, env);
    return out;
  };
  const cfg = (o: object) => loadConfig({ ...base, ...o });

  it('warns that writes are enabled, and that an unset HUDU_READ_ONLY was read-only in 0.2.x', () => {
    const out = lines(cfg({ HUDU_WRITE_POLICY: 'all' }), { HUDU_WRITE_POLICY: 'all' });
    expect(out.map((l) => l.level)).toEqual(['warn', 'warn']);
    expect(JSON.stringify(out)).toContain('0.2.x treated an unset HUDU_READ_ONLY as read-only');
  });
  it('warns once, with no unset-hazard line, when HUDU_READ_ONLY=false is explicit', () => {
    const out = lines(cfg({ HUDU_WRITE_POLICY: 'all', HUDU_READ_ONLY: 'false' }), { HUDU_READ_ONLY: 'false' });
    expect(out.map((l) => l.level)).toEqual(['warn']);
  });
  it('logs info only when the effective policy is deny (default, or READ_ONLY=true over all)', () => {
    expect(lines(cfg({}), {}).map((l) => l.level)).toEqual(['info']);
    expect(lines(cfg({ HUDU_WRITE_POLICY: 'all', HUDU_READ_ONLY: 'true' }), { HUDU_READ_ONLY: 'true' }).map((l) => l.level)).toEqual(['info']);
  });
});

describe('refusal reason names the override', () => {
  it('catalog, describe and dispatch say HUDU_READ_ONLY=true, not HUDU_WRITE_POLICY=deny', async () => {
    const session = await connect(undefined, { HUDU_READ_ONLY: true, HUDU_WRITE_POLICY: 'all' });
    const described = await session.call('hudu_describe_operation', { operation: 'companies.delete' });
    expect(described.structuredContent.why_not).toContain('HUDU_READ_ONLY=true');
    const page = await session.call('hudu_list_operations', { effect: 'destructive', limit: 100 });
    expect(page.structuredContent.rows.find((r: { op: string }) => r.op === 'companies.delete').reason).toContain('HUDU_READ_ONLY=true');
    expect(policyRefusalMessage('companies.delete', 'destructive', { ...config, HUDU_READ_ONLY: true, HUDU_WRITE_POLICY: 'deny' })).toContain('HUDU_READ_ONLY=true');
    await session.close();
  });
  it('without the override the reason still names the policy', async () => {
    const session = await connect(undefined, { HUDU_WRITE_POLICY: 'deny' });
    const described = await session.call('hudu_describe_operation', { operation: 'companies.delete' });
    expect(described.structuredContent.why_not).toContain('HUDU_WRITE_POLICY=deny');
    await session.close();
  });
});
