/**
 * tools/search-prose.ts — the policy-adjusted search prose: tool and field descriptions, help text,
 * and the `operations.searchKnowledge` rows `hudu_describe_operation` and `hudu_list_operations` serve.
 */
import { SEARCH_MODES, SEARCH_RESOURCES, TOOL_DESCRIPTIONS } from 'node-hudu/mcp';
import type { ToolContext } from './context.js';
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
  const { defaultSearchScope, indexSearchable, toolDefaultTier } = ctx;
  const tier = !indexSearchable
    ? 'tool default "vendor"; "index", "auto" and refresh are refused because HUDU_SEARCH_RESOURCES excludes articles or assets.'
    : toolDefaultTier === 'auto'
      ? 'tool default "auto" (answers from Hudu search now; builds the body index in the background so a later search is body-aware); "index" waits for a complete body-index answer before returning.'
      : 'tool default "index" (complete answer); "auto" = the SDK default.';
  let adjusted = text
    .replace('default ["articles","assets"].', `default ${JSON.stringify(defaultSearchScope)}.`)
    .replace('tool default "index" (complete answer); "auto" = the SDK default.', tier)
    .replace(SDK_MIN_SCORE_PROMISE, MIN_SCORE_TRUTH);
  if (!indexSearchable) {
    adjusted = adjusted
      .replace(SEARCH_MODES_BODY_PHRASE, narrowedSearchSummary(ctx))
      .replace(SEARCH_DEGRADED_BLOCK, SEARCH_DEGRADED_BLOCK_VENDOR)
      .replace(SEARCH_DEFAULT_INDEX_SENTENCE, SEARCH_DEFAULT_VENDOR_SENTENCE);
  }
  adjusted = adjusted.replace(`\n  ${CREDENTIAL_REDACTION_LINE}`, credentialRedactionLine(ctx));
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
  const { searchableResources, indexSearchable } = ctx;
  const set = new Set(searchableResources);
  const orderedBase = MULTI_WORD_ORDERED.filter((r) => set.has(r));
  const exact = MULTI_WORD_EXACT.filter((r) => set.has(r));
  const body = BODY_INDEXED.filter((r) => set.has(r));
  const vendorSet = indexSearchable
    ? MULTI_WORD_VENDOR_EVERY.filter((r) => set.has(r))
    : [...searchableResources];
  const lines = [MULTI_WORD_START];
  // On the index tier articles/assets score per word (not in order), so they only anchor the
  // ordered list when the deployment has no body index at all.
  const orderedSubjects = orderedBase.length ? orderedBase : indexSearchable ? [] : body;
  if (orderedSubjects.length) {
    const bodyClause = indexSearchable && body.length ? ` (and ${body.join('/')} on tier "vendor")` : '';
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
        (indexSearchable ? '; only articles and assets are also indexed, and there each word scores separately.' : '.'),
    );
    lines.push(MULTI_WORD_RETRY);
  } else if (indexSearchable) {
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
  const { indexSearchable } = ctx;
  if (indexSearchable) return SEARCH_MODES;
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
  const { searchableResources, indexSearchable, toolDefaultTier } = ctx;
  const base = TOOL_DESCRIPTIONS['hudu_search'];
  const searchableSet = new Set(searchableResources);
  const fullSet = searchableSet.size === SDK_SEARCHABLE.length && SDK_SEARCHABLE.every((r) => searchableSet.has(r));
  if (fullSet && toolDefaultTier === 'index') return base;
  const defaultSentence =
    'As a TOOL it defaults to tier "index" (build or await the body index), so the answer is complete rather than body-blind.';
  const replacement = !indexSearchable
    ? 'This deployment excludes articles or assets, so the tool defaults to tier "vendor" and refuses "index", "auto" and refresh.'
    : toolDefaultTier === 'auto'
      ? 'As a TOOL it defaults to tier "auto": it answers from Hudu search now and builds the body index in the background, so a later search is body-aware rather than body-blind. Pass tier:"index" to wait for a complete first answer.'
      : defaultSentence;
  let out = base;
  if (!fullSet) {
    out = out.replace(
      'ranked, fuzzy search over article TITLE and BODY content, asset names, custom-field VALUES and identifiers, plus company/user/group/website names.',
      `ranked, fuzzy search over the resources this deployment may read: ${searchableResources.join(', ')}.`,
    );
  }
  return out.replace(defaultSentence, replacement);
}

/** The `query` field description, adjusted so it does not promise a body search it cannot run. */
export function searchQueryDescription(ctx: ToolContext): string {
  const { indexSearchable, toolDefaultTier } = ctx;
  const base =
    'mode="search" only, and REQUIRED there: omitting it is a CONFIG_ERROR naming mode:"help" (it never falls back to help). Partial words are tolerated; article BODY content is searched. Hudu\'s own search differs by resource. Companies, websites, passwords and assets match the words in order with gaps allowed, so reordering words can miss a record ("acme corp" finds "Acme Corp Pty", "corp acme" may not). Users, groups and password folders match the whole query as one exact phrase, so use one word. Some instances answer from a fuzzy index that returns records matching only some of the words. Indexed articles and assets score each word independently (match.coverage). On a multi-word query, when the full phrase finds nothing, the tool retries the individual words and ranks partial matches lower; match.coverage shows how good a match is. For an exact lookup, search one distinctive word.';
  if (!indexSearchable) {
    return base.replace(
      'article BODY content is searched.',
      'article body content is NOT searched on this deployment (the body index is unavailable); titles, names and field values are.',
    );
  }
  if (toolDefaultTier === 'auto') {
    return base.replace(
      'article BODY content is searched.',
      'article BODY content is searched once the body index has warmed (the tool builds it in the background); the first search may be body-blind.',
    );
  }
  return base;
}

/** Whether the deployment's search set differs from the SDK's full set (or lost the body index). */
function searchPolicyNarrowed(ctx: ToolContext): boolean {
  const { searchableResources, indexSearchable } = ctx;
  const searchableSet = new Set(searchableResources);
  const fullSet = searchableSet.size === SDK_SEARCHABLE.length && SDK_SEARCHABLE.every((r) => searchableSet.has(r));
  return !fullSet || !indexSearchable;
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
  const { searchableResources, defaultSearchScope, indexSearchable, toolDefaultTier } = ctx;
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
      !indexSearchable
        ? 'this deployment excludes articles or assets, so it defaults to tier "vendor" and refuses "index", "auto" and refresh'
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
