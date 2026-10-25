/**
 * surface-size.test.ts — the served-surface size gate (issue #24 F, node-hudu#112; ratcheted for
 * issue #52): UTF-8 bytes of the compact `tools/list` JSON per profile. Budgets are ratcheted to the
 * measured value plus a small margin; lower them when a lever lands, never raise them to go green.
 *
 * The budget is a property of the SHIPPED server, so it is asserted for every supported
 * configuration, not just the default one: {default, auto, index, vendor} x {stdio, http}. A deployment
 * that sets HUDU_SEARCH_TIER_POLICY=auto switches the tier sentences in `hudu_search`, and that
 * prose must fit the same ceiling as the default.
 *
 * The prose itself lives in `src/tools/tool-prose.ts`; this gate is what stops it regrowing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config.js';
import { API_KEY, connect, connectForRequest } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

/**
 * Per-profile totals, both from issue #52's amended acceptance: the write-enabled profile serves two
 * more tools than the read-only one, so it gets its own (larger) ceiling.
 *
 * Measured matrix (write / read-only / hudu_search, UTF-8 bytes of the served `tools/list` JSON):
 *   stdio default  27,475 / 22,747 / 2,626      http default  27,368 / 22,640 / 2,519
 *   stdio auto     27,510 / 22,782 / 2,661      http auto     27,368 / 22,640 / 2,519
 *   stdio index    27,475 / 22,747 / 2,626      http index    27,257 / 22,529 / 2,408
 *   stdio vendor   27,516 / 22,788 / 2,667      http vendor   27,270 / 22,542 / 2,421
 * The binding configuration is `stdio` + `vendor`: 212 B of read-only headroom and 233 B of
 * `hudu_search` headroom (`MIN_HEADROOM` below). `stdio` sizes carry the strict object's
 * `additionalProperties: false`; `http` carries the loose `{}` that lets an override be reported.
 * (`http` default and `auto` coincide: `auto` is already that transport's tier.)
 */
const BUDGET_WRITE = 28_000;
const BUDGET_READ_ONLY = 23_000;
/** `hudu_search` is the largest single tool and must fit under every tier-policy setting. */
const BUDGET_SEARCH = 2_900;

/**
 * Free space every binding configuration must keep.
 *
 * A ceiling asserted at the measured value is a one-byte ratchet: the next word added to any prose
 * fails the gate with a bare `expected 23001 to be <= 23000`, which reads like an arbitrary line
 * rather than "this edit consumed the margin". The margin is asserted explicitly so an edit that
 * eats it fails with that message instead (#50 review 6).
 */
const MIN_HEADROOM = 200;

/**
 * Every tier-policy setting the server accepts. `index` is measured separately because under `http`
 * it is the one setting whose DESCRIPTION changed shape: the policy sentence replaces the base
 * "defaults to tier index" sentence even on the full corpus (#50 review 7).
 */
const VARIANTS = ['default', 'auto', 'index', 'vendor'] as const;
type Variant = (typeof VARIANTS)[number];
const TRANSPORTS = ['stdio', 'http'] as const;
type Transport = (typeof TRANSPORTS)[number];

interface Measured {
  count: number;
  size: number;
  search: number;
}

/** Serve `tools/list` in one (transport, write policy, tier policy) combination and measure it. */
async function measure(transport: Transport, policy: 'all' | 'deny', variant: Variant): Promise<Measured> {
  const override: Partial<Config> = { HUDU_WRITE_POLICY: policy };
  if (variant !== 'default') override.HUDU_SEARCH_TIER_POLICY = variant;
  const session =
    transport === 'stdio'
      ? await connect(undefined, override)
      : // Listing needs no Hudu call; a fetch here would be a bug, so the stub refuses.
        await connectForRequest(API_KEY, () => {
          throw new Error('unexpected network call');
        }, [], override);
  const tools = await session.list();
  await session.close();
  const search = tools.find((t: { name: string }) => t.name === 'hudu_search');
  const measured = {
    count: tools.length,
    size: Buffer.byteLength(JSON.stringify(tools), 'utf8'),
    search: Buffer.byteLength(JSON.stringify(search), 'utf8'),
  };
  return measured;
}

describe('served tools/list size', () => {
  for (const transport of TRANSPORTS) {
    for (const variant of VARIANTS) {
      const label = `${transport} + tier policy ${variant}`;
      it(`${label}: write-enabled profile stays within ${BUDGET_WRITE} B and keeps ${MIN_HEADROOM} B free`, async () => {
        const { count, size } = await measure(transport, 'all', variant);
        expect(count).toBe(19);
        expect(size, label).toBeLessThanOrEqual(BUDGET_WRITE);
        expect(
          BUDGET_WRITE - size,
          `${label}: write-profile headroom under ${BUDGET_WRITE} B (an edit ate the margin; trim a description instead of raising the budget)`,
        ).toBeGreaterThanOrEqual(MIN_HEADROOM);
      });
      it(`${label}: read-only profile stays within ${BUDGET_READ_ONLY} B and keeps ${MIN_HEADROOM} B free`, async () => {
        const { count, size } = await measure(transport, 'deny', variant);
        expect(count).toBe(17);
        expect(size, label).toBeLessThanOrEqual(BUDGET_READ_ONLY);
        expect(
          BUDGET_READ_ONLY - size,
          `${label}: read-only headroom under ${BUDGET_READ_ONLY} B (an edit ate the margin; trim a description instead of raising the budget)`,
        ).toBeGreaterThanOrEqual(MIN_HEADROOM);
      });
      it(`${label}: hudu_search stays within ${BUDGET_SEARCH} B and keeps ${MIN_HEADROOM} B free`, async () => {
        const { search } = await measure(transport, 'deny', variant);
        expect(search, label).toBeLessThanOrEqual(BUDGET_SEARCH);
        expect(
          BUDGET_SEARCH - search,
          `${label}: hudu_search headroom under ${BUDGET_SEARCH} B (an edit ate the margin; move a clause to help instead of raising the budget)`,
        ).toBeGreaterThanOrEqual(MIN_HEADROOM);
      });
    }
  }
});
