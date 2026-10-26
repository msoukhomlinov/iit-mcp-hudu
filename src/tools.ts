/**
 * tools.ts — the CORE tool surface, registered once against a caller-supplied `McpServer`.
 *
 * Productised from `node-hudu/examples/mcp-server.ts`, the reference the SDK's
 * `mcp:project --check-example` drift gate walks. Tool NAMES stay SDK-owned. Titles are ours where
 * the SDK's repeats what the description already says — `hudu_search` serves "Search Hudu", not the
 * SDK's mode list — and an SDK-published description is still honoured where one exists. The served prose is ours:
 * `src/tools/tool-prose.ts` states what each tool does once (keeping the SDK's published facts
 * where it has them, in our wording), and `src/tools/search-prose.ts` applies this deployment's
 * policy — tier, resources, schema — on top.
 *
 * Two boundaries this module must never cross:
 *
 * 1. **No Hudu credential in any `inputSchema`.** Under `stdio` the key comes from config; under
 *    `http` the origin and the key both arrive on the request (`x-hudu-base-url`,
 *    `x-hudu-api-key`) and are resolved into a per-caller client. Either way a model must not be
 *    able to supply or observe one. Asserted in test.
 * 2. **No second write governor.** Effect dispatchers use separate SDK clients and delegate to
 *    SDK dispatchOperation. Read-only deployments omit mutation tools. Server policies only
 *    narrow SDK authority; validation, dry runs and confirmation remain SDK-owned.
 *
 * The implementation lives in `src/tools/`; this module is its public entry point.
 *
 */

export type { ToolDeps } from './tools/context.js';
export { registerTools } from './tools/register.js';
export { effectiveSearchResources, sanitizeIndexMeta, sanitizeSearchFailures } from './tools/search-policy.js';
export { MAX_SCOPED_CLIENTS, ScopedClientCache, createMcpServerFactory } from './tools/server.js';

/**
 * The catalogue plan this surface was built and reviewed against.
 *
 * An SDK upgrade that changes the projected operation set moves this hash. The drift test compares
 * it against the installed `CATALOG_PLAN_HASH`, so the upgrade fails CI instead of quietly shipping
 * a tool surface that no longer describes the SDK behind it.
 */
export const BUILT_AGAINST_PLAN_HASH = 'b46a003d8bef3f781f1bd1e21dc27271a1ad469eaa891560c767ad5b274dfaa1';
