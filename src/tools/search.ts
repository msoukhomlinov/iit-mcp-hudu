/**
 * tools/search.ts — `hudu_search`, the one self-describing search tool.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { KnowledgeResource } from 'node-hudu';
import { SEARCH_HELP, SEARCH_MODES, SEARCH_RESOURCES, configError } from 'node-hudu/mcp';
import type { ToolContext } from './context.js';
import { errorContent, createResultBuilders, searchErrorContent, unauthorizedContent } from './results.js';
import { HELP_TOPICS, SEARCH_OUTPUT, resourceEnum } from './schemas.js';
import { credentialRefused, sanitizeIndexMeta, sanitizeSearchFailures } from './search-policy.js';
import { adjustHelpText, adjustedSearchModes, searchQueryDescription, searchToolDescription } from './search-prose.js';

// hudu_search — ONE self-describing search tool with three modes (search | help | resources).
// Mode discipline by construction, not by hope: a field the selected mode cannot honour is a
// CONFIG_ERROR naming the fields it does honour, never a silent ignore, and each mode returns a
// distinct top-level shape with the mode echoed back.
//
// SEARCH MODE DEFAULTS TO tier: "index" under stdio — one long-lived credential, one warmed index,
// so the tool builds or awaits the body index instead of answering body-blind from the vendor tier.
// Under http every caller's scope starts cold, so the default is "auto": a cold corpus walk must not
// outlast the consumer's call timeout — see `toolDefaultTier`. The SDK default stays lazy ("auto")
// for programmatic callers; a TOOL under stdio must not hand an agent a degraded answer by default.
export function registerSearchTool(server: McpServer, ctx: ToolContext): void {
  const { ok } = createResultBuilders(ctx.huduOrigin);
  const { ops, searchableResources, defaultSearchScope, indexSearchable, toolDefaultTier } = ctx;
  server.registerTool(
    'hudu_search',
    {
      title: 'Search Hudu (search | help | resources)',
      description: searchToolDescription(ctx),
      inputSchema: z.object({
        mode: z
          .enum(['search', 'help', 'resources'])
          .default('search')
          .describe('Which mode to run. Default "search" (the query runs; nothing else is needed). "help" returns how to use this tool. "resources" returns what is searchable. A field the selected mode cannot honour is a CONFIG_ERROR naming the fields it does honour - never silently ignored.'),
        query: z
          .string()
          .min(1)
          .optional()
          .describe(searchQueryDescription(ctx)),
        resources: z
          .array(resourceEnum(searchableResources))
          .optional()
          .describe(
            `mode="search" only. Which resources to search; default ${JSON.stringify(defaultSearchScope)}. ` +
              `The resources this deployment's credential may read (HUDU_SEARCH_RESOURCES), from the SDK's searchable set: ${searchableResources.join(', ')}.`,
          ),
        topic: z
          .enum(HELP_TOPICS as [string, ...string[]])
          .optional()
          .describe('mode="help" only. Which help section to return (default "core"; "all" adds query syntax and scoring). Rejected in the other modes.'),
        limit: z.number().int().min(1).max(25).optional().describe('mode="search" only. Ranked hits: 1-25, default 8. A larger value is a CONFIG_ERROR, never clamped.'),
        snippetChars: z.number().int().min(0).max(400).optional().describe('mode="search" only. Snippet characters per hit: 0-400, default 200, 0 = no snippet.'),
        company_id: z.number().int().optional().describe('mode="search" only. Scope the scan to one company.'),
        updated_since: z.string().optional().describe('mode="search" only. ISO 8601; only records updated at or after it.'),
        min_score: z.number().optional().describe('mode="search" only. 0-100 score floor: hits below the floor are left out of the result, and NO count of them is reported - an empty result can be the floor, not absence. meta.scanned (candidates scored before the floor) and meta.returned separate absence from exclusion: scanned 0 = nothing scored at all; scanned > 0 with returned 0 = candidates scored but none returned - below the floor, or excluded by the company_id, updated_since or scope filters (lower or drop min_score, or relax those filters, to see what was left out).'),
        exact_only: z.boolean().optional().describe('mode="search" only. true disables fuzzy matching, still ranked and snippeted. Default false.'),
        tier: z
          .enum(['auto', 'vendor', 'index'])
          .optional()
          .describe(
            !indexSearchable
              ? 'mode="search" only. This deployment excludes articles or assets, so the tool defaults to "vendor" and refuses "index", "auto" and refresh:true (the index walk is corpus-wide, and would walk an excluded resource). "vendor" answers from Hudu search alone.'
              : toolDefaultTier === 'auto'
                ? 'mode="search" only. THIS TOOL DEFAULTS TO "auto": it answers from Hudu search now and builds the body index in the background, so a later search is body-aware. Pass "index" to await a complete body-index answer, or "vendor" to force the vendor tier.'
                : 'mode="search" only. THIS TOOL DEFAULTS TO "index" (build or await the body index, so the answer is complete rather than body-blind). "auto" is the SDK default for programmatic callers; "vendor" answers from Hudu search alone.',
          ),
        refresh: z.boolean().optional().describe('mode="search" only. true forces a body-index rebuild before answering.'),
      }),
      outputSchema: SEARCH_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { backingOperation: 'operations.searchKnowledge', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      const mode = args.mode ?? 'search';
      const spec = SEARCH_MODES.find((m) => m.mode === mode);
      if (!spec) {
        return errorContent(
          configError(
            `hudu_search: mode must be one of ${SEARCH_MODES.map((m) => m.mode).join(' | ')} (got ${JSON.stringify(args.mode)}). The mode names in the response are exactly these strings.`,
          ),
        );
      }
      // A field the mode cannot honour is a CONFIG_ERROR naming the fields it does honour.
      const bag = args as Record<string, unknown>;
      const provided = Object.keys(bag).filter((k) => k !== 'mode' && bag[k] !== undefined);
      const unhonoured = provided.filter((k) => spec.rejects.includes(k));
      if (unhonoured.length) {
        return errorContent(
          configError(
            `hudu_search: mode="${mode}" cannot honour ${unhonoured.join(', ')}. It honours: ${spec.fields.join(', ')}. ` +
              (mode === 'search' ? 'mode="help" honours topic if you wanted the help text.' : 'Drop the field, or use the mode that honours it.') +
              ' A field a mode cannot honour is never silently ignored.',
          ),
        );
      }
      if (mode === 'help') {
        const topic = args.topic ?? SEARCH_HELP.default;
        if (!HELP_TOPICS.includes(topic)) {
          return errorContent(configError(`hudu_search: topic must be one of ${HELP_TOPICS.join(' | ')} (got ${JSON.stringify(topic)}).`));
        }
        const composite = (SEARCH_HELP as Record<string, unknown>)[topic];
        const chosen = Array.isArray(composite) ? (composite as string[]) : [topic];
        const sections = SEARCH_HELP.text as Record<string, string>;
        const missing = chosen.filter((s) => !sections[s] || !sections[s].trim());
        if (missing.length) {
          return errorContent(
            configError(`hudu_search help: section(s) missing from SDK catalog: ${missing.join(', ')} (report upstream, do not ship a hollow help channel)`),
          );
        }
        const text = adjustHelpText(ctx, chosen.map((s) => sections[s]).join('\n\n'));
        // The full prose goes to the text channel: it is the tool's only self-documenting surface,
        // and an LLM client reads the text channel first. A one-line stub there made help hollow.
        return ok(text, {
          mode: 'help',
          topic,
          help: {
            text,
            sections: chosen,
            bytes: Buffer.byteLength(text, 'utf8'),
            defaults: {
              mode: 'search',
              tier: toolDefaultTier,
              limit: 8,
              snippetChars: 200,
              resources: defaultSearchScope,
            },
            modes: adjustedSearchModes(ctx),
            resourcesDerivedFrom: SEARCH_RESOURCES.derivedFrom,
          },
        });
      }
      if (mode === 'resources') {
        const effective = SEARCH_RESOURCES.searchable.filter((r) => searchableResources.includes(r.resource));
        const excluded = SEARCH_RESOURCES.searchable.filter((r) => !searchableResources.includes(r.resource)).map((r) => r.resource);
        return ok(
          `${effective.length} searchable resource(s) for this deployment` +
            (excluded.length ? `; ${excluded.length} excluded by HUDU_SEARCH_RESOURCES (${excluded.join(', ')})` : '') +
            `; ${SEARCH_RESOURCES.notSearchable.length} resource(s) ignore ?search= silently.`,
          {
            mode: 'resources',
            resources: { ...SEARCH_RESOURCES, count: effective.length, searchable: effective, excludedByPolicy: excluded },
            modes: SEARCH_MODES.map((m) => m.mode),
          },
        );
      }
      // mode === 'search'
      if (typeof args.query !== 'string' || args.query.length === 0) {
        return errorContent(
          configError(
            'hudu_search: mode="search" (the default) requires a non-empty query. It did NOT fall back to help. Call hudu_search({mode:"help"}) for how to use this tool, or hudu_search({mode:"resources"}) for what is searchable.',
          ),
        );
      }
      // The body index is corpus-wide and cannot be scoped. When the deployment excludes a corpus
      // resource, NO index-backed path may run: an explicit "index" or "auto" tier, or `refresh`
      // (which forces a full rebuild), would each walk the excluded endpoint. Refuse them rather
      // than silently downgrading, and never walk a resource the credential may not read.
      if (!indexSearchable && (args.tier === 'index' || args.tier === 'auto' || args.refresh === true)) {
        return errorContent(
          configError(
            'hudu_search: the body index is unavailable because HUDU_SEARCH_RESOURCES excludes articles or assets; its walk is corpus-wide. Use tier:"vendor" without refresh, or restore the corpus resources.',
          ),
        );
      }
      try {
        const result = await ops.searchKnowledge(args.query, {
          // An omitted `resources` resolves to the deployment's default scope, never to the SDK's
          // articles+assets default when those are outside `searchableResources`.
          scope: (args.resources ?? defaultSearchScope) as KnowledgeResource[],
          limit: args.limit,
          snippetChars: args.snippetChars,
          company_id: args.company_id,
          updated_since: args.updated_since,
          min_score: args.min_score,
          exact_only: args.exact_only,
          refresh: args.refresh,
          tier: args.tier ?? toolDefaultTier, // the TOOL's default: "index" under stdio, "auto" under http, "vendor" when the corpus is excluded
        });
        // The engine isolates per-resource failures, so a key Hudu 401s on every resource it
        // asked reaches the caller as a fully "successful" 0-hit result with auth-coded
        // `meta.failed` entries. Every other tool answers that refusal as a clean UNAUTHORIZED
        // 401: an auth failure is never an empty search. A scope where some resource
        // answered keeps the honest partial answer below, failures sanitized.
        if (credentialRefused(result.meta, result.hits)) return unauthorizedContent();
        const incomplete = result.meta.complete ? '' : ` (partial: ${result.meta.reasons.join(', ')})`;
        const bodyBlind = result.meta.degraded ? ` DEGRADED (${result.meta.degraded.reason}): ${result.meta.degraded.advice}` : '';
        // A failed resource is reported as unavailable, never with Hudu's own auth message: the
        // upstream detail names which resource this deployment's credential may not read.
        const failures = sanitizeSearchFailures(result.meta.failed);
        const failedNote = failures.length
          ? ` ${failures.length} resource(s) unavailable: ${failures.map((f) => f.resource ?? 'unknown').join(', ')}.`
          : '';
        return ok(`Found ${result.hits.length} ranked match(es)${incomplete}.${bodyBlind}${failedNote}`, {
          mode: 'search',
          query: args.query,
          hits: result.hits,
          meta: { ...result.meta, errors: failures, failed: failures, index: sanitizeIndexMeta(result.meta.index), mode: 'search' },
        });
      } catch (err) {
        return searchErrorContent(err);
      }
    },
  );
}
