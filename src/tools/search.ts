/**
 * tools/search.ts — `hudu_search`, the one self-describing search tool.
 */
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { KnowledgeIndexMeta, KnowledgeResource } from 'node-hudu';
import { SEARCH_HELP, SEARCH_MODES, SEARCH_RESOURCES, configError } from 'node-hudu/mcp';
import type { ToolContext } from './context.js';
import { errorContent, createResultBuilders, searchErrorContent, unauthorizedContent, upfrontRefusal } from './results.js';
import { HELP_TOPICS, SEARCH_OUTPUT, resourceEnum } from './schemas.js';
import { credentialRefused, sanitizeIndexMeta, sanitizeSearchFailures } from './search-policy.js';
import { adjustHelpText, adjustedSearchModes, searchQueryDescription, searchToolDescription } from './search-prose.js';

/** The first tick is deferred: a fast build should not pay for a notification, but 2s of silence reads as a hang. */
export const PROGRESS_FIRST_TICK_MS = 2_000;

/**
 * How often a waiting call reports elapsed time after that. #52 requires intervals of at most 10 s.
 * The value is 7 s because `setInterval` never fires EARLY: at a 10 s cadence the gap from the 2 s
 * first tick to the next notification is 10 s or slightly more, which sits ON the bound rather than
 * inside it. 7 s keeps every gap (2 s, then 7 s) under the bound with room for timer jitter.
 */
export const PROGRESS_TICK_MS = 7_000;

/** The tool's `limit` default, stated in prose: 1-25, default 8. */
export const SEARCH_DEFAULT_LIMIT = 8;

/** A caller's progress token: the spec allows a string or a number, nothing else. */
type ProgressToken = string | number;

/**
 * The abort signal of the request being handled, from the SDK's own context.
 *
 * The SDK types `mcpReq.signal` as always present, but a hand-built context (a direct handler call)
 * need not carry one, so a missing signal simply never cancels.
 */
export function signalOf(ctx: ServerContext | undefined): AbortSignal | undefined {
  return ctx?.mcpReq.signal;
}

/**
 * The progress token this request carried, if it asked for progress at all.
 *
 * A `null`, an object or an absent `_meta` means the caller did not ask: no tick is ever sent, so a
 * client that never opted in sees no notifications.
 */
export function progressTokenOf(ctx: ServerContext | undefined): ProgressToken | undefined {
  const token = ctx?.mcpReq._meta?.progressToken;
  return typeof token === 'string' || typeof token === 'number' ? token : undefined;
}

/**
 * Await `work`, reporting elapsed whole seconds to the caller's progress token while it runs.
 *
 * Time is the only honest measure here: the corpus walk's page count is not observable through the
 * SDK, so the notification carries no `total` and no percentage. A rejected `notify` is swallowed —
 * a client that closed its stream must not fail the search.
 *
 * Cancellation: the SDK's walk has no abort hook, so an aborted request stops AWAITING the walk (the
 * handler returns its honest degraded answer) rather than aborting the walk itself. `work` keeps
 * running in this process; its result is discarded and its rejection is observed so it cannot
 * surface as an unhandled rejection.
 */
export async function awaitWithProgress<T>(
  req: ServerContext | undefined,
  token: ProgressToken | undefined,
  work: Promise<T>,
  log: { debug(msg: string, fields?: Record<string, unknown>): void },
): Promise<{ aborted: false; value: T } | { aborted: true; elapsedMs: number; waited: boolean }> {
  const signal = signalOf(req);
  const started = Date.now();
  if (signal?.aborted === true) {
    void work.catch(() => {});
    // Nothing was awaited or joined here: the caller was already gone. If the caller already created
    // the work promise, its walk keeps running in this process and is not awaited; its rejection is
    // observed so it cannot surface as an unhandled rejection.
    return { aborted: true, elapsedMs: 0, waited: false };
  }
  const tick = (): void => {
    if (token === undefined) return;
    // A notify that throws SYNCHRONOUSLY (a client whose stream is already closed) must not escape a
    // timer callback: an uncaught exception there would take the whole process down.
    try {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      void req?.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress: elapsed, message: `body index build: ${elapsed}s elapsed` } })
        .catch((err: unknown) => log.debug('progress notification rejected; search continues', { error: err instanceof Error ? err.message : String(err) }));
    } catch (err) {
      log.debug('progress notification threw; search continues', { error: err instanceof Error ? err.message : String(err) });
    }
  };
  // The first tick is deferred, then the cadence takes over. Both timers are cleared in `finally`:
  // a settled or cancelled wait must leave nothing running.
  let timer: ReturnType<typeof setInterval> | undefined;
  const first = setTimeout(() => {
    tick();
    timer = setInterval(tick, PROGRESS_TICK_MS);
  }, PROGRESS_FIRST_TICK_MS);
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<{ aborted: true; elapsedMs: number; waited: boolean }>((resolve) => {
      onAbort = () => resolve({ aborted: true, elapsedMs: Date.now() - started, waited: true });
      signal?.addEventListener('abort', onAbort, { once: true });
      // Re-check AFTER registering. An abort that fires between the pre-check above and
      // `addEventListener` is never delivered to a listener added afterwards, so without this the
      // call would miss it and wait the full build. Register-then-check leaves no window.
      if (signal?.aborted === true) onAbort();
    });
    return await Promise.race([work.then((value) => ({ aborted: false as const, value })), aborted]);
  } finally {
    clearTimeout(first);
    if (timer !== undefined) clearInterval(timer);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    void work.catch(() => {});
  }
}


/** The facts a cancelled wait reports: the call's own scope, how long it waited, and its transport. */
export interface CancelledSearch {
  query: string;
  scope: KnowledgeResource[];
  limit: number;
  elapsedMs: number;
  /**
   * Whether this call actually WAITED on a build. `true` means it joined a walk that continues in the
   * background; `false` means the request arrived already cancelled, so no build was started or
   * joined and the answer must not claim one.
   */
  waited: boolean;
  /**
   * Which tier advice the caller can act on. Under `stdio` the caller holds `tier`, so "vendor" is
   * an immediate alternative. Under `http` no tier is served: on the waited path the body index
   * keeps building in the background, so the honest advice is to retry and get a body-backed answer;
   * on the waited:false path the advice is to retry with a fresh call.
   */
  transport: 'stdio' | 'http';
}

/**
 * The answer a cancelled wait gets: a complete, honest DEGRADED result, never a throw.
 *
 * The caller's request was cancelled before a body search ran — either while the body index was
 * still building (the waited path) or before it started (the already-cancelled path). `hits: []`
 * with `meta.complete: false` and the in-vocabulary `meta.degraded` reason
 * (`body-not-indexed`, because that is factually what was not searched) says exactly that; the
 * cancellation itself is recorded in `meta.cancelled`, and the advice names the
 * alternative the CALLER's transport actually serves instead of inviting a silent retry loop:
 * `tier:"vendor"` under stdio, a retry under http (where no tier field is served and a later search
 * is body-backed).
 *
 * `waited` decides what the text may claim about the build. A call that joined a build reports that
 * the walk continues in the background; a call that arrived already cancelled started and joined
 * nothing, so it says that instead and points at a fresh call rather than a build already running.
 *
 * Shared with the raw invoke path (`hudu_read` of `operations.searchKnowledge`), which can wait on
 * the same walk and must answer a cancellation the same honest way. It returns the text and data
 * rather than a built result so each caller keeps its own result builder and envelope.
 */
export function cancelledSearchContent(cancel: CancelledSearch): { text: string; data: Record<string, unknown> } {
  const { query, scope, limit, elapsedMs, waited, transport } = cancel;
  const hits: unknown[] = [];
  // The SDK's own normalisation is not reachable here (no result was produced), so the terms are the
  // query's raw split rather than a claim about what the engine would have matched.
  const terms = query.trim().split(/\s+/).filter((term) => term.length > 0);
  // The SDK's KnowledgeIndexMeta, exactly: status()-only fields (watermarks, requestsLastBuild,
  // lastBuildError) are not part of it and would misstate what an answer knows. The SDK types
  // builtAt/ageMs as optional, so they are OMITTED here: no generation was scored, so publishing a
  // null for either would describe a generation instead of saying there is none. `docs` is a
  // required record, so it stays an empty object — "no generation recorded", never "zero documents".
  const index: KnowledgeIndexMeta = {
    state: waited ? 'refreshing' : 'cold',
    staleness: 'unknown',
    docs: {},
    indexChangedSinceScore: false,
    lastFullAt: null,
    lastCompleteFullAt: null,
    fullWalkDue: false,
  };
  // What is TRUE here: no answer was scored and nothing was returned. On the waited path the walk
  // this call joined is Hudu traffic and keeps issuing requests after the answer
  // (`awaitWithProgress` only stops AWAITING it), so the text says so rather than claim a quiet
  // network. On the waited:false path the call arrived already cancelled: it started or joined no
  // build, so the text must not claim a background walk. Transport-aware: the two paths serve
  // different fields and different next steps.
  const buildSentence = waited
    ? 'The build this call started continues in the background, still issuing Hudu requests.'
    : 'No build was started or joined for this call: it arrived already cancelled.';
  const nextStep =
    transport === 'http'
      ? waited
        ? 'retry — the body index keeps building in the background, so a later search is body-backed.'
        : 'retry — a fresh call will build or join the index when the caller retries, so a later search is body-backed.'
      : waited
        ? 'retry, or ask for tier:"vendor" for an immediate body-blind answer.'
        : 'retry — a fresh call will build or join the index when the caller retries; tier:"vendor" answers immediately, body-blind.';
  const opening = waited
    ? 'Search cancelled while waiting for the body index build: no answer was scored and nothing was returned.'
    : 'Search cancelled before the body index build: no answer was scored and nothing was returned.';
  const text = `${opening} ${buildSentence} DEGRADED (body-not-indexed): ${nextStep}`;
  // The timings are stated as what they are, not as a quiet network: `vendorMs` is 0 because no
  // vendor-tier scoring happened, the wait is `localMs`, and the request count is NOT tracked for a
  // cancelled wait (the SDK counts requests inside a call it completes; this one never completed).
  const adviceOpening =
    waited
      ? transport === 'http'
        ? 'The request was cancelled while the body index built, so article bodies were not scored. Retry: the body index keeps building in the background, so a later search is body-backed.'
        : 'The request was cancelled while the body index built, so article bodies were not scored. Retry, or use tier:"vendor" for an immediate body-blind answer.'
      : transport === 'http'
        ? 'The request arrived already cancelled, so no body-index build was started or joined and article bodies were not scored. Retry: a fresh call will build or join the index when the caller retries, so a later search is body-backed.'
        : 'The request arrived already cancelled, so no body-index build was started or joined and article bodies were not scored. Retry: a fresh call will build or join the index when the caller retries, or use tier:"vendor" for an immediate body-blind answer.';
  const advice =
    adviceOpening +
    ' timings.localMs is the local body-index wait this call spent (the wait is local time, so it is reported there); timings.vendorMs is 0 because no vendor-tier scoring ran; request counts are NOT TRACKED for a cancelled wait: timings.requests is ALWAYS 0 as a placeholder (the SDK type requires a number), so it is not a count of Hudu requests.' +
    ' meta.cancelled records this cancellation ({ during: "index-build", waited }); meta.reasons stays empty because no bound bit — the answer was cancelled, not bounded.';
  return {
    text,
    data: {
      mode: 'search',
      query,
      resources: scope,
      hits,
      meta: {
        mode: 'search',
        query,
        terms,
        resources: scope,
        scanned: 0,
        returned: 0,
        limit,
        complete: false,
        // No BOUND bit: `reasons` is the SDK's list of bounds that bit, and a cancellation is an
        // event, not a bound. The cancellation has its own field (`meta.cancelled`), so the answer
        // stays truthful without inventing a reason code.
        reasons: [],
        // `cancelled` is a deliberate SERVER extension, not SDK vocabulary: the SDK's KnowledgeSearchMeta
        // has no cancellation field. It travels in the open `meta` object beside the SDK fields.
        cancelled: { during: 'index-build', waited },
        // `reason` stays inside the SDK's closed union (`no-index | vendor-only | body-not-indexed`).
        degraded: {
          reason: 'body-not-indexed',
          advice,
        },
        errors: [],
        failed: [],
        // `localMs` is the SDK's LOCAL time, not vendor time. Nothing was scored here, but the
        // local body-index wait IS local time this call spent, so it is reported as such rather than
        // zeroed; `meta.cancelled` records it. `vendorMs` is 0 because no
        // vendor tier was scored. `requests` cannot be honest: the SDK counts a completed call's
        // requests, this one never completed. On the waited path the walk this call joined keeps
        // issuing requests in the background; on the waited:false path no walk was started or
        // joined. Either way the field stays at its only representable value (the type requires a
        // number; 0 means "always 0 for a cancelled wait", not "no requests were made") and the answer text says the count is NOT TRACKED for a cancelled wait.
        timings: { vendorMs: 0, localMs: elapsedMs, requests: 0 },
        scoreScope: 'per-resource',
        // Serialised size of the (empty) hits array, as the SDK reports it for a real answer.
        bytes: Buffer.byteLength(JSON.stringify(hits), 'utf8'),
        // No generation was scored, so nothing about one is claimed — not even a null builtAt/ageMs
        // pair ("no generation recorded" is said by their absence). "refreshing" only when this
        // call actually joined a build. "cold" is reported when this call observed no generation,
        // which includes the already-cancelled entry: a WARM stdio index is possible in the process,
        // and this answer does not claim otherwise.
        index,
        indexAge: null,
      },
    },
  };
}

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
  const { ops, searchableResources, defaultSearchScope, indexSearchable, toolDefaultTier, searchTierIsPolicy, log } = ctx;
  // Under `http` the tier/refresh fields are not served; the object stays LOOSE there so a caller
  // that still sends one reaches the handler and is TOLD it was overridden (meta.policyOverride)
  // instead of being rejected before the policy path can answer. Under `stdio` every field is
  // served, so the object stays STRICT: an unknown argument is refused, never silently ignored.
  const inputFields = {
        mode: z
          .enum(['search', 'help', 'resources'])
          .default('search')
          .describe('search|help|resources; help documents fields'),
        query: z
          .string()
          .min(1)
          .optional()
          .describe(searchQueryDescription(ctx)),
        // Omitting `resources` searches every resource the deployment may read, which is exactly the
        // enum below plus the `resources` mode's list, so the field carries no prose of its own.
        resources: z
          .array(resourceEnum(searchableResources))
          .optional()
          .describe('Default: all searchable; enum lists it'),
        topic: z
          .enum(HELP_TOPICS as [string, ...string[]])
          .optional()
          .describe('help only; "all" adds syntax'),
        limit: z.number().int().min(1).max(25).optional().describe('1-25, default 8; larger is CONFIG_ERROR'),
        snippetChars: z.number().int().min(0).max(400).optional().describe('0 = no snippet.'),
        company_id: z.number().int().positive().optional().describe('One company'),
        updated_since: z.string().optional().describe('ISO timestamp; newer only'),
        min_score: z
          .number()
          .optional()
          .describe(
            '0-100; 0 hits may be floor/filter; meta.scanned/meta.returned; company_id/updated_since; drops uncounted.',
          ),
        exact_only: z.boolean().optional().describe('No fuzzy match.'),
        // Under `http` neither field is served: the tier decides whether a call may wait for a
        // corpus-wide walk, and the calling model can observe neither the index's warmth nor the
        // walk's duration. The deployment sets it (HUDU_SEARCH_TIER_POLICY) instead. The http
        // object is LOOSE so a caller that sends either field anyway still reaches the handler,
        // which reports it as overridden (`meta.policyOverride`) exactly as the invoke path does.
        // That looseness is DELIBERATE and http-only (CHANGELOG, "0.6.0"); `stdio` keeps the
        // object strict because it serves both fields and has nothing to report.
        ...(searchTierIsPolicy
          ? {}
          : {
              tier: z
                .enum(['auto', 'vendor', 'index'])
                .optional()
                .describe(
                  !indexSearchable
                    ? '"vendor" only here: articles or assets are excluded, so "index", "auto" and refresh:true are refused (the walk is corpus-wide).'
                    : toolDefaultTier === 'auto'
                      ? 'Defaults to "auto"; "index" waits; "vendor" is body-blind.'
                      : toolDefaultTier === 'vendor'
                        ? 'Defaults to "vendor" (policy); "index" waits; "auto" builds.'
                        : 'Defaults to "index": builds or awaits the body index. "vendor" is body-blind.',
                ),
              refresh: z
                .boolean()
                .optional()
                .describe(
                  'rebuilds local body index (stdio only; no Hudu change).',
                ),
            }),
  };
  server.registerTool(
    'hudu_search',
    {
      title: 'Search Hudu (search | help | resources)',
      description: searchToolDescription(ctx),
      // http: loose (report an override rather than reject the field); stdio: strict (all fields served).
      inputSchema: searchTierIsPolicy ? z.object(inputFields).loose() : z.object(inputFields).strict(),
      outputSchema: SEARCH_OUTPUT,
      // readOnlyHint stays true: the hint describes the TARGET SYSTEM (Hudu), which this tool never
      // writes. `refresh` rebuilds this process's local body index — a cache — and changes nothing in
      // Hudu, so a rebuild is still a read of the tenant.
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args, req) => {
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
      // The tier and refresh this call may use. Under `http` both are deployment policy (the schema
      // omits them); under `stdio` the caller's own value wins, defaulting to the tool's tier.
      const tier = searchTierIsPolicy ? toolDefaultTier : ((args as { tier?: 'auto' | 'vendor' | 'index' }).tier ?? toolDefaultTier);
      const refresh = searchTierIsPolicy ? false : (args as { refresh?: boolean }).refresh;
      // Under `http` the served schema omits both fields, but the object is loose: a client may still
      // send them. They are deployment policy, so they are ignored — and SAID to be, with the same
      // `meta.policyOverride` the invoke path reports, never stripped in silence.
      const overridden =
        searchTierIsPolicy && ((args as { tier?: unknown }).tier !== undefined || (args as { refresh?: unknown }).refresh !== undefined);
      // Which of the two fields the caller actually sent, for `meta.policyOverride.stripped`.
      const stripped = (['tier', 'refresh'] as const).filter((field) => (args as Record<string, unknown>)[field] !== undefined);
      // The body index is corpus-wide and cannot be scoped. When the deployment excludes a corpus
      // resource, NO index-backed path may run: an explicit "index" or "auto" tier, or `refresh`
      // (which forces a full rebuild), would each walk the excluded endpoint. Refuse them rather
      // than silently downgrading, and never walk a resource the credential may not read.
      if (!indexSearchable && (tier === 'index' || tier === 'auto' || refresh === true)) {
        return errorContent(
          configError(
            'hudu_search: the body index is unavailable because HUDU_SEARCH_RESOURCES excludes articles or assets; its walk is corpus-wide. Use tier:"vendor" without refresh, or restore the corpus resources.',
          ),
        );
      }
      try {
        const refused = upfrontRefusal();
        if (refused !== undefined) return refused;
        const scope = (args.resources ?? defaultSearchScope) as KnowledgeResource[];
        // Only these two paths can WAIT on a corpus walk: an explicit "index" answer and a forced
        // rebuild. "auto" answers at once (it warms in the background) and "vendor" never touches the
        // index, so neither may emit progress. Warmth is not observable through the SDK (there is no
        // engine-status accessor), so a warm index costs one immediate tick and nothing more — the
        // ticker stops the moment the promise settles.
        // Transport-independent on purpose: `http` usually forces `refresh` false and the tier to
        // "auto", but HUDU_SEARCH_TIER_POLICY=index makes even that caller wait, and a wait must
        // always have progress and cancellation.
        const searchWaits = tier === 'index' || refresh === true;
        // The abort check precedes the work: `ops.searchKnowledge()` starts a build, so creating it
        // first would report a cold index for a request whose build this process had already begun.
        // Nothing is started for a caller that is gone.
        if (searchWaits && signalOf(req)?.aborted === true) {
          const cancelled = cancelledSearchContent({ query: args.query, scope, limit: args.limit ?? SEARCH_DEFAULT_LIMIT, elapsedMs: 0, waited: false, transport: ctx.config.MCP_TRANSPORT });
          return ok(cancelled.text, cancelled.data);
        }
        const work = ops.searchKnowledge(args.query, {
          // An omitted `resources` resolves to the deployment's default scope, never to the SDK's
          // articles+assets default when those are outside `searchableResources`.
          scope,
          limit: args.limit,
          snippetChars: args.snippetChars,
          company_id: args.company_id,
          updated_since: args.updated_since,
          min_score: args.min_score,
          exact_only: args.exact_only,
          refresh,
          tier, // the TOOL's default: "index" under stdio, "auto" under http, "vendor" when the corpus is excluded
        });
        let result;
        if (searchWaits) {
          const awaited = await awaitWithProgress(req, progressTokenOf(req), work, log);
          if (awaited.aborted) {
            const cancelled = cancelledSearchContent({ query: args.query, scope, limit: args.limit ?? SEARCH_DEFAULT_LIMIT, elapsedMs: awaited.elapsedMs, waited: awaited.waited, transport: ctx.config.MCP_TRANSPORT });
            return ok(cancelled.text, cancelled.data);
          }
          result = awaited.value;
        } else {
          result = await work;
        }
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
        const overrideNote = overridden ? ` The ${stripped.join('/')} field(s) this call carried were overridden by the server search tier policy.` : '';
        return ok(`Found ${result.hits.length} ranked match(es)${incomplete}.${bodyBlind}${failedNote}${overrideNote}`, {
          mode: 'search',
          query: args.query,
          hits: result.hits,
          meta: {
            ...result.meta,
            // `reasons` is the SDK's list of BOUNDS that bit; a deployment policy override is not a
            // bound, so it is reported in its own field and does not touch `reasons` or `complete`.
            ...(overridden ? { policyOverride: { stripped, appliedTier: tier } } : {}),
            errors: failures,
            failed: failures,
            index: sanitizeIndexMeta(result.meta.index),
            mode: 'search',
          },
        });
      } catch (err) {
        return searchErrorContent(err);
      }
    },
  );
}
