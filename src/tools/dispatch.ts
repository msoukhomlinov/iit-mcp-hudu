/** Register the SDK-governed read, write and delete dispatchers. */
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { getCapability } from 'node-hudu/capabilities';
import { dispatchOperation, META_TOOLS } from 'node-hudu/mcp';
import { assertSecretReadPermitted, assertWritePermitted } from '../policy.js';
import { redactCompanyContextCredentials } from './company-context-policy.js';
import type { ToolContext } from './context.js';
import { contextErrorContent, errorContent, createResultBuilders, resolveErrorContent, searchErrorContent, unauthorizedContent } from './results.js';
import { INVOKE_OUTPUT } from './schemas.js';
import { FETCH_MANY_OPERATION, applyFetchManyPolicyToInvoke, SEARCH_ACROSS_OPERATION, applyAcrossPolicyToInvoke, credentialRefused, RESOLVE_ANY_OPERATION, SEARCH_KNOWLEDGE_OPERATION, applyResolvePolicyToInvoke, applySearchPolicyToInvoke, sanitizeIndexMeta, sanitizeSearchFailures } from './search-policy.js';

export function registerDispatchTools(server: McpServer, ctx: ToolContext): void {
  const { ok } = createResultBuilders(ctx.huduOrigin);
  const { config, log } = ctx;
  for (const mode of ['read', 'write', 'delete'] as const) {
    if (mode !== 'read' && config.HUDU_READ_ONLY) continue;
    const client = mode === 'read' ? ctx.hudu : ctx.mutationClients?.[mode];
    if (!client) throw new Error(`Missing ${mode} SDK client`);
    const effect = mode === 'delete' ? 'destructive' : mode;
    const spec = META_TOOLS.find((tool) => tool.name === `hudu_${mode}`);
    const operations = spec?.inputSchema.fields.operation?.enum;
    if (!spec || !operations?.length) throw new Error(`Missing SDK ${mode} metadata`);
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: z.strictObject({
          operation: z.enum(operations).describe('Canonical operation key (see hudu_list_operations). Exact registry key, never a tool name.'),
          input: z.record(z.string(), z.unknown()).optional().describe('The operation arguments as one object; validated against the registry record before any request.'),
          ...(mode === 'read' ? {} : { dry_run: z.boolean().optional().describe('Writes only: omit (or pass true) for the SDK dry-run path (simulated: true, impact and diff, no request issued); pass false to execute. A read called with dry_run: true is refused.'),
          confirm: z.string().optional().describe('For a destructive or approval-gated operation: must equal the operation key exactly, or the call is refused.') }),
        }),
        outputSchema: INVOKE_OUTPUT,
        annotations: spec.annotations,
        _meta: { backingOperation: '— (whole registry, by canonical key)', dryRunAffordance: 'dry_run', registryWide: true },
      },
      async (args) => {
        const { operation, input, dry_run, confirm } = args;
        try {
          // Deployment policy narrows the SDK mode and effect gate.
          assertWritePermitted(operation, getCapability(operation), config, log);

          // The secret-read policy is the other deployment authority, and it is not a write policy:
          // `asset_passwords.get` is an ordinary read that returns `password` and `otp_secret` in
          // plaintext, so nothing above this line would stop it.
          assertSecretReadPermitted(operation, config, log);

          // The search resource policy is a READ-edge authority like the write policy: `effect dispatcher`
          // reaches the search and resolve helpers directly, so each must honour the same resource
          // scope as its tool rather than bypassing the narrowed schema. `operations.fetchMany` is
          // the same kind of read edge, through items: its key is not a secret operation, so the
          // assert above passes it, and only the item-level check closes the credential-read gap.
          const bag =
            operation === SEARCH_KNOWLEDGE_OPERATION
              ? applySearchPolicyToInvoke(ctx, input ?? {})
              : operation === RESOLVE_ANY_OPERATION
                ? applyResolvePolicyToInvoke(ctx, input ?? {})
                : operation === SEARCH_ACROSS_OPERATION
                  ? applyAcrossPolicyToInvoke(ctx, input ?? {})
                  : operation === FETCH_MANY_OPERATION
                    ? applyFetchManyPolicyToInvoke(ctx, input ?? {})
                    : (input ?? {});

          // ONE implementation decides whether this call is allowed: the SDK dispatcher. It resolves
          // the exact registry key, refuses the projection's refusal class, validates the bag against
          // that record's inputSchema, forces a dry run first on writes, requires `confirm` for a
          // destructive one, and then calls the operation's OWN typed method. Passing the flags
          // through only when present matters: an explicit `dryRun: undefined` is not the same input
          // to the governor as an absent one.
          const opts: { dryRun?: boolean; confirm?: string } = {};
          if (typeof dry_run === 'boolean') opts.dryRun = dry_run;
          if (typeof confirm === 'string') opts.confirm = confirm;
          let result = await dispatchOperation(client, effect, operation, bag, opts);
          if (operation === 'companies.getContext') {
            result = redactCompanyContextCredentials(result, operation, config, log);
          }
          // A failed resource in a search result is reported as unavailable, never with Hudu's own
          // auth message: the upstream detail names which resource this deployment's credential may
          // not read, and the invoke path must not leak it any more than `hudu_search` may.
          if (operation === SEARCH_KNOWLEDGE_OPERATION && result !== null && typeof result === 'object') {
            const meta = (result as { meta?: Record<string, unknown> }).meta;
            if (meta !== undefined && meta !== null && typeof meta === 'object') {
              // The tool's credential-refusal rule applies to the escape hatch too: a key Hudu 401s
              // on every scope resource is a credential failure, not a 0-match answer,
              // and the narrowed hudu_search schema must not be bypassable into the old behaviour.
              if (credentialRefused(meta, (result as { hits?: readonly unknown[] }).hits)) return unauthorizedContent();
              const failures = sanitizeSearchFailures(meta.failed ?? meta.errors);
              result = {
                ...(result as Record<string, unknown>),
                meta: { ...meta, errors: failures, failed: failures, index: sanitizeIndexMeta(meta.index) },
              };
            }
          }
          if (operation === SEARCH_ACROSS_OPERATION && result !== null && typeof result === 'object' && !Array.isArray(result)) {
            const report = result as Record<string, unknown>;
            // Same rule as searchKnowledge: an isolated fan-out whose every requested resource was
            // refused is a credential failure, not a 0-hit report.
            const resources = (bag.opts as { resources?: unknown } | undefined)?.resources;
            if (credentialRefused({ resources, failed: report.failed, errors: report.errors }, report.hits)) return unauthorizedContent();
            result = { ...report, errors: sanitizeSearchFailures(report.errors), failed: sanitizeSearchFailures(report.failed) };
          }
          const simulated = result !== null && typeof result === 'object' && (result as { simulated?: unknown }).simulated === true;
          return ok(simulated ? `Dry run: nothing was written (${operation}).` : `${operation} completed.`, {
            simulated,
            operation,
            result: result ?? null,
          });
        } catch (err) {
          // A thrown auth error on a cross-resource read must not leak the credential's scope any
          // more than a per-resource `meta.failed` may; other operations keep their code.
          if (['companies.getContext', 'assets.getContext', 'articles.getContext'].includes(operation)) return contextErrorContent(err);
          if (operation === SEARCH_KNOWLEDGE_OPERATION || operation === SEARCH_ACROSS_OPERATION) return searchErrorContent(err);
          return operation === RESOLVE_ANY_OPERATION ? resolveErrorContent(err) : errorContent(err);
        }
      },
    );
  }
}
