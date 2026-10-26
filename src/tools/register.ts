/**
 * tools/register.ts — `registerTools`: derives the per-server context once, then registers each
 * tool group in `tools/list` order.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import type { SearchTier } from '../config.js';
import { typesenseSearchBlock } from '../config.js';
import type { ToolContext, ToolDeps } from './context.js';
import { registerFetchManyTool } from './fetch-many.js';
import { registerListTools } from './lists.js';
import { registerMetaTools } from './meta.js';
import { registerReadTools } from './reads.js';
import { registerSearchTool } from './search.js';
import { DEFAULT_SEARCH_SCOPE, effectiveDefaultSearchScope, effectiveSearchResources } from './search-policy.js';

/**
 * Register the CORE profile — the SDK's `CORE_TOOLS` (including, since node-hudu 0.12.0, the
 * dedicated batch read `hudu_fetch_many`) plus this server's four dedicated bounded list reads
 * (`hudu_list_companies`, `hudu_list_articles`, `hudu_list_assets`, `hudu_list_asset_layouts`)
 * — on `server`.
 */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { hudu, config, log } = deps;
  /** Cross-resource reads (`searchKnowledge`, `resolveAny`); same client, same rate-limit bucket. */
  const ops = hudu.operations;
  /**
   * The resources `hudu_search` may offer and query.
   *
   * `HUDU_SEARCH_RESOURCES` narrows this per deployment so the tool's schema never advertises a
   * resource the credential cannot read; unset means the SDK's full searchable set.
   */
  const searchableResources = effectiveSearchResources(config);
  /** The scope an omitted `resources` argument resolves to, never outside `searchableResources`. */
  const defaultSearchScope = effectiveDefaultSearchScope(searchableResources);
  /**
   * Whether a body tier may be used here.
   *
   * EVERY body tier covers articles AND assets, and both are corpus-wide with no scope parameter:
   * the in-memory index walk and the Typesense query set alike. So a body tier is policy-clean only
   * when BOTH resources are searchable; otherwise `tier:"index"` would walk — and `tier:"typesense"`
   * would query — a resource this deployment excluded.
   */
  const bodySearchable = DEFAULT_SEARCH_SCOPE.every((r) => searchableResources.includes(r));
  /**
   * Whether the Typesense body tier is configured (`HUDU_TYPESENSE_URL` + `..._API_KEY`).
   *
   * Configuration, not a request: the pair is validated at boot, so this is a fact about the
   * deployment, and it is what turns the tier on for `auto` and for the default.
   */
  const typesenseConfigured = typesenseSearchBlock(config) !== undefined;

  /**
   * The tier `hudu_search` uses when the caller omits one.
   *
   * Under `stdio` the process holds one long-lived credential, so its index is warmed once and the
   * tool can default to `"index"`: the first call already has article-body recall. Under `http`
   * every caller's scope starts cold, and a cold body-index build is a corpus-wide walk that can
   * outlast the consumer's call timeout (some clients enforce 60s). A cold scope therefore defaults to
   * `"auto"`: the SDK answers from Hudu search immediately and builds the body index in the
   * background, so a later search from the same caller is index-backed while the first is not. A
   * `stdio` caller that wants a complete first answer can still pass `tier:"index"` explicitly and
   * wait; under `http` no such field is served (see {@link searchTierIsPolicy}).
   * When the corpus is excluded no index path may run, so the default is `"vendor"`.
   *
   * `HUDU_SEARCH_TIER_POLICY` overrides the transport default, because whether a call may wait for a
   * walk is a budget only the deployer can judge. It cannot override the corpus gate: a body tier
   * over an excluded resource is never policy-clean.
   *
   * The Typesense tier removes the cold-start asymmetry `auto` exists for: it has no corpus walk, so
   * when it is configured it is the default under `stdio` AND under `http`. With it unconfigured the
   * transport defaults above are unchanged, byte for byte.
   */
  const toolDefaultTier: SearchTier = bodySearchable
    ? (config.HUDU_SEARCH_TIER_POLICY
        ?? (typesenseConfigured ? 'typesense' : config.MCP_TRANSPORT === 'http' ? 'auto' : 'index'))
    : 'vendor';
  /**
   * Under `http` the tier is policy, not a call parameter: the served schema offers neither `tier`
   * nor `refresh`, and every search path uses {@link toolDefaultTier}. Under `stdio` the caller keeps
   * both fields, unchanged — one long-lived credential owns one warmed index.
   */
  const searchTierIsPolicy = config.MCP_TRANSPORT === 'http';

  const ctx: ToolContext = { ...deps, hudu, config, log, ops, searchableResources, defaultSearchScope, bodySearchable, typesenseConfigured, toolDefaultTier, searchTierIsPolicy };

  registerMetaTools(server, ctx);
  registerSearchTool(server, ctx);
  registerReadTools(server, ctx);
  registerListTools(server, ctx);
  registerFetchManyTool(server, ctx);
}
