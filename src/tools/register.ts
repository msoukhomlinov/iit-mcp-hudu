/**
 * tools/register.ts — `registerTools`: derives the per-server context once, then registers each
 * tool group in `tools/list` order.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolContext, ToolDeps } from './context.js';
import { registerListTools } from './lists.js';
import { registerMetaTools } from './meta.js';
import { registerReadTools } from './reads.js';
import { registerSearchTool } from './search.js';
import { DEFAULT_SEARCH_SCOPE, effectiveDefaultSearchScope, effectiveSearchResources } from './search-policy.js';

/**
 * Register the CORE profile — the SDK's `CORE_TOOLS` plus this server's four dedicated bounded list
 * reads (`hudu_list_companies`, `hudu_list_articles`, `hudu_list_assets`, `hudu_list_asset_layouts`)
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
   * Whether the body index may be used here.
   *
   * The index covers articles AND assets, and its walk is corpus-wide with no scope parameter, so it
   * is policy-clean only when BOTH are searchable. Otherwise `tier:"index"` would walk a resource
   * this deployment excluded (and, at boot, request its endpoint).
   */
  const indexSearchable = DEFAULT_SEARCH_SCOPE.every((r) => searchableResources.includes(r));

  /**
   * The tier `hudu_search` uses when the caller omits one.
   *
   * Under `stdio` the process holds one long-lived credential, so its index is warmed once and the
   * tool can default to `"index"`: the first call already has article-body recall. Under `http`
   * every caller's scope starts cold, and a cold body-index build is a corpus-wide walk that can
   * outlast the consumer's call timeout (some clients enforce 60s). A cold scope therefore defaults to
   * `"auto"`: the SDK answers from Hudu search immediately and builds the body index in the
   * background, so a later search from the same caller is index-backed while the first is not. A
   * caller that wants a complete first answer can still pass `tier:"index"` explicitly and wait.
   * When the corpus is excluded no index path may run, so the default is `"vendor"`.
   */
  const toolDefaultTier: 'auto' | 'vendor' | 'index' = indexSearchable
    ? config.MCP_TRANSPORT === 'http'
      ? 'auto'
      : 'index'
    : 'vendor';

  const ctx: ToolContext = { ...deps, hudu, config, log, ops, searchableResources, defaultSearchScope, indexSearchable, toolDefaultTier };

  registerMetaTools(server, ctx);
  registerSearchTool(server, ctx);
  registerReadTools(server, ctx);
  registerListTools(server, ctx);
}
