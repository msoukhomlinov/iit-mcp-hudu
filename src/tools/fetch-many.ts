/**
 * tools/fetch-many.ts — the dedicated batch read: `hudu_fetch_many`, up to 20 single records
 * across MIXED resources in one call.
 *
 * The SDK's 0.12.0 CORE profile ships this tool; before this module the server served the same
 * batch read only through `hudu_read` with operation `operations.fetchMany`. The two paths
 * coexist and are gated identically: the dispatch applies `applyFetchManyPolicyToInvoke`
 * (tools/search-policy.ts) before the SDK is called, and this tool calls the SAME wrapper first,
 * so an item cannot bypass the deployment's secret-read authority by arriving through the
 * dedicated tool. The SDK remains the validation authority: the closed item shape is served here
 * as the model-facing contract, and the SDK re-validates it with a typed CONFIG_ERROR before any
 * request — a typo in a resource name is distinguished from an unsupported resource, and both are
 * named.
 *
 * Each item executes as the single read it names (`<resource>.get`): one wire request per item,
 * sequential, through the resource's own get. Failure is PER-ITEM: a miss or a vendor fault lands
 * on its own row as a typed error while the rest of the batch is served — the envelope is
 * `{ ok, failed, results }`, never all-or-nothing. A violation of the closed item shape (21
 * items, an empty `fields` projection, a negative id, a resource outside the 22, an item missing
 * its resource, `items` not an array) is refused at the schema layer BEFORE any request — zero
 * wire.
 *
 * The title, description and annotations are the SDK's curated metadata (`metaSpec`, read rather
 * than retyped); the input and output schemas are this server's own zod objects, mirroring the
 * reference server's closed contract. The handler re-asserts nothing the SDK owns: policy is
 * asserted pre-request, the SDK validates and dispatches, and `errorContent` surfaces the SDK's
 * error contract on a whole-batch fault.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ToolContext } from './context.js';
import { errorContent, metaSpec, createResultBuilders } from './results.js';
import { applyFetchManyPolicyToInvoke } from './search-policy.js';

/**
 * The 22 bare-id resources the batch read serves — the closed `items.resource` enum.
 *
 * Parity-pinned to the registry: it must equal `getCapability('operations.fetchMany').dependsOn`
 * with the `.get` suffix stripped (test/tools/fetch-many.test.ts), so the served schema and the
 * SDK's dispatch cannot drift. The SDK's own validation remains the closedness authority; this
 * enum only keeps the served contract honest.
 */
export const FETCH_MANY_RESOURCES = [
  'companies', 'articles', 'asset_layouts', 'asset_passwords', 'flag_types', 'flags',
  'folders', 'groups', 'ip_addresses', 'label_types', 'labels', 'lists', 'networks',
  'password_folders', 'procedure_tasks', 'procedures', 'rack_storage_items', 'rack_storages',
  'users', 'vlan_zones', 'vlans', 'websites',
] as const;

/**
 * The CLOSED item shape: exactly `{ resource, id, fields? }` — a numeric vendor id and an
 * optional projection.
 *
 * The bounds align with the SDK's own authority (`validateFetchManyItems`): a non-negative
 * integer id, and a NON-EMPTY projection — an empty `fields` list would serve
 * `{ found: true, value: {} }`, so the schema layer refuses it instead of silently projecting to
 * nothing.
 */
const FETCH_MANY_ITEM = z.object({
  resource: z.enum(FETCH_MANY_RESOURCES),
  id: z.number().int().nonnegative(),
  fields: z.array(z.string()).min(1).optional(),
}).strict();

const FETCH_MANY_INPUT = z.object({
  items: z.array(FETCH_MANY_ITEM).min(1).max(20).describe('1-20 items, each exactly { resource, id, fields? }.'),
}).strict();

/** The fetchMany envelope: every item's outcome plus the ok/failed counts. */
const FETCH_MANY_OUTPUT = z.object({
  ok: z.number().describe('Items that fetched a record.'),
  failed: z.number().describe('Items that failed (a miss or a vendor fault) — the typed error is on the item row.'),
  results: z.array(z.unknown()).describe('One outcome per input item, in input order: { resource, id, found, value, error? }.'),
});

/** Register `hudu_fetch_many` — a read, so it is registered in every mode, including read-only. */
export function registerFetchManyTool(server: McpServer, ctx: ToolContext): void {
  const { ok } = createResultBuilders(ctx.huduOrigin);

  server.registerTool(
    'hudu_fetch_many',
    {
      ...metaSpec('hudu_fetch_many'),
      inputSchema: FETCH_MANY_INPUT,
      outputSchema: FETCH_MANY_OUTPUT,
      _meta: { backingOperation: 'operations.fetchMany', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      try {
        // The deployment's authority, asserted per item BEFORE any request — the same wrapper the
        // hudu_read dispatch of operations.fetchMany applies, so both paths gate identically.
        applyFetchManyPolicyToInvoke(ctx, { items: args.items });
        const result = await ctx.ops.fetchMany(args.items);
        return ok(
          `${result.ok} of ${args.items.length} item(s) fetched${result.failed > 0 ? `; ${result.failed} failed — the typed per-item error is on each row` : ''}.`,
          { ok: result.ok, failed: result.failed, results: result.results },
        );
      } catch (err) {
        return errorContent(err);
      }
    },
  );
}
