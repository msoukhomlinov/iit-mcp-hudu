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
 * The bytes a CONFIGURED tier adds that the unset surface can neither pay for nor remove, and
 * NOTHING else:
 *
 * The binding number is MEASURED, not summed: 200 B margin - 168 B measured headroom = 32 B. The
 * bytes are the `typesense` value in `hudu_search`'s tier enum (measured 12 B), the `typesense`
 * probe field in `hudu_get_api_info`'s output schema (measured 15 B), and the ~5 B of tier sentence
 * that remains even in its shortest honest form — 12 + 15 + 5 = 32 B, matching 200 - 168.
 *
 * Measured with that minimal prose, three configured profiles fall short of the 200 B margin:
 *
 *   stdio + auto   read-only     197 B  (3 B short)
 *   stdio + vendor read-only     168 B  (32 B short - the binding case)
 *   stdio + vendor hudu_search   198 B  (2 B short)
 *
 * This constant absorbs ONLY the configured-surface additions. It is NOT headroom for future prose:
 * a new sentence still has to fit the margin the other configured profiles keep. It buys MARGIN,
 * never CEILING — every configured profile is asserted against the raw 28,000 / 23,000 / 2,900 B
 * before the margin is considered — and it applies to configured variants only, so every unset
 * profile keeps the strict 200 B (asserted separately below, allowance-free).
 *
 * Setting it to 0 fails exactly those three profiles, by exactly those bytes; the tests below
 * re-derive both facts on every run, so a fourth shortfall (a regression elsewhere) fails instead of
 * being absorbed by a bigger constant.
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

/**
 * Strict headroom (allowance = 0) for every profile the gate asserts on, keyed
 * `"<transport> <variant> <feature> <metric>"`. The allowance is only ever allowed to cover a
 * MEASURED shortfall, so the tests below read this map rather than trusting the constant.
 */
async function strictHeadrooms(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const transport of TRANSPORTS) {
    for (const variant of VARIANTS) {
      for (const feature of FEATURES) {
        const key = `${transport} ${variant} ${feature}`;
        out[`${key} write`] = BUDGET_WRITE - (await measure(transport, 'all', variant, feature)).size;
        const readOnly = await measure(transport, 'deny', variant, feature);
        out[`${key} read-only`] = BUDGET_READ_ONLY - readOnly.size;
        out[`${key} hudu_search`] = BUDGET_SEARCH - readOnly.search;
      }
    }
  }
  return out;
}

describe('CONFIGURED_ALLOWANCE is a measurement, not a budget raid', () => {
  it('covers exactly the three configured profiles that fall short, by exactly their shortfall', async () => {
    const heads = await strictHeadrooms();
    const short = Object.entries(heads).filter(([, headroom]) => headroom < MIN_HEADROOM);
    // Named, not counted: a fourth shortfall means a regression elsewhere, and the allowance must
    // not be widened to swallow it. The numbers are re-derived on every run.
    expect(Object.fromEntries(short.sort(([a], [b]) => a.localeCompare(b)))).toEqual({
      'stdio auto configured read-only': 197,
      'stdio vendor configured hudu_search': 198,
      'stdio vendor configured read-only': 168,
    });
    // The constant IS the largest measured shortfall — never more, so it cannot grow quietly.
    expect(MIN_HEADROOM - Math.min(...short.map(([, headroom]) => headroom))).toBe(CONFIGURED_ALLOWANCE);
  });

  it('grants nothing to an unset profile: every one keeps the full margin with allowance 0', async () => {
    const heads = await strictHeadrooms();
    const unset = Object.entries(heads).filter(([key]) => key.includes(' unset '));
    expect(unset).toHaveLength(TRANSPORTS.length * VARIANTS.length * 3);
    for (const [key, headroom] of unset) expect(headroom, key).toBeGreaterThanOrEqual(MIN_HEADROOM);
  });
});
