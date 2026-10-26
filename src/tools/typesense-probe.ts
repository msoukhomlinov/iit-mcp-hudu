/**
 * typesense-probe.ts — the one live Typesense question `hudu_get_api_info` answers.
 *
 * A zero-wire `doctor` cannot report reachability (that is its whole contract), so the live probe
 * lives on a tool that is already a wire call. The request itself belongs to the SDK: one
 * `q=*&per_page=0` search against the articles collection that a search-only key may run, and never
 * a `GET /collections` (a search-only key cannot, and the collection names are configuration here).
 *
 * TODO(drop when node-hudu@0.21.0 lands): 0.20.0 has no probe at all, so `probeBodySearch` is
 * reached through the structural host below and one boundary cast. The agreed 0.21.0 contract
 * (node-hudu#124) is `operations.probeBodySearch(): Promise<KnowledgeSearchBackendProbe>` returning
 * `{ configured, collections, reachable, probeMs, error?: { code, message } }`, exported from the
 * package root, never throwing. When the SDK lands, this module is a thin normaliser and the cast and
 * the feature-detect are deleted together.
 */
import type { HuduClient } from 'node-hudu';
import { typesenseSearchBlock, type Config } from '../config.js';

/** What `hudu_get_api_info` publishes. Always absent from the answer when the tier is unconfigured. */
export interface TypesenseProbeReport {
  configured: boolean;
  reachable: boolean;
  collections: string[];
  probeMs: number;
  /** Why the endpoint did not answer, when the SDK reported a code. Never carries the key. */
  error?: { code: string; message: string };
}

/** The SDK's agreed 0.21.0 probe result (node-hudu#124). */
interface SdkBodyProbeReport {
  configured: boolean;
  collections: string[];
  reachable: boolean;
  probeMs: number;
  error?: { code: string; message: string };
}

/** The 0.21.0 surface this call site assumes: a method on `operations`. */
interface BodyProbeHost {
  operations?: { probeBodySearch?: () => Promise<SdkBodyProbeReport> };
}

const NOT_PROBED: Omit<TypesenseProbeReport, 'collections'> = {
  configured: true,
  reachable: false,
  probeMs: 0,
};

/**
 * Ask the SDK whether the configured Typesense endpoint answers.
 *
 * - unconfigured: `{ configured: false, reachable: false }` and no request at all — the caller
 *   omits the field entirely, so this shape is for direct callers and tests.
 * - 0.20.0 (no `probeBodySearch`): `reachable: false`, nothing dialed. An absent method is a
 *   documented gap in the installed SDK, not an error, so the branch is feature-detected rather
 *   than allowed to throw a TypeError. Claiming reachable without evidence would be a lie a caller
 *   could act on.
 * - configured and present: the SDK's answer, mapped; a throw or a rejection becomes
 *   `reachable: false` with whatever code came back.
 */
export async function probeTypesense(hudu: HuduClient, config: Config): Promise<TypesenseProbeReport> {
  const block = typesenseSearchBlock(config);
  if (block === undefined) return { configured: false, reachable: false, collections: [], probeMs: 0 };
  const collections = [block.collections.articles, block.collections.assets];
  const started = Date.now();
  const host = hudu as unknown as BodyProbeHost;
  const operations = host.operations;
  // `typeof` alone is NOT evidence: 0.20.0's policy proxy fabricates a callable for any name and
  // throws POLICY_DENIED when it is called, so an unknown method looks present and fails like a
  // refusal. The `in` test DOES reflect the real member set there (verified against 0.20.0:
  // `'probeBodySearch' in hudu.operations` is false while `hudu.operations.probeBodySearch` is a
  // function), so it is the feature detection.
  if (operations === undefined || !('probeBodySearch' in operations) || typeof operations.probeBodySearch !== 'function') {
    return { ...NOT_PROBED, collections, probeMs: Date.now() - started };
  }
  const probe = operations.probeBodySearch;
  try {
    const result = await probe.call(host.operations);
    return {
      // The SDK is asked about this very block, so its `configured` cannot disagree with ours.
      configured: true,
      reachable: result.reachable === true,
      collections: Array.isArray(result.collections) && result.collections.length > 0 ? result.collections : collections,
      probeMs: typeof result.probeMs === 'number' ? result.probeMs : Date.now() - started,
      ...(result.error ? { error: { code: result.error.code, message: result.error.message } } : {}),
    };
  } catch (error) {
    // A probe is an advisory fact, never the reason a tool call fails: Hudu's own document is the
    // answer, and an unreachable endpoint is reported as such.
    //
    // A refusal is NOT an endpoint problem and must not be dressed as one: when the client's policy
    // omits the operation (POLICY_DENIED) or this SDK build has no such operation
    // (NOT_IMPLEMENTED), the report says the operation is not permitted - "unavailable" - and stays
    // silent about Typesense, because nothing about the endpoint was learned.
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string') return { ...NOT_PROBED, collections, probeMs: Date.now() - started };
    const notPermitted = code === 'POLICY_DENIED' || code === 'NOT_IMPLEMENTED';
    return {
      ...NOT_PROBED,
      collections,
      probeMs: Date.now() - started,
      error: { code, message: notPermitted ? 'the operation is not permitted by this client policy' : 'the probe request failed' },
    };
  }
}
