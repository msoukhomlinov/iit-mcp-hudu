/**
 * tools/meta.ts — the META tools: `hudu_list_operations`, `hudu_describe_operation` and `hudu_read / hudu_write / hudu_delete`.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { getCapability } from 'node-hudu/capabilities';
import { catalogPage, configError, describeOperation, requireCatalogRow } from 'node-hudu/mcp';
import {
  applyCatalogPolicy,
  applyDescribePolicy,
} from '../policy.js';
import { registerDispatchTools } from './dispatch.js';
import type { ToolContext } from './context.js';
import { applyDedicatedToolCatalog, applyDedicatedToolDescribe } from './dedicated.js';
import { errorContent, metaSpec, createResultBuilders } from './results.js';
import { CATALOG_OUTPUT } from './schemas.js';
import { applyAcrossDescribePolicy, applyResolveDescribePolicy, applySearchCatalogPolicy, applySearchDescribePolicy } from './search-prose.js';

/** Register `hudu_list_operations`, `hudu_describe_operation` and `hudu_read / hudu_write / hudu_delete`, in that order. */
export function registerMetaTools(server: McpServer, ctx: ToolContext): void {
  const { ok } = createResultBuilders(ctx.huduOrigin);
  const { config } = ctx;
  server.registerTool(
    'hudu_list_operations',
    {
      ...metaSpec('hudu_list_operations'),
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(40).describe('Rows per page (1-100, default 40); the whole catalog is ~10k tokens, so page it.'),
        offset: z.number().int().min(0).default(0).describe('Row offset, for paging.'),
        effect: z.enum(['read', 'write', 'destructive']).optional().describe('Only rows with this effect.'),
        resource: z.string().optional().describe('Only rows of this registry resource (e.g. "assets").'),
        unexposed_only: z.boolean().optional().describe('Only rows with NO tool of their own — the capabilities reachable only through hudu_read / hudu_write / hudu_delete.'),
      }),
      outputSchema: CATALOG_OUTPUT,

      _meta: { backingOperation: '— (serves the whole registry)', dryRunAffordance: 'dry_run', registryWide: true },
    },
    async (args) => {
      try {
        const page = applySearchCatalogPolicy(
          ctx,
          applyCatalogPolicy(
            applyDedicatedToolCatalog(catalogPage(args), { ...args, searchableResources: ctx.searchableResources }),
            config,
          ),
        );
        const text = `${page.rows.length} of ${page.matched} matching operation(s) shown (offset ${page.offset}, bound ${page.limit}). The registry holds ${page.total_operations} operations; ${page.unexposed_operations} of them have NO tool of their own and are reached with hudu_read / hudu_write / hudu_delete; ${page.unreachable_operations} are deliberately not callable here (see the row's reason and bounded alternative).`;
        return ok(text, { ...page });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    'hudu_describe_operation',
    {
      ...metaSpec('hudu_describe_operation'),
      inputSchema: z.object({
        operation: z.string().min(1).describe('Canonical operation key exactly as hudu_list_operations prints it, e.g. "companies.update". Never a tool name; there is no fuzzy match.'),
      }),
      // `passthrough` because the describe payload is the registry record's own shape: pinning it
      // field-by-field here would drift the moment the SDK adds one.
      outputSchema: z.looseObject({ op: z.string() }),

      _meta: { backingOperation: '— (serves the whole registry)', dryRunAffordance: 'dry_run', registryWide: true },
    },
    async (args) => {
      try {
        const { operation } = args;
        const record = getCapability(operation);
        if (record === undefined) {
          // Throws CONFIG_ERROR naming the nearest catalog keys (exact-key lookup only — there is
          // no fuzzy execution anywhere in this server). The line after it is unreachable; it
          // exists so the narrowing is a type fact rather than a comment.
          requireCatalogRow(operation);
          throw configError(`hudu_describe_operation: ${operation} is not a known operation.`);
        }
        const described = applyAcrossDescribePolicy(ctx, applySearchDescribePolicy(
          ctx,
          applyResolveDescribePolicy(
            ctx,
            applyDedicatedToolDescribe(applyDescribePolicy(describeOperation(record), operation, record, config), ctx.searchableResources),
          ),
        ));
        // A reachable read with a tool of its own names it, so discovery never sends the model to
        // the approval-gated `hudu_read / hudu_write / hudu_delete` for a read a dedicated ungated tool already serves.
        // Reachability comes first: a policy-refused operation keeps its `exposed_tool` but must
        // report the refusal, never steer the model to a guaranteed policy failure.
        const steer = !described.reachable
          ? ` — NOT callable here: ${described.why_not}`
          : described.exposed_tool !== null
            ? ` — use ${described.exposed_tool}`
            : '';
        return ok(`${operation}: ${described.effect}${steer}`, { ...described });

      } catch (err) {
        return errorContent(err);
      }
    },
  );

  registerDispatchTools(server, ctx);
}
