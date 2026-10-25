/**
 * surface-size.test.ts — the served-surface size gate (issue #24 F, node-hudu#112; ratcheted for
 * issue #52): UTF-8 bytes of the compact `tools/list` JSON per profile. Budgets are ratcheted to the
 * measured value plus a small margin; lower them when a lever lands, never raise them to go green.
 * Each profile has its own total: the write-enabled profile serves 19 tools, the read-only one 17.
 *
 * The prose itself lives in `src/tools/tool-prose.ts`; this gate is what stops it regrowing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

// Measured after the compact tool prose and field descriptions, plus the restored prose facts: 26,713 / 22,027.
/** Per-profile totals: the write-enabled profile carries two more tools, so it gets its own ceiling. */
const BUDGET_WRITE = 27_500;
const BUDGET_READ_ONLY = 23_000;
/** `hudu_search` is the largest tool; its own ceiling keeps it from eating either total. */
const BUDGET_SEARCH = 3_100;

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
  it('write-enabled profile stays within its total', async () => {
    const { count, size } = await bytes('all');
    expect(count).toBe(19);
    expect(size).toBeLessThanOrEqual(BUDGET_WRITE);
  });
  it('read-only profile stays within its total', async () => {
    const { count, size } = await bytes('deny');
    expect(count).toBe(17);
    expect(size).toBeLessThanOrEqual(BUDGET_READ_ONLY);
  });
  it('hudu_search alone stays under its ceiling', async () => {
    const { tools } = await bytes('deny');
    const search = tools.find((t) => t.name === 'hudu_search');
    expect(search?.size).toBeLessThanOrEqual(BUDGET_SEARCH);
  });
});
