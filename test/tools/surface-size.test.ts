/**
 * surface-size.test.ts — the served-surface size gate (issue #24 F, node-hudu#112; ratcheted for
 * issue #52): UTF-8 bytes of the compact `tools/list` JSON per profile. Budgets are ratcheted to the
 * measured value plus a small margin; lower them when a lever lands, never raise them to go green.
 *
 * The prose itself lives in `src/tools/tool-prose.ts`; this gate is what stops it regrowing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

// Measured after the compact tool prose and field descriptions (issue #52): 26,178 / 21,492.
const BUDGET_ALL = 26_300;
const BUDGET_DENY = 21_700;
/** The whole served surface, either profile, in tokens a client pays before its first call. */
const BUDGET_TOTAL = 23_000;
/** `hudu_search` is the largest tool; its own ceiling keeps it from eating the total. */
const BUDGET_SEARCH = 2_900;

const bytes = async (policy: 'all' | 'deny') => {
  const session = await connect(undefined, { HUDU_WRITE_POLICY: policy });
  const tools = await session.list();
  await session.close();
  return {
    count: tools.length,
    size: Buffer.byteLength(JSON.stringify(tools), 'utf8'),
    tools: tools.map((t: { name: string }) => ({ name: t.name, size: Buffer.byteLength(JSON.stringify(t), 'utf8') })),
  };
};

describe('served tools/list size', () => {
  it('write-enabled profile stays within budget', async () => {
    const { count, size } = await bytes('all');
    expect(count).toBe(19);
    expect(size).toBeLessThanOrEqual(BUDGET_ALL);
  });
  it('read-only profile stays within budget', async () => {
    const { count, size } = await bytes('deny');
    expect(count).toBe(17);
    expect(size).toBeLessThanOrEqual(BUDGET_DENY);
  });
  it('the whole served surface stays under the practice target', async () => {
    const readOnly = await bytes('deny');
    expect(readOnly.size).toBeLessThanOrEqual(BUDGET_TOTAL);
  });
  it('hudu_search alone stays under its ceiling', async () => {
    const { tools } = await bytes('deny');
    const search = tools.find((t) => t.name === 'hudu_search');
    expect(search?.size).toBeLessThanOrEqual(BUDGET_SEARCH);
  });
});
