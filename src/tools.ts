/**
 * tools.ts — the CORE tool surface, registered once against a caller-supplied `McpServer`.
 *
 * Productised from `node-hudu/examples/mcp-server.ts`. That file is the reference the SDK's
 * `mcp:project --check-example` drift gate walks, so the names, titles and descriptions here are
 * NOT ours to improve: they are curated upstream in `MCP_TOOL_OVERRIDES.json` and taken verbatim
 * from `node-hudu/mcp` wherever the SDK publishes them (`META_TOOLS`, `TOOL_DESCRIPTIONS`). A
 * description that reads wrong is an SDK issue, not a local edit.
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
export const BUILT_AGAINST_PLAN_HASH = '32385a7079c38370da6c76d00df21a975d3de72db5b5e2bf87e41bd9eae73f6a';
