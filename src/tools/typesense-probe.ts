/**
 * typesense-probe.ts — the one live Typesense question `hudu_get_api_info` answers.
 *
 * A zero-wire `doctor` cannot report reachability (that is its whole contract), so the live probe
 * lives on a tool that is already a wire call. The request itself belongs to the SDK: one
 * `q=*&per_page=0` search against the articles collection that a search-only key may run, and never
 * a `GET /collections` (a search-only key cannot, and the collection names are configuration here).
 *
 * Two DIFFERENT questions decide whether the probe can run, and this module asks both:
 *
 *   1. is the operation built into this SDK version?      -> the capability registry (plain data)
 *   2. does this client's policy permit it right now?     -> `'operations.probeBodySearch' in ops`
 *
 * They must not be collapsed into one check: a policy can permit an operation this build does not
 * have, and a build can have an operation a policy omits. Answering with one probe would let a
 * policy change silently flip what the report means, and would leave a reader unable to tell which
 * question failed. Their failure codes are therefore distinct — `NOT_IMPLEMENTED` (not built) and
 * `POLICY_DENIED` (built, not permitted) — and only a call that is both built and permitted may
 * produce a real result or a transport code such as `TYPESENSE_UNAVAILABLE`.
 *
 * WHY `in` AND NEVER `typeof`: the SDK's `operations` object is a Proxy over a FROZEN facade whose
 * own properties are only the methods the client policy permits (filtered by
 * `getPolicyCapability('resource.method')`), and the handler defines ONLY a `get` trap. So
 * `get` fabricates a callable for any name — `typeof operations.x === 'function'` is true even for a
 * method that does not exist — while `'x' in operations` uses the DEFAULT own-property lookup and is
 * reliable. `in` is false for BOTH "absent from this SDK build" and "present but denied by this
 * policy", which is exactly the question a capability probe asks ("can I call it now?"). Because
 * `typeof` is never safe here, this guard must not be "simplified" back to it.
 *
 * node-hudu 0.21.0 builds the operation: `operations.probeBodySearch()` returns
 * `KnowledgeSearchBackendProbe` (`{ configured, collections, reachable, probeMs, error? }`) and never
 * throws. This module therefore calls it directly — no structural host, no cast, no method name
 * held in a string — and stays a thin normaliser. The two questions above remain separate, because
 * the policy half is not a build-time fact.
 */
import type { HuduClient } from 'node-hudu';
import { getCapability } from 'node-hudu/capabilities';
import { typesenseSearchBlock, type Config } from '../config.js';

/**
 * The registry key and method name the probe lives under (node-hudu#124). Defined in `config.ts`,
 * where the build-time refusal reads it, and re-exported here for the probe's callers.
 */
export { BODY_PROBE_OPERATION } from '../config.js';
import { BODY_PROBE_OPERATION as PROBE_OPERATION } from '../config.js';

/** What `hudu_get_api_info` publishes. Always absent from the answer when the tier is unconfigured. */
export interface TypesenseProbeReport {
  configured: boolean;
  reachable: boolean;
  collections: string[];
  probeMs: number;
  /** Why the probe could not answer, with a code that names WHICH question failed. Never the key. */
  error?: { code: string; message: string };
}

const NOT_PROBED: Omit<TypesenseProbeReport, 'collections'> = {
  configured: true,
  reachable: false,
  probeMs: 0,
};

/** A probe that never ran, carrying the code that says which question failed. */
function unavailable(collections: string[], probeMs: number, code: string, message: string): TypesenseProbeReport {
  return { ...NOT_PROBED, collections, probeMs, error: { code, message } };
}

/**
 * Ask the SDK whether the configured Typesense endpoint answers.
 *
 * - unconfigured: `{ configured: false, reachable: false }` and no request at all — the caller
 *   omits the field entirely, so this shape is for direct callers and tests.
 * - not built into this SDK version: `reachable: false` with `error.code: NOT_IMPLEMENTED`, whether
 *   or not a policy names it. Nothing is dialed.
 * - built but not permitted by this client policy: `reachable: false` with
 *   `error.code: POLICY_DENIED`. Nothing is dialed.
 * - built and permitted: the SDK's answer, mapped; a throw becomes `reachable: false` with its code.
 */
export async function probeTypesense(hudu: HuduClient, config: Config): Promise<TypesenseProbeReport> {
  const block = typesenseSearchBlock(config);
  if (block === undefined) return { configured: false, reachable: false, collections: [], probeMs: 0 };
  const collections = [block.collections.articles, block.collections.assets];
  const started = Date.now();

  // Question 1, build-time, from plain data: no callable is touched, so no proxy can lie.
  if (getCapability(PROBE_OPERATION) === undefined) {
    return unavailable(collections, Date.now() - started, 'NOT_IMPLEMENTED', `this SDK version has no ${PROBE_OPERATION}`);
  }
  // Question 2, this client's policy: membership, never `typeof` (see the module comment). A real
  // client always exposes `operations`; the optional local keeps a bare test double honest instead
  // of throwing a TypeError that would read as a crash rather than a refusal.
  const operations: HuduClient['operations'] | undefined = hudu.operations;
  if (operations === undefined || !('probeBodySearch' in operations)) {
    return unavailable(collections, Date.now() - started, 'POLICY_DENIED', `this client policy does not permit ${PROBE_OPERATION}`);
  }

  try {
    const result = await operations.probeBodySearch();
    return {
      // The SDK is asked about this very block, so its `configured` cannot disagree with ours.
      configured: true,
      reachable: result.reachable === true,
      collections: Array.isArray(result.collections) && result.collections.length > 0 ? result.collections : collections,
      probeMs: typeof result.probeMs === 'number' ? result.probeMs : Date.now() - started,
      ...(result.error ? { error: { code: result.error.code, message: result.error.message } } : {}),
    };
  } catch (error) {
    // Built and permitted, so a throw here is about the REQUEST (or a race with a policy change).
    // A refusal still says "not permitted"; anything else keeps its own code and is never filed as
    // a refusal, so the two can be told apart in a report.
    const code = (error as { code?: unknown }).code;
    // Always answer WHY. A throw that carries no string code still has to say something, or the
    // report reads "not reachable" with no explanation at all — the one shape a caller cannot act on.
    if (typeof code !== 'string') {
      return unavailable(collections, Date.now() - started, 'PROBE_FAILED', 'the probe failed without an error code');
    }
    if (code === 'POLICY_DENIED') return unavailable(collections, Date.now() - started, code, `this client policy does not permit ${PROBE_OPERATION}`);
    if (code === 'NOT_IMPLEMENTED') return unavailable(collections, Date.now() - started, code, `this SDK version has no ${PROBE_OPERATION}`);
    return unavailable(collections, Date.now() - started, code, 'the probe request failed');
  }
}
