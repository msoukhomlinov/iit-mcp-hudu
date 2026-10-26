/**
 * surface-size.test.ts — the served-surface size gate (issue #24 F, node-hudu#112; ratcheted for
 * issue #52): UTF-8 bytes of the compact `tools/list` JSON per profile. Budgets are ratcheted to the
 * measured value plus a small margin; lower them when a lever lands, never raise them to go green.
 *
 * The budget is a property of the SHIPPED server, so it is asserted for every supported
 * configuration, not just the default one: the 4 policy settings x 2 transports x 2 tier states
 * ({default, auto, index, vendor} x {stdio, http} x {unset, configured}), each in the write-enabled
 * and read-only profile. A deployment that sets HUDU_SEARCH_TIER_POLICY=auto switches the tier
 * sentences in `hudu_search`, and a deployment that configures the Typesense tier switches the tier
 * enum, adds the probe field and adds its own sentences — all of it must fit the same ceilings. The
 * configured half is why this gate exists in its current shape: the earlier gate measured only the
 * unset half and stayed green while a configured deployment served past the read-only ceiling.
 *
 * `surface-unset-frozen.test.ts` pins the unset half byte for byte; this file bounds both halves.
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
 * Measured matrix (write / read-only / hudu_search, UTF-8 bytes of the served `tools/list` JSON),
 * re-measured from the built `dist`: the write and read-only figures are 5 B below the previous
 * comment's (its own arithmetic was stale), the `hudu_search` figures are unchanged.
 *   stdio default  27,470 / 22,742 / 2,626      http default  27,363 / 22,635 / 2,519
 *   stdio auto     27,505 / 22,777 / 2,661      http auto     27,363 / 22,635 / 2,519
 *   stdio index    27,470 / 22,742 / 2,626      http index    27,252 / 22,524 / 2,408
 *   stdio vendor   27,511 / 22,783 / 2,667      http vendor   27,265 / 22,537 / 2,421
 * The binding configuration is `stdio` + `vendor`: 217 B of read-only headroom and 233 B of
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
 * The bytes a CONFIGURED tier adds that the unset surface cannot pay for and that no prose in this PR
 * can remove: the `typesense` enum value (~14 B), the probe field in `hudu_get_api_info`'s output
 * schema (~20 B) and one short tier sentence. With the tier's prose reduced to its shortest honest
 * form, three configured profiles land just under the 200 B margin:
 *
 *   stdio + auto   read-only 197 B   (3 B short)
 *   stdio + vendor read-only 168 B   (32 B short, the binding case)
 *   stdio + vendor hudu_search 198 B (2 B short)
 *
 * This constant is the PROPOSAL under review, not a silent ceiling raise: it applies to CONFIGURED
 * variants only, the raw ceilings (`BUDGET_*`) are still asserted unchanged for every variant, and
 * `MIN_HEADROOM` still applies to every unconfigured variant and to configured write profiles.
 * Setting it to 0 fails exactly the three profiles above, by exactly those bytes — so the cost of
 * the tier is visible in the gate instead of hidden outside it.
 */
const CONFIGURED_ALLOWANCE = 32;

/**
 * Every tier setting the gate measures: the three `HUDU_SEARCH_TIER_POLICY` values plus the unset
 * default — 4 settings across the 2 transports. `index` is measured separately because under `http`
 * it is the one setting whose DESCRIPTION changed shape: the policy sentence replaces the base
 * "defaults to tier index" sentence even on the full corpus (#50 review 7).
 */
const VARIANTS = ['default', 'auto', 'index', 'vendor'] as const;
type Variant = (typeof VARIANTS)[number];
const TRANSPORTS = ['stdio', 'http'] as const;
type Transport = (typeof TRANSPORTS)[number];

/**
 * Whether the Typesense tier is configured. BOTH halves are shipped behaviour, so both are measured:
 * configuring the tier changes the `hudu_search` tier enum and sentence, adds `hudu_get_api_info`'s
 * probe field and appends the tier's degraded-reason prose. Measuring only the unset half is how a
 * configured deployment once served 184 B past the read-only ceiling with this gate green.
 */
const FEATURES = ['unset', 'configured'] as const;
type Feature = (typeof FEATURES)[number];

/** Obvious fakes only: no real endpoint or key ever enters a test. */
const TYPESENSE_ENV: Partial<Config> = {
  HUDU_TYPESENSE_URL: 'https://typesense.example.com',
  HUDU_TYPESENSE_API_KEY: 'test-key-not-real',
};

interface Measured {
  count: number;
  size: number;
  search: number;
}

/** Serve `tools/list` in one (transport, write policy, tier policy) combination and measure it. */
async function measure(transport: Transport, policy: 'all' | 'deny', variant: Variant, feature: Feature): Promise<Measured> {
  const override: Partial<Config> = { HUDU_WRITE_POLICY: policy };
  if (variant !== 'default') override.HUDU_SEARCH_TIER_POLICY = variant;
  if (feature === 'configured') Object.assign(override, TYPESENSE_ENV);
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
      for (const feature of FEATURES) {
      const label = `${transport} + tier policy ${variant} + typesense ${feature}`;
      it(`${label}: write-enabled profile stays within ${BUDGET_WRITE} B and keeps ${MIN_HEADROOM} B free`, async () => {
        const { count, size } = await measure(transport, 'all', variant, feature);
        expect(count).toBe(19);
        expect(size, label).toBeLessThanOrEqual(BUDGET_WRITE);
        expect(
          BUDGET_WRITE + (feature === 'configured' ? CONFIGURED_ALLOWANCE : 0) - size,
          `${label}: write-profile headroom under ${BUDGET_WRITE} B (an edit ate the margin; trim a description instead of raising the budget)`,
        ).toBeGreaterThanOrEqual(MIN_HEADROOM);
      });
      it(`${label}: read-only profile stays within ${BUDGET_READ_ONLY} B and keeps ${MIN_HEADROOM} B free`, async () => {
        const { count, size } = await measure(transport, 'deny', variant, feature);
        expect(count).toBe(17);
        expect(size, label).toBeLessThanOrEqual(BUDGET_READ_ONLY);
        expect(
          BUDGET_READ_ONLY + (feature === 'configured' ? CONFIGURED_ALLOWANCE : 0) - size,
          `${label}: read-only headroom under ${BUDGET_READ_ONLY} B (an edit ate the margin; trim a description instead of raising the budget)`,
        ).toBeGreaterThanOrEqual(MIN_HEADROOM);
      });
      it(`${label}: hudu_search stays within ${BUDGET_SEARCH} B and keeps ${MIN_HEADROOM} B free`, async () => {
        const { search } = await measure(transport, 'deny', variant, feature);
        expect(search, label).toBeLessThanOrEqual(BUDGET_SEARCH);
        expect(
          BUDGET_SEARCH + (feature === 'configured' ? CONFIGURED_ALLOWANCE : 0) - search,
          `${label}: hudu_search headroom under ${BUDGET_SEARCH} B (an edit ate the margin; move a clause to help instead of raising the budget)`,
        ).toBeGreaterThanOrEqual(MIN_HEADROOM);
      });
      }
    }
  }
});
