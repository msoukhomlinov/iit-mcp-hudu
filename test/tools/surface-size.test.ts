/**
 * surface-size.test.ts — the served-surface size gate (issue #24 F, node-hudu#112): UTF-8 bytes of
 * the compact `tools/list` JSON per profile. Budgets are ratcheted to the measured value plus
 * ~0.5%; lower them when a lever lands, never raise them to go green.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

// Measured after the hudu_list `expand` argument and compact-row sentence (issue #22): 39,633 / 34,088 (both under the 40,000 B target).
const BUDGET_ALL = 39_850;
const BUDGET_DENY = 34_270;

const bytes = async (policy: 'all' | 'deny') => {
  const session = await connect(undefined, { HUDU_WRITE_POLICY: policy });
  const tools = await session.list();
  await session.close();
  return { count: tools.length, size: Buffer.byteLength(JSON.stringify(tools), 'utf8') };
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
});
