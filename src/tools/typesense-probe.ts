/**
 * typesense-probe.ts — the one live Typesense question `hudu_get_api_info` answers.
 *
 * A zero-wire `doctor` cannot report reachability (that is its whole contract), so the live probe
 * lives on a tool that is already a wire call. The probe itself belongs to the SDK (DESIGN §3 WP-2:
 * `TypesenseClient.probe()`, one `per_page=0` search that a search-only key may run); this module
 * only guards its call site.
 *
 * TODO(verify with node-hudu@0.21.0): 0.20.0 exposes no probe, so the accessor below is written
 * against the shape the SDK is expected to publish — `client.search.typesense.probe()`, i.e. the
 * `search.typesense` block this server already passes as config. Until 0.21.0 lands, a configured
 * deployment reports `reachable: false` and nothing is dialed, which is the honest answer: with no
 * probe there is no evidence either way, and claiming reachable would be a lie a caller could act on.
 * When the SDK lands, `probeTypesense` becomes a two-line function and the guard is deleted.
 */
import type { HuduClient } from 'node-hudu';
import { typesenseSearchBlock, type Config } from '../config.js';

/** What `hudu_get_api_info` publishes. Always absent when the tier is unconfigured. */
export interface TypesenseProbeReport {
  configured: true;
  reachable: boolean;
  collections: string[];
  probeMs: number;
}

/** The SDK's probe result: a union, so a failure carries a code rather than a bare false. */
interface SdkProbeResult {
  ok: boolean;
  code?: string;
  message?: string;
}

/** The 0.21.0 surface this call site assumes; see the module comment. */
interface TypesenseProbeHost {
  search?: { typesense?: { probe?: () => Promise<SdkProbeResult> } };
}

/**
 * Ask the SDK whether the configured Typesense endpoint answers.
 *
 * @returns the report, or `undefined` when the deployment configured no tier — in which case the
 *   caller adds no field at all rather than a `configured: false` row.
 */
export async function probeTypesense(hudu: HuduClient, config: Config): Promise<TypesenseProbeReport | undefined> {
  const block = typesenseSearchBlock(config);
  if (block === undefined) return undefined;
  const collections = [block.collections.articles, block.collections.assets];
  const started = Date.now();
  const host = hudu as unknown as TypesenseProbeHost;
  const probe = host.search?.typesense?.probe;
  if (typeof probe !== 'function') {
    return { configured: true, reachable: false, collections, probeMs: Date.now() - started };
  }
  try {
    const result = await probe.call(host.search!.typesense);
    return { configured: true, reachable: result.ok === true, collections, probeMs: Date.now() - started };
  } catch {
    // A probe is an advisory fact, never the reason a tool call fails: Hudu's own document is the
    // answer, and an unreachable endpoint is reported as such.
    return { configured: true, reachable: false, collections, probeMs: Date.now() - started };
  }
}
