/**
 * tools/search-prose.ts — the policy-adjusted search prose: tool and field descriptions, help text,
 * and the `operations.searchKnowledge` rows `hudu_describe_operation` and `hudu_list_operations` serve.
 */
import { SEARCH_MODES, SEARCH_RESOURCES } from 'node-hudu/mcp';
import type { ToolContext } from './context.js';
import { toolDescription } from './tool-prose.js';
import { SEARCH_ACROSS_OPERATION, effectiveAcrossResources, SDK_SEARCHABLE, RESOLVE_ANY_OPERATION, SEARCH_KNOWLEDGE_OPERATION } from './search-policy.js';

/**
 * The SDK help sentences that name the body index or the credential search resources.
 *
 * On a deployment whose `HUDU_SEARCH_RESOURCES` excludes articles/assets the body index is never
 * built, and a resource the policy excludes cannot produce hits. These exact SDK strings are the
 * ones `adjustHelpText` rewrites; matching the SDK text (rather than retyping a section) keeps the
 * full-set deployment verbatim.
 */
const SEARCH_MODES_BODY_PHRASE = 'ranked, fuzzy, snippet-bearing hits over article bodies and record text';
const SEARCH_DEGRADED_BLOCK =
  '  meta.degraded   null when article BODIES were searched. Otherwise {reason, advice}:\n' +
  '                  reason "body-not-indexed"  bodies exist but are not indexed (indexArticles:false, or every\n' +
  '                                             body exceeded maxDocBytes), or the index could not be built.\n' +
  '                  reason "vendor-only"       no index was used, so titles, names, custom-field values and\n' +
  '                                             identifiers were searched and article bodies were NOT.';
const SEARCH_DEGRADED_BLOCK_VENDOR =
  '  meta.degraded   never null on this deployment: HUDU_SEARCH_RESOURCES excludes articles or assets, so no\n' +
  '                  body index is built and every answer is body-blind. The {reason, advice} pair still\n' +
  '                  explains what limited the answer.';
const SEARCH_DEFAULT_INDEX_SENTENCE =
  'This TOOL defaults to tier "index" (build or await the body index), so a\n' +
  '                  cold, body-blind answer is not the default it hands an agent - and when it happens it says so.';
/**
 * The Typesense degraded reasons, in the SDK's union order (@126). ONE literal, read by the prose
 * builder below and by the test that pins it: either side diverging fails its own suite.
 *
 * This server never maps, renames or reorders a reason it receives — it prints `degraded.reason`
 * verbatim, because a renamed reason silently breaks the pairing between the two packages.
 *
 * Which reasons break `complete` is NOT restated here: node-hudu exports `isDisclosureReason()` as
 * the single source of that rule, and this server imports it wherever it explains an incomplete
 * answer (src/tools/search.ts). The list below is only the vocabulary this help text prints.
 */
export const TYPESENSE_DEGRADED_REASONS = [
  'typesense-unavailable',
  'typesense-unauthorized',
  'typesense-query-error',
  'typesense-hits-stale',
  'typesense-hits-unhydratable',
] as const;

export type TypesenseDegradedReason = (typeof TYPESENSE_DEGRADED_REASONS)[number];

/**
 * What the operator must DO about each reason, and why it happened. The `Record` over the union is
 * the exhaustiveness check: a reason added to the constant cannot ship without its action.
 */
const TYPESENSE_REASON_ACTION: Record<TypesenseDegradedReason, { group: string; lines: string[] }> = {
  'typesense-unavailable': {
    group: 'transient',
    lines: [
      'refused or timed out; the answer came from the local index or the',
      'vendor tier. Check the URL, the tunnel, egress.',
    ],
  },
  'typesense-unauthorized': {
    group: 'credential',
    lines: ['the key was rejected; the key is the thing to fix.'],
  },
  'typesense-query-error': {
    group: 'config bug',
    lines: [
      'the COLLECTION NAME or query is wrong (Typesense answered',
      '400/404/422). Fix HUDU_TYPESENSE_*_COLLECTION: this is not an',
      'outage, no cooldown runs, and URL/tunnel advice does not apply.',
    ],
  },
  'typesense-hits-stale': {
    group: 'transient',
    lines: [
      "Hudu's index still holds records this credential can no longer read",
      "(discarded or deleted, awaiting Hudu's reindex): retry later or",
      'widen the query.',
      '403 vs 404 for permission-hidden records is unverified upstream; a 404 is a silent stale drop,',
      'a 403 a surfaced failure (complete:false, meta.errors).',
    ],
  },
  'typesense-hits-unhydratable': {
    group: 'data',
    lines: [
      'candidates exist but cannot be read for structural reasons (asset',
      'with no company_id, deleted layout, no usable id): fix the record or',
      'the layout - the data is the cause, not staleness.',
    ],
  },
};

/** One help-text line per reason, in the constant's order, each labelled with its operator action. */
function typesenseReasonLines(): string {
  return TYPESENSE_DEGRADED_REASONS.map((reason) => {
    const { group, lines } = TYPESENSE_REASON_ACTION[reason];
    const [first, ...rest] = lines;
    return (
      `                    ${`${group}:`.padEnd(13)}"${reason}"`.padEnd(30) +
      `${first}\n` +
      rest.map((line) => `                                              ${line}\n`).join('')
    );
  }).join('');
}

/**
 * The SDK's `meta.degraded` block, extended with the five Typesense reasons and `meta.bodySource`.
 *
 * Applied only when the deployment configured the tier: a deployment without it must keep the SDK
 * text byte-for-byte, because no answer there can carry any of those reasons. node-hudu 0.21.0's
 * degraded-reason union carries all five (#126), so a 0.21.0 answer can produce each; no cast is
 * involved — the reason travels as SDK data and this server never maps or renames it.
 */
const SEARCH_DEGRADED_TYPESENSE_BLOCK =
  '  meta.degraded   null when article BODIES were searched. Otherwise {reason, advice}: `reason` is the\n' +
  '                  SDK\'s own string, passed through unchanged. Our own reasons:\n' +
  '                    "body-not-indexed"           bodies exist but are not indexed (indexArticles:false, or every\n' +
  '                                                body exceeded maxDocBytes), or the index could not be built.\n' +
  '                    "vendor-only"                no body tier was used, so titles, names, custom-field values and\n' +
  '                                                identifiers were searched and article bodies were NOT.\n' +
  '                  The Typesense reasons, in the SDK\'s order, labelled with what YOU do about it:\n' +
  typesenseReasonLines() +
  '  meta.bodySource "index" | "typesense" | "none": which body source produced this answer. "none" means\n' +
  '                  body text was not searched at all on this call.';

const SEARCH_DEFAULT_VENDOR_SENTENCE =
  'This deployment defaults to tier "vendor", so a cold answer is not a failure - and it says so.';
const CREDENTIAL_RESOURCES = ['asset_passwords', 'password_folders'];
const CREDENTIAL_REDACTION_LINE =
  'asset_passwords / password_folders hits are redacted with snippets suppressed (meta.redaction:"credentials").';

/**
 * The SDK's `min_score` promise (the `query` section, node-hudu 0.9.1). It is false on every
 * deployment: the engine's minScore paths are a plain `continue` with no counter, and no meta
 * field carries a dropped count. This is a truth correction, not a policy
 * adjustment, so it is applied unconditionally - even where every other rewrite is the
 * idempotent full-set no-op.
 *
 * The correction must not name the floor as the ONLY cause of a threshold-empty: scanned -
 * returned also counts the hits the company_id, updated_since and scope filters exclude, so the
 * prose names those filters as co-causes.
 */
const SDK_MIN_SCORE_PROMISE =
  'min_score drops weak hits and reports how many it dropped, so a threshold\n  never looks like absence.';
const MIN_SCORE_TRUTH =
  'min_score drops hits below the floor and reports NO count of them, so an empty result can be the\n  floor, not absence. meta.scanned (candidates scored before the floor) separates the two: scanned 0\n  = nothing scored at all; scanned > 0 with returned 0 = candidates scored but none returned - below\n  the floor, or excluded by the company_id, updated_since or scope filters. Lower or drop min_score\n  (or relax those filters) to see what was left out.';

/**
 * The SDK's `QUERY SYNTAX` multi-word paragraph (node-hudu >= 0.9.1): the vendor's per-resource
 * matching semantics, including the per-term vendor fallback. `adjustHelpText` rewrites the
 * paragraph down to the resources this deployment may search; a full-set deployment skips the
 * rewrite and keeps the SDK text byte-for-byte.
 */
const MULTI_WORD_START = 'MULTI-WORD QUERIES on Hudu\'s own search differ by resource and by instance.';
const MULTI_WORD_END = 'For an exact lookup, query one distinctive word.';
const MULTI_WORD_RETRY =
  'When the phrase finds nothing on a resource, the tool retries its two longest words there (vendor request budget permitting) and ranks partial matches lower: check match.coverage before trusting a hit. ' +
  MULTI_WORD_END;
const MULTI_WORD_ORDERED = ['companies', 'websites', 'asset_passwords'];
const MULTI_WORD_EXACT = ['users', 'groups', 'password_folders'];
const MULTI_WORD_VENDOR_EVERY = ['companies', 'users', 'groups', 'websites', 'asset_passwords', 'password_folders'];
const BODY_INDEXED = ['articles', 'assets'];

/** The narrowed-resource description of what a search actually returns. */
function narrowedSearchSummary(ctx: ToolContext): string {
  const { searchableResources } = ctx;
  const resources = searchableResources.join(', ');
  // Credential resources suppress every snippet, so a deployment that can search only those
  // returns no evidence to show; promising "snippet-bearing" hits would teach a false expectation.
  const snippetless = SEARCH_RESOURCES.searchable
    .filter((resource) => searchableResources.includes(resource.resource))
    .every((resource) => !resource.snippetAllowed);
  return snippetless
    ? `ranked, fuzzy hits with snippets suppressed (credentials redaction) over the resources this deployment may read: ${resources}`
    : `ranked, fuzzy, snippet-bearing hits over the resources this deployment may read: ${resources}`;
}

/**
 * Rewrite the SDK's help prose so a narrowed deployment cannot advertise a resource or tier it
 * excludes while the full-set deployment keeps the SDK text byte-for-byte.
 *
 * Three sections carry the excluded capabilities: `limits` (the two defaults, always rewritten to
 * the policy value), `modes`/`degradation` (article-body search and the "index" default, only
 * false when articles or assets are excluded) and `followup` (the credential resources, dropped
 * down to the ones still searchable). Each replacement is idempotent on the full set, so returning
 * the SDK string there is automatic rather than a special case. The one exception is the `min_score`
 * truth correction (SDK_MIN_SCORE_PROMISE): the SDK promises a dropped count the engine
 * never computes, so the correction applies to every deployment, full set included.
 */
export function adjustHelpText(ctx: ToolContext, text: string): string {
  const { defaultSearchScope, bodySearchable, typesenseConfigured, toolDefaultTier, searchTierIsPolicy } = ctx;
  // Order matters: under `http` no tier field is served at all, so a refusal naming "index", "auto"
  // and refresh would describe a schema that does not exist there. The deployment policy comes
  // first; the corpus refusal applies only where the caller holds the field.
  // Said wherever the tier is stated, and only where a body tier is configured: the unset text stays
  // byte-identical. A configured tier that cannot run because the corpus is narrowed must not read
  // as if it runs.
  const corpusResolution =
    typesenseConfigured && !bodySearchable
      ? ' The configured Typesense tier is corpus-wide too, so the corpus gate resolves it to "vendor" as well.'
      : '';
  const tier = searchTierIsPolicy
    ? `tier is this deployment's policy (HUDU_SEARCH_TIER_POLICY: ${toolDefaultTier}), not a call parameter.${corpusResolution}`
    : !bodySearchable
      ? `tool default "vendor"; "index", "auto" and refresh are refused because HUDU_SEARCH_RESOURCES excludes articles or assets.${corpusResolution}`
      : toolDefaultTier === 'auto'
      ? 'tool default "auto" (answers from Hudu search now; builds the body index in the background so a later search is body-aware); "index" waits for a complete body-index answer before returning.'
      : toolDefaultTier === 'vendor'
      ? 'tool default "vendor" (HUDU_SEARCH_TIER_POLICY: answers come from Hudu search alone, so no body tier is built or awaited); "index" waits for one, "auto" builds it in the background.'
      : toolDefaultTier === 'typesense'
      ? 'tool default "typesense": whole-corpus body search through Hudu\'s own Typesense index, so no local index is built or waited for; "index" builds or awaits the local index, "vendor" is body-blind.'
      : `tool default "index" (complete answer); "auto" = the SDK default.${typesenseConfigured ? ' "typesense" searches the whole corpus through Hudu\'s index.' : ''}`;
  let adjusted = text
    .replace('default ["articles","assets"].', `default ${JSON.stringify(defaultSearchScope)}.`)
    .replace('tool default "index" (complete answer); "auto" = the SDK default.', tier)
    .replace(SDK_MIN_SCORE_PROMISE, MIN_SCORE_TRUTH);
  if (!bodySearchable) {
    adjusted = adjusted
      .replace(SEARCH_MODES_BODY_PHRASE, narrowedSearchSummary(ctx))
      .replace(SEARCH_DEGRADED_BLOCK, SEARCH_DEGRADED_BLOCK_VENDOR)
      .replace(SEARCH_DEFAULT_INDEX_SENTENCE, SEARCH_DEFAULT_VENDOR_SENTENCE);
  } else if (typesenseConfigured) {
    // The two new reasons and `meta.bodySource` exist only where the tier is configured, so the
    // unconfigured deployment keeps the SDK text unchanged.
    adjusted = adjusted.replace(SEARCH_DEGRADED_BLOCK, SEARCH_DEGRADED_TYPESENSE_BLOCK);
  }
  adjusted = adjusted.replace(`\n  ${CREDENTIAL_REDACTION_LINE}`, credentialRedactionLine(ctx));
  // Two tool-choice hints the compact served descriptions dropped. They are NOT field guidance, so
  // they belong on this on-demand surface (help costs nothing on `tools/list`) rather than in a
  // schema: which tool pages a collection, and which paths find a record id. The describe surface
  // already steers the four mapped list reads to `hudu_list`; this states it for the caller who
  // reads help instead.
  adjusted +=
    '\n\n  TOOL CHOICE: hudu_list pages companies, articles, assets or asset_layouts and is the ungated' +
    ' path for those reads (hudu_read is the gated escape hatch). To find a record id, use hudu_search or' +
    ' hudu_read <resource>.resolve; hudu_get_article_context takes an article id, not a slug.';
  // The article-format rule the tool descriptions no longer carry: the write-side passthrough is a
  // fact a caller needs BEFORE it writes, and help is the surface with room for it. Byte-for-byte
  // surface cost on `tools/list` is zero, which is why the rule lives here.
  adjusted +=
    '\n\n  ARTICLE FORMAT: a write whose content opens with block HTML (<p>, <div>, <h1>-<h6>, <table>, <ul>/<ol>, <pre>, <blockquote>, <hr>) is sent as HTML instead of being parsed as Markdown.' +
    ' Re-read the stored article with articles.get before editing it.';
  // `refresh` is a stdio-only field: it rebuilds this process's local body index, not anything in
  // Hudu. Help is the one surface where the cost can be stated in full.
  if (!searchTierIsPolicy && bodySearchable) {
    adjusted +=
      '\n\n  refresh=true rebuilds THIS SERVER\'S local body index before answering. It changes nothing in Hudu,' +
      ' can take minutes (the walk is corpus-wide), and is a stdio-only field.';
  }
  // The SDK's multi-word paragraph names every resource, so a narrowed deployment may not keep it
  // verbatim. The full set is true as written, so it is left alone (byte-for-byte, as always here).
  const searchableSet = new Set(ctx.searchableResources);
  const fullSet = searchableSet.size === SDK_SEARCHABLE.length && SDK_SEARCHABLE.every((r) => searchableSet.has(r));
  if (!fullSet) {
    const start = adjusted.indexOf(MULTI_WORD_START);
    const end = adjusted.indexOf(MULTI_WORD_END, start);
    if (start !== -1 && end !== -1) {
      adjusted = adjusted.slice(0, start) + multiWordParagraph(ctx) + adjusted.slice(end + MULTI_WORD_END.length);
    }
  }
  return adjusted;
}

/**
 * The narrowed `QUERY SYNTAX` multi-word paragraph: the same per-resource semantics as the SDK's,
 * limited to the resources this deployment may search. Without the body index, articles and assets
 * are vendor-tier resources like the rest, so they join the vendor list and the ordered list.
 */
function multiWordParagraph(ctx: ToolContext): string {
  const { searchableResources, bodySearchable } = ctx;
  const set = new Set(searchableResources);
  const orderedBase = MULTI_WORD_ORDERED.filter((r) => set.has(r));
  const exact = MULTI_WORD_EXACT.filter((r) => set.has(r));
  const body = BODY_INDEXED.filter((r) => set.has(r));
  const vendorSet = bodySearchable
    ? MULTI_WORD_VENDOR_EVERY.filter((r) => set.has(r))
    : [...searchableResources];
  const lines = [MULTI_WORD_START];
  // On the index tier articles/assets score per word (not in order), so they only anchor the
  // ordered list when the deployment has no body index at all.
  const orderedSubjects = orderedBase.length ? orderedBase : bodySearchable ? [] : body;
  if (orderedSubjects.length) {
    const bodyClause = bodySearchable && body.length ? ` (and ${body.join('/')} on tier "vendor")` : '';
    lines.push(
      `${capitalize(joinList(orderedSubjects))}${bodyClause} match the words in order with gaps allowed, so reordered` +
        ' words can miss a record ("acme corp" finds "Acme Corp Pty", "corp acme" may not).',
    );
  }
  if (exact.length) {
    lines.push(`${capitalize(joinList(exact))} match the whole query as one exact phrase, so use one word.`);
  }
  if (vendorSet.length) {
    lines.push('Some instances answer from a fuzzy index that returns records matching only some words.');
    lines.push(
      `${capitalize(joinList(vendorSet))} are answered by that vendor search on EVERY tier` +
        (bodySearchable ? '; only articles and assets are also indexed, and there each word scores separately.' : '.'),
    );
    lines.push(MULTI_WORD_RETRY);
  } else if (bodySearchable) {
    lines.push('Articles and assets are also indexed, and there each word scores separately.');
  }
  return lines.map((line) => `  ${line}`).join('\n');
}

/** "a", "a and b", "a, b and c" — the SDK list grammar (no Oxford comma). */
function joinList(xs: string[]): string {
  const first = xs[0];
  const last = xs[xs.length - 1];
  if (!first || !last) return '';
  return xs.length === 1 ? first : `${xs.slice(0, -1).join(', ')} and ${last}`;
}

/** Capitalise the joined list's first item, SDK style ("Companies, websites, asset_passwords"). */
function capitalize(list: string): string {
  return list.charAt(0).toUpperCase() + list.slice(1);
}

/** The credential-resource sentence, narrowed to the ones this deployment can still search. */
function credentialRedactionLine(ctx: ToolContext): string {
  const { searchableResources } = ctx;
  const included = CREDENTIAL_RESOURCES.filter((resource) => searchableResources.includes(resource));
  if (included.length === CREDENTIAL_RESOURCES.length) return `\n  ${CREDENTIAL_REDACTION_LINE}`;
  if (included.length === 0) return '';
  return `\n  ${included.join(' / ')} hits are redacted with snippets suppressed (meta.redaction:"credentials").`;
}

/** The structured `help.modes` list, with the same body-index rewrite on the `search` summary. */
export function adjustedSearchModes(ctx: ToolContext) {
  const { bodySearchable } = ctx;
  if (bodySearchable) return SEARCH_MODES;
  return SEARCH_MODES.map((mode) =>
    mode.mode === 'search' ? { ...mode, summary: mode.summary.replace(SEARCH_MODES_BODY_PHRASE, narrowedSearchSummary(ctx)) } : mode,
  );
}

/**
 * The `hudu_search` tool description, policy-adjusted when the deployment narrowed the corpus.
 *
 * The SDK description is the curated default for a full deployment; on a narrowed one it would
 * advertise article-body/asset search and an index default the schema refuses. Only the two
 * sentences the policy falsifies are rewritten; the drift test asserts the rewrite lands.
 */
export function searchToolDescription(ctx: ToolContext): string {
  const { searchableResources, bodySearchable, typesenseConfigured, toolDefaultTier, searchTierIsPolicy } = ctx;
  const base = toolDescription('hudu_search');
  const searchableSet = new Set(searchableResources);
  const fullSet = searchableSet.size === SDK_SEARCHABLE.length && SDK_SEARCHABLE.every((r) => searchableSet.has(r));
  // The early return is the "nothing to rewrite" case, and server-side policy is never nothing:
  // under `http` with HUDU_SEARCH_TIER_POLICY=index on a full corpus the base text would say the
  // TIER is a caller choice ("As a tool it defaults to tier \"index\""), while the field is not
  // served at all. Policy wins over the byte saving (#50 review 7).
  // No `bodySource` clause is added here: on a configured deployment the answer carries the field
  // itself, and naming it in the served description costs bytes on every call while the help text
  // (where a caller looks for `meta`) already documents it. The surface budget is measured.
  if (fullSet && toolDefaultTier === 'index' && !searchTierIsPolicy) return base;
  const defaultSentence = 'defaults to tier "index": body-complete.';
  // Same order as the help text: under `http` the tier field is not served, so the corpus refusal
  // (which names refused field values) would describe a schema the caller never sees.
  const replacement = searchTierIsPolicy
    ? serverPolicyTierSentence(ctx)
    : !bodySearchable
      ? `This deployment excludes articles or assets, so the tool defaults to tier "vendor" and refuses "index", "auto" and refresh.${
          typesenseConfigured
            ? ' The configured Typesense tier is corpus-wide too, so the corpus gate resolves it to "vendor" as well.'
            : ''
        }`
      : toolDefaultTier === 'typesense'
      ? 'defaults to tier "typesense": whole corpus.'
      : toolDefaultTier === 'auto'
      ? 'defaults to tier "auto": answers now, warms the index; "index" waits.'
      : toolDefaultTier === 'vendor'
      ? `defaults to tier "vendor" (HUDU_SEARCH_TIER_POLICY); "index"/refresh:true uses the body index.${typesenseConfigured ? ' "typesense": corpus.' : ''}`
      : defaultSentence;
  let out = base;
  if (!fullSet) {
    // Fail loudly: a stale anchor would keep advertising a search set this deployment refuses.
    const scopeAnchor = 'ranked fuzzy search over article TITLE and BODY, asset names, fields, identifiers.';
    if (!out.includes(scopeAnchor)) throw new Error('hudu_search description: SDK scope sentence changed; update scopeAnchor');
    out = out.replace(scopeAnchor, `ranked fuzzy search over resources this deployment may read: ${searchableResources.join(', ')}.`);
  }
  // Fail loudly, not silently: a missed anchor would advertise a default tier this deployment refuses.
  if (!out.includes(defaultSentence)) throw new Error('hudu_search description: SDK default-tier sentence changed; update defaultSentence');
  return out.replace(defaultSentence, replacement);
}

/**
 * The `hudu_search` tier sentence for a deployment that sets the tier server-side (`http`).
 *
 * The field is not in the served schema there, so the description may not invite a caller to pass
 * one: it describes what the deployment does with the tier it resolved.
 */
function serverPolicyTierSentence(ctx: ToolContext): string {
  const { toolDefaultTier, bodySearchable, typesenseConfigured } = ctx;
  if (toolDefaultTier === 'typesense') {
    return 'Tier is set server-side to "typesense": every call searches the whole corpus through Hudu\'s index.';
  }
  if (toolDefaultTier === 'index') {
    return 'Tier is set server-side to "index": a call waits for a complete body-index answer.';
  }
  if (toolDefaultTier === 'vendor') {
    if (typesenseConfigured && !bodySearchable) {
      // The corpus gate beats a configured "typesense" policy, and the sentence says so where the
      // policy is stated - not in a footnote: a caller must not read "configured" as "it runs".
      return 'Tier is set server-side to "vendor": this deployment excludes articles or assets, so no body tier runs, and the configured Typesense tier is corpus-wide too, so the corpus gate resolves it to "vendor" as well.';
    }
    return 'Tier is set server-side to "vendor": every call answers immediately and no body index is built.';
  }
  return 'Tier is set server-side to "auto": it answers now and warms the body index in the background, so a later search is body-aware; a body-blind answer says so in meta.degraded.';
}

/** The `query` field description, adjusted so it does not promise a body search it cannot run. */
export function searchQueryDescription(ctx: ToolContext): string {
  const { bodySearchable, toolDefaultTier } = ctx;
  const base = 'REQUIRED for mode="search". Partial words fine; article BODY is searched. Multi-word rules: topic="query" (mode="help").';
  if (!bodySearchable) {
    // Fail loudly: a missed anchor would advertise a body search this deployment cannot run.
    if (!base.includes('article BODY is searched.')) throw new Error('searchQueryDescription: base sentence changed; update the anchors');
    return base.replace(
      'article BODY is searched.',
      'article BODY is NOT searched on this deployment (the body index is unavailable); titles, names and field values are.',
    );
  }
  if (toolDefaultTier === 'auto') {
    return base.replace(
      'article BODY is searched.',
      'article BODY is searched once the index warms.',
    );
  }
  return base;
}

/** Whether the deployment's search set differs from the SDK's full set (or lost the body index). */
function searchPolicyNarrowed(ctx: ToolContext): boolean {
  const { searchableResources, bodySearchable } = ctx;
  const searchableSet = new Set(searchableResources);
  const fullSet = searchableSet.size === SDK_SEARCHABLE.length && SDK_SEARCHABLE.every((r) => searchableSet.has(r));
  return !fullSet || !bodySearchable;
}

/** The narrowed-resource rewrites shared by `hudu_describe_operation` and `hudu_list_operations`. */
function narrowedSearchProse(ctx: ToolContext) {
  const { searchableResources } = ctx;
  const resources = searchableResources.join(', ');
  return {
    purpose: (text: string) => text.replace('articles first and assets second', `over the resources this deployment may read (${resources})`),
    preferredWhen: (text: string) =>
      text
        .replace('Preferred over articles.search, assets.search or any resource list', 'Preferred over the per-resource search helpers')
        .replace(
          'a phrase in an article body, a mistyped title, a serial or a custom-field value',
          'a phrase in a searched resource, a mistyped name, or a custom-field value',
        ),
  };
}

/**
 * Policy-adjust the `operations.searchKnowledge` description to the narrowed search set.
 *
 * `hudu_describe_operation` is the deployment-specific discovery surface: if it advertises the SDK's full
 * scope enum, index defaults and resource prose, a model following it submits values the invoke
 * policy rejects or expects capabilities the deployment removed.
 */
export function applySearchDescribePolicy<
  T extends { op: string; input_schema: Readonly<Record<string, unknown>>; usage: string | null; purpose: string | null; preferred_when: string | null },
>(ctx: ToolContext, described: T): T {
  const { searchableResources, defaultSearchScope, bodySearchable, toolDefaultTier, searchTierIsPolicy } = ctx;
  if (described.op !== SEARCH_KNOWLEDGE_OPERATION) return described;
  const narrowed = searchPolicyNarrowed(ctx);
  // The tier default also differs under `http` even when nothing is narrowed, so the discovery
  // surface must be corrected for that too — see {@link toolDefaultTier}.
  if (!narrowed && toolDefaultTier === 'index') return described;
  const prose = narrowedSearchProse(ctx);
  const schema = described.input_schema as { opts?: { fields?: Array<Record<string, unknown>> } };
  const fields = narrowed
    ? schema.opts?.fields?.map((field) =>
        field.name === 'scope' ? { ...field, items: { type: 'string', enum: [...searchableResources] } } : field,
      )
    : schema.opts?.fields;
  const usage = described.usage
    ?.replace('scope defaults to articles and assets', `scope defaults to ${JSON.stringify(defaultSearchScope)}`)
    .replace(
      'it defaults to tier "index" when called as the MCP tool (the SDK default stays lazy)',
      // Policy first, as in the help text: under `http` the field is not served, so naming refused
      // values would describe a schema this caller never sees.
      searchTierIsPolicy
        ? `the tier is this deployment's policy (HUDU_SEARCH_TIER_POLICY: ${toolDefaultTier}), not a call parameter`
        : !bodySearchable
          ? 'this deployment excludes articles or assets, so it defaults to tier "vendor" and refuses "index", "auto" and refresh'
          : toolDefaultTier === 'typesense'
          ? 'it defaults to tier "typesense" when called as the MCP tool: it searches Hudu\'s whole-corpus Typesense index, so no local index is built (the SDK default stays lazy)'
          : toolDefaultTier === 'auto'
          ? 'it defaults to tier "auto" when called as the MCP tool: it answers from Hudu search now and builds the body index in the background (pass tier:"index" to wait for a complete first answer; the SDK default stays lazy)'
          : 'it defaults to tier "index" when called as the MCP tool (the SDK default stays lazy)',
    );
  return {
    ...described,
    input_schema: fields ? { ...schema, opts: { ...schema.opts, fields } } : described.input_schema,
    usage: usage ?? described.usage,
    purpose: narrowed && described.purpose ? prose.purpose(described.purpose) : described.purpose,
    preferred_when: narrowed && described.preferred_when ? prose.preferredWhen(described.preferred_when) : described.preferred_when,
  };
}

/**
 * Policy-adjust the `operations.resolveAny` description to the narrowed search set.
 *
 * `hudu_resolve_any` and its `hudu_read / hudu_write / hudu_delete` parity both reject a resource outside
 * `HUDU_SEARCH_RESOURCES`, so `hudu_describe_operation` must not keep advertising the SDK's full eight-resource
 * enum for the same operation — discovery has to match execution, exactly as it does for
 * `operations.searchKnowledge`.
 */
export function applyResolveDescribePolicy<
  T extends { op: string; input_schema: Readonly<Record<string, unknown>> },
>(ctx: ToolContext, described: T): T {
  const { searchableResources } = ctx;
  if (described.op !== RESOLVE_ANY_OPERATION) return described;
  const searchableSet = new Set(searchableResources);
  const fullSet = searchableSet.size === SDK_SEARCHABLE.length && SDK_SEARCHABLE.every((r) => searchableSet.has(r));
  if (fullSet) return described;
  const schema = described.input_schema as { opts?: { fields?: Array<Record<string, unknown>> } };
  const fields = schema.opts?.fields?.map((field) =>
    field.name === 'resources' ? { ...field, items: { type: 'string', enum: [...searchableResources] } } : field,
  );
  return {
    ...described,
    input_schema: fields ? { ...schema, opts: { ...schema.opts, fields } } : described.input_schema,
  };
}

/**
 * The same adjustment for `hudu_list_operations`, whose row carries the description as `summary`/`when`.
 *
 * The catalog is the other deployment-specific discovery surface; a narrowed row must not still
 * say "articles first and assets second".
 */
export function applySearchCatalogPolicy<T extends { rows: Array<{ op: string; summary: string | null; when: string | null }> }>(ctx: ToolContext, page: T): T {
  if (!searchPolicyNarrowed(ctx)) return page;
  const prose = narrowedSearchProse(ctx);
  const rows = page.rows.map((row) =>
    row.op === SEARCH_KNOWLEDGE_OPERATION
      ? {
          ...row,
          summary: row.summary ? prose.purpose(row.summary) : row.summary,
          when: row.when ? prose.preferredWhen(row.when) : row.when,
        }
      : row,
  );
  return { ...page, rows } as T;
}

/** Advertise the resource enum and omitted-list default that cross-resource invoke enforces. */
export function applyAcrossDescribePolicy<
  T extends { op: string; input_schema: Readonly<Record<string, unknown>>; usage: string | null },
>(ctx: ToolContext, described: T): T {
  if (described.op !== SEARCH_ACROSS_OPERATION) return described;
  const resources = effectiveAcrossResources(ctx);
  const schema = described.input_schema as { opts?: { fields?: Array<Record<string, unknown>> } };
  const fields = schema.opts?.fields?.map((field) =>
    field.name === 'resources'
      ? { ...field, items: { type: 'string', enum: [...resources] }, default: [...resources] }
      : field,
  );
  return {
    ...described,
    input_schema: fields ? { ...schema, opts: { ...schema.opts, fields } } : described.input_schema,
    usage: `${described.usage ?? ''} On this deployment, resources defaults to ${JSON.stringify(resources)}; only these resources are permitted.`,
  };
}
