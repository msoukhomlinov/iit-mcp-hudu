/**
 * tools/dedicated.ts — map the registry list reads this server also exposes as dedicated ungated
 * tools, and make `hudu_list_operations` / `hudu_describe_operation` tell the truth about that.
 *
 * The SDK's generated catalogue describes the SDK's own curated profile. A list read the SDK curates
 * out (`companies.list`, `articles.list`, `assets.listAcrossCompanies`, `asset_layouts.list`) is
 * published there as `tool: null` with the reason "no tool of its own (curated out as a duplicate
 * outcome) — reachable through hudu_read / hudu_write / hudu_delete". This server does more than that profile: it ships four
 * dedicated bounded ungated list tools for exactly those reads. Left
 * unamended, discovery tells a model that the only path to a company's assets is the approval-gated
 * `hudu_read / hudu_write / hudu_delete`, so a read-only prompt stalls on a human approval. The overlay restates
 * the catalog row and the describe payload with the tool that actually exists here, so discovery
 * recommends the ungated path.
 *
 * The same correction serves the 0.12.0 batch read: the SDK publishes `operations.fetchMany` as
 * `tool: null` with a "curated out" reason while the SDK's own CORE profile registers
 * `hudu_fetch_many`, and this server registers that tool — so discovery names it rather than
 * routing the batch through the approval-gated escape hatch. The batch tool is never
 * search-gated: its resource key is `operations`, which the search scope never narrows.
 *
 * Two truths the overlay must not break:
 *
 * - **A resource the deployment excluded is not advertised.** Under `HUDU_SEARCH_RESOURCES`, the
 *   dedicated `hudu_list_companies` / `_articles` / `_assets` tools refuse a resource the
 *   deployment did not keep (`assertListReadPermitted`), so steering discovery to one would be a
 *   guaranteed `CONFIG_ERROR`. The overlay only names a dedicated tool when its resource is
 *   actually callable in this deployment; otherwise the SDK's own row is left as it stands.
 * - **`unexposed_only` must describe one stable set.** The mapped rows are removed from the SOURCE
 *   collection, never the already-sliced page, so `offset` / `matched` / `has_more` stay coherent
 *   across pages.
 *
 * The overlay *recommends*, it never refuses: a mapped operation may have a parameter surface the
 * dedicated tool does not expose (`assets.list` accepts `include`, which `hudu_list_assets` does
 * not), so `hudu_read / hudu_write / hudu_delete` stays the escape hatch for the long tail. This module only changes what
 * discovery advertises.
 */
import { CATALOG, catalogPage, MAX_CATALOG_LIMIT } from 'node-hudu/mcp';
import type { CatalogPageOptions, CatalogRow, describeOperation } from 'node-hudu/mcp';

/** A page of the generated catalog, as `catalogPage` returns it. */
type CatalogPage = ReturnType<typeof catalogPage>;
/** One operation's description, as `describeOperation` returns it. */
type Described = ReturnType<typeof describeOperation>;

/**
 * The dedicated ungated read tools (the four bounded list reads plus the 0.12.0 batch read), each
 * with the operation it is backed by, the registry reads it covers, and the arguments it
 * accepts.
 *
 * `backingOperation` mirrors the tool's own `_meta.backingOperation`; `covers` names every registry
 * operation the same bounded, ungated read serves **with an argument surface the tool honors**; and
 * `toolArguments` is the tool's own top-level argument set, so `hudu_describe_operation` can present the
 * schema a caller actually calls the tool with rather than the operation's (which may carry an
 * argument the tool would silently strip — `include` for `assets.listAcrossCompanies`). A drift test
 * derives all three from `tools/list`, so a rename or a re-pointed backing operation fails rather
 * than silently under- or over-advertising the ungated path.
 *
 * `assets.list` is deliberately NOT covered even though `hudu_list_assets` reaches the same rows:
 * its registry arguments are `{ companyId, params }`, a nested shape the tool's flat schema would
 * drop, turning a company-scoped request into an account-wide one.
 */
export const DEDICATED_READ_TOOLS = {
  hudu_list_companies: {
    backingOperation: 'companies.list',
    covers: ['companies.list'],
    toolArguments: [
      'page',
      'page_size',
      'name',
      'phone_number',
      'website',
      'city',
      'id_number',
      'state',
      'slug',
      'search',
      'id_in_integration',
      'updated_at',
    ],
  },
  hudu_list_articles: {
    backingOperation: 'articles.list',
    covers: ['articles.list'],
    toolArguments: [
      'page',
      'page_size',
      'name',
      'company_id',
      'draft',
      'enable_sharing',
      'slug',
      'search',
      'updated_at',
    ],
  },
  hudu_list_assets: {
    backingOperation: 'assets.listAcrossCompanies',
    covers: ['assets.listAcrossCompanies'],
    toolArguments: [
      'page',
      'page_size',
      'company_id',
      'id',
      'name',
      'primary_serial',
      'asset_layout_id',
      'archived',
      'slug',
      'search',
      'updated_at',
    ],
  },
  hudu_list_asset_layouts: {
    backingOperation: 'asset_layouts.list',
    covers: ['asset_layouts.list'],
    toolArguments: ['page', 'name', 'slug', 'active', 'updated_at'],
  },
  hudu_fetch_many: {
    backingOperation: 'operations.fetchMany',
    covers: ['operations.fetchMany'],
    toolArguments: ['items'],
  },
} as const;

export type DedicatedReadTool = keyof typeof DEDICATED_READ_TOOLS;

/** `operation` -> the dedicated tool that covers it, flattened from {@link DEDICATED_READ_TOOLS}. */
export const DEDICATED_READ_TOOL_BY_OPERATION = Object.fromEntries(
  Object.entries(DEDICATED_READ_TOOLS).flatMap(([tool, spec]) => spec.covers.map((op) => [op, tool] as const)),
) as Readonly<Record<string, DedicatedReadTool>>;

/**
 * Resources whose dedicated list tool is gated by `HUDU_SEARCH_RESOURCES`.
 *
 * Mirrors `assertListReadPermitted` in `lists.ts`: `companies`, `articles` and `assets` are
 * searchable and can be excluded; `asset_layouts` is not searchable and its tool is reached through
 * the same reachability as the existing `hudu_get_asset_layout`, so it is never gated; the batch
 * read's resource key is `operations`, which the search scope never names, so `hudu_fetch_many`
 * is advertised in every deployment.
 */
const SEARCH_GATED_RESOURCES = new Set(['companies', 'articles', 'assets']);

/** The dedicated tool for `operation`, or `undefined` when the catalogue row is already truthful. */
function dedicatedToolFor(operation: string): DedicatedReadTool | undefined {
  return DEDICATED_READ_TOOL_BY_OPERATION[operation];
}

/**
 * Whether this deployment can actually call `tool`.
 *
 * A gated resource the deployment excluded is refused before any request, so discovery must not
 * advertise the tool for it. `asset_layouts` has no searchable gate and is always callable, and
 * `operations` (the batch read) is not a search scope either.
 */
export function dedicatedToolAdvertised(tool: DedicatedReadTool, searchableResources: readonly string[]): boolean {
  const backingOperation = DEDICATED_READ_TOOLS[tool].backingOperation;
  const resource = backingOperation.slice(0, backingOperation.indexOf('.'));
  return !SEARCH_GATED_RESOURCES.has(resource) || searchableResources.includes(resource);
}

/**
 * How many currently-reachable, currently-unexposed catalogue rows this overlay re-labels.
 *
 * `unexposed_operations` is a global count in `catalogPage`, not a per-page one, so the adjustment
 * is computed from the whole catalogue rather than from the page's own rows. A row the SDK already
 * refused (`reachable: false`) is left alone, as is a row whose resource this deployment excluded —
 * its reason is the refusal, not a missing tool.
 */
function reLabelledUnexposed(searchableResources: readonly string[]): number {
  return CATALOG.filter((row) => {
    const tool = row.reachable === true && row.tool === null ? dedicatedToolFor(row.op) : undefined;
    return tool !== undefined && dedicatedToolAdvertised(tool, searchableResources);
  }).length;
}

/** Re-label one reachable row with its dedicated tool, when this deployment can call it. */
function relabelRow(row: CatalogRow, searchableResources: readonly string[]): CatalogRow {
  const tool = dedicatedToolFor(row.op);
  if (tool === undefined || !dedicatedToolAdvertised(tool, searchableResources)) return row;
  // `reason` exists only on rows without a tool of their own; this row now has one.
  return { ...row, tool, reachable: true, reason: undefined };
}

/**
 * Re-label the mapped catalogue rows with the dedicated tool that covers them.
 *
 * For `unexposed_only`, `catalogPage` filters and slices the SDK's tool-less set before this overlay
 * runs, so the mapped rows are removed from the SOURCE collection by walking the SDK's unexposed
 * pages, then the corrected set is paginated with the caller's own offset/limit. Removing them from
 * the returned page instead would leave `offset` / `matched` / `has_more` describing a set the next
 * page does not continue.
 */
export function applyDedicatedToolCatalog(
  page: CatalogPage,
  options: CatalogPageOptions & { searchableResources: readonly string[] },
): CatalogPage {
  const { searchableResources, unexposed_only } = options;
  const restored = CATALOG.filter((row) => !row.reachable && relabelRow(row, searchableResources).reachable).length;
  page = { ...page, reachable_operations: page.reachable_operations + restored,
    unreachable_operations: page.unreachable_operations - restored };
  const unexposed_operations = page.unexposed_operations - reLabelledUnexposed(searchableResources);

  if (unexposed_only !== true) {
    return { ...page, rows: page.rows.map((row) => relabelRow(row, searchableResources)), unexposed_operations };
  }

  // Walk the SDK's unexposed pages (bounded by the catalogue size) so the corrected set is complete
  // before it is paginated. The walk repeats the caller's effect/resource filters.
  const corrected: CatalogRow[] = [];
  for (let offset = 0; offset < CATALOG.length; offset += MAX_CATALOG_LIMIT) {
    const walked = catalogPage({
      effect: options.effect,
      resource: options.resource,
      unexposed_only: true,
      limit: MAX_CATALOG_LIMIT,
      offset,
    });
    for (const row of walked.rows) {
      const tool = dedicatedToolFor(row.op);
      if (tool === undefined || !dedicatedToolAdvertised(tool, searchableResources)) corrected.push(row);
    }
    if (!walked.has_more) break;
  }

  const rows = corrected.slice(page.offset, page.offset + page.limit);
  return {
    ...page,
    rows,
    matched: corrected.length,
    has_more: page.offset + page.limit < corrected.length,
    unexposed_operations,
  };
}

/**
 * The same correction for `hudu_describe_operation`: a mapped, reachable read names the dedicated tool that
 * exposes it instead of `exposed_tool: null` / "reachable through hudu_read / hudu_write / hudu_delete".
 *
 * The described `input_schema` is narrowed to the arguments the dedicated tool actually accepts, and
 * the operation-specific `example` is dropped, so a caller that follows the describe cannot supply
 * an argument (such as `include`) that the tool would silently strip and get a different result
 *. A raw argument the tool does not expose stays reachable through `hudu_read / hudu_write / hudu_delete`.
 *
 * A row the policy already refused, or whose resource this deployment excluded, keeps its `why_not`:
 * that reason is the truth, and naming a tool would advertise a capability that cannot be called.
 */
export function applyDedicatedToolDescribe(described: Described, searchableResources: readonly string[]): Described {
  const tool = dedicatedToolFor(described.op);
  if (tool === undefined || !dedicatedToolAdvertised(tool, searchableResources)) {
    return described;
  }
  const accepted = DEDICATED_READ_TOOLS[tool].toolArguments as readonly string[];
  const input_schema = Object.fromEntries(
    Object.entries(described.input_schema).filter(([field]) => accepted.includes(field)),
  );
  return {
    ...described,
    reachable: true,
    exposed_tool: tool,
    why_not: null,
    input_schema,
    example: null,
    preferred_when: `Call ${tool} for this read; it accepts exactly the schema shown. Only the bounded arguments shown here are available; the unbounded operation is refused by the dispatchers.`,
  };
}
