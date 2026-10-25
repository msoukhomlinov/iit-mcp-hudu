/** Register the SDK-governed read, write and delete dispatchers. */
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { getCapability } from 'node-hudu/capabilities';
import { dispatchOperation, META_TOOLS } from 'node-hudu/mcp';
import { writeToolRegistered, assertNeverReachablePermitted, assertSecretReadPermitted, assertWritePermitted } from '../policy.js';
import { redactCompanyContextCredentials } from './company-context-policy.js';
import type { ToolContext } from './context.js';
import { toolDescription } from './tool-prose.js';
import { lossyNote, takeContentLoss } from './article-loss.js';
import { contextErrorContent, errorContent, createResultBuilders, resolveErrorContent, searchErrorContent, unauthorizedContent, upfrontRefusal } from './results.js';
import { INVOKE_OUTPUT } from './schemas.js';
import { FETCH_MANY_OPERATION, applyFetchManyPolicyToInvoke, SEARCH_ACROSS_OPERATION, applyAcrossPolicyToInvoke, credentialRefused, RESOLVE_ANY_OPERATION, SEARCH_KNOWLEDGE_OPERATION, applyResolvePolicyToInvoke, applySearchPolicyToInvoke, sanitizeIndexMeta, sanitizeSearchFailures } from './search-policy.js';

export function registerDispatchTools(server: McpServer, ctx: ToolContext): void {
  const { ok } = createResultBuilders(ctx.huduOrigin);
  const { config, log } = ctx;
  for (const mode of ['read', 'write', 'delete'] as const) {
    if (mode !== 'read' && !writeToolRegistered(config, mode)) continue;
    const client = mode === 'read' ? ctx.hudu : ctx.mutationClients?.[mode];
    if (!client) throw new Error(`Missing ${mode} SDK client`);
    const effect = mode === 'delete' ? 'destructive' : mode;
    const spec = META_TOOLS.find((tool) => tool.name === `hudu_${mode}`);
    const operations = spec?.inputSchema.fields.operation?.enum;
    // The SDK owns the dispatcher field text; serve it verbatim rather than keep a drifting local copy.
    const field = (name: string): string => (spec?.inputSchema.fields as Record<string, { description?: string } | undefined> | undefined)?.[name]?.description ?? '';
    if (!spec || !operations?.length) throw new Error(`Missing SDK ${mode} metadata`);
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: toolDescription(spec.name),
        inputSchema: z.strictObject({
          operation: z.enum(operations).describe(field('operation')),
          input: z.record(z.string(), z.unknown()).optional().describe(field('input')),
          ...(mode === 'read' ? {} : { dry_run: z.boolean().optional().describe(field('dry_run')), confirm: z.string().optional().describe(field('confirm')) }),
        }),
        outputSchema: INVOKE_OUTPUT,
        annotations: spec.annotations,
      },
      async (args) => {
        const { operation, input, dry_run, confirm } = args;
        // True once control reaches the SDK dispatcher: every policy gate above it refuses before any
        // request, so those refusals never clear. Past this point a validation refusal also clears;
        // that is a cheap no-op, and telling it apart from a write that dialed is not worth the code.
        let dispatched = false;
        try {
          // Deployment policy narrows the SDK mode and effect gate.
          assertWritePermitted(operation, getCapability(operation), config, log);

          // The secret-read policy is the other deployment authority, and it is not a write policy:
          // `asset_passwords.get` is an ordinary read that returns `password` and `otp_secret` in
          // plaintext, so nothing above this line would stop it.
          assertSecretReadPermitted(operation, config, log);
          assertNeverReachablePermitted(operation, log);

          // The search resource policy is a READ-edge authority like the write policy: `effect dispatcher`
          // reaches the search and resolve helpers directly, so each must honour the same resource
          // scope as its tool rather than bypassing the narrowed schema. `operations.fetchMany` is
          // the same kind of read edge, through items: its key is not a secret operation, so the
          // assert above passes it, and only the item-level check closes the credential-read gap.
          const searchPolicy = operation === SEARCH_KNOWLEDGE_OPERATION ? applySearchPolicyToInvoke(ctx, input ?? {}) : undefined;
          const tierOverridden = searchPolicy?.tierOverridden === true;
          const bag =
            searchPolicy !== undefined
              ? searchPolicy.bag
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
          // Article bodies cross this boundary as Markdown (node-hudu 0.14 dialect): far fewer tokens than
          // HTML for the model, converted by the SDK, with its round-trip loss guard on every write.
          const opts: { dryRun?: boolean; confirm?: string; contentFormat: 'markdown' } = { contentFormat: 'markdown' };
          if (typeof dry_run === 'boolean') opts.dryRun = dry_run;
          if (typeof confirm === 'string') opts.confirm = confirm;
          dispatched = true;
          let result = await dispatchOperation(client, effect, operation, bag, opts);
          // After the SDK's own input validation, so bad input stays CONFIG_ERROR. The refusing
          // placeholder never dials, so nothing reached Hudu; the engine swallows its error into a
          // 0-hit result (searchKnowledge, an isolating searchAcrossResources) or per-item rows
          // (fetchMany), so only those answer the typed refusal (a throwing call already carries the SDK's own envelope).
          const isolating = operation === SEARCH_ACROSS_OPERATION && (bag.opts as { isolateErrors?: unknown } | undefined)?.isolateErrors === true;
          // fetchMany folds a whole-batch refusal into per-item rows; a refused client is a top-level error.
          if (operation === SEARCH_KNOWLEDGE_OPERATION || operation === FETCH_MANY_OPERATION || isolating) {
            const refused = upfrontRefusal();
            if (refused !== undefined) return refused;
          }
          // A Markdown article read that lost content carries the SDK's content_loss (see article-loss.ts).
          let lossy: string[] = [];
          if (mode === 'read') ({ result, codes: lossy } = takeContentLoss(operation, result));
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
              // A tier/refresh the deployment policy overrode is announced, never silently swapped.
              const reasons = Array.isArray(meta.reasons) ? meta.reasons : [];
              result = {
                ...(result as Record<string, unknown>),
                meta: {
                  ...meta,
                  ...(tierOverridden ? { reasons: [...reasons, 'tier-policy-override'] } : {}),
                  errors: failures,
                  failed: failures,
                  index: sanitizeIndexMeta(meta.index),
                },
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
          // A Markdown article read that lost content says so; a lossless read is byte-identical to before.
          const overrideNote = tierOverridden ? ' The tier/refresh this call carried were overridden by the server search tier policy.' : '';
          return ok((simulated ? `Dry run: nothing was written (${operation}).` : `${operation} completed.`) + overrideNote + (lossy.length ? lossyNote(lossy, operation) : ''), {
            simulated,
            operation,
            result: result ?? null,
            ...(lossy.length ? { markdown_lossy: true, markdown_lossy_codes: lossy } : {}),
          });
        } catch (err) {
          // A thrown auth error on a cross-resource read must not leak the credential's scope any
          // more than a per-resource `meta.failed` may; other operations keep their code.
          if (['companies.getContext', 'assets.getContext', 'articles.getContext'].includes(operation)) return contextErrorContent(err);
          if (operation === SEARCH_KNOWLEDGE_OPERATION || operation === SEARCH_ACROSS_OPERATION) return searchErrorContent(err);
          return operation === RESOLVE_ANY_OPERATION ? resolveErrorContent(err) : errorContent(err);
        } finally {
          // Each effect has its own cached client, so a write never clears the read client's cache
          // (node-hudu clears only the client it mutates through). Clear the read client of this scope
          // after every real write or delete ATTEMPT, in `finally`: a timeout or 5xx may still have
          // applied. A dry run (`dry_run` absent is forced to one by the SDK) sends no write, so it
          // does not clear. clearCache never throws; the guard makes sure it cannot alter the result.
          if (mode !== 'read' && dispatched && dry_run === false) {
            try {
              ctx.hudu.clearCache();
            } catch (e) {
              log.warn('read cache clear failed after write', { operation, error: e instanceof Error ? e.message : String(e) });
            }
          }
        }
      },
    );
  }
}
