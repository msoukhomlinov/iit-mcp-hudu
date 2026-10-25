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
import { CATALOG, CORE_TOOLS, catalogPage, MAX_CATALOG_LIMIT } from 'node-hudu/mcp';
import { LIST_RESOURCES, listFilterNames } from './lists.js';
import type { ListResource } from './lists.js';
import type { CatalogPageOptions, CatalogRow, describeOperation } from 'node-hudu/mcp';

/** A page of the generated catalog, as `catalogPage` returns it. */
type CatalogPage = ReturnType<typeof catalogPage>;
/** One operation's description, as `describeOperation` returns it. */
type Described = ReturnType<typeof describeOperation>;

/**
 * The dedicated ungated read tools (`hudu_list` over four registry list reads, plus the batch read
 * `hudu_fetch_many`): the registry operations each covers and the arguments it accepts.
 *
 * `covers` names every registry operation the same bounded, ungated read serves **with an argument
 * surface the tool honors**; `toolArguments` is the tool's own top-level argument set, so
 * `hudu_describe_operation` presents the schema a caller actually calls the tool with rather than
 * the operation's (which may carry an argument the tool would refuse, such as `include` for
 * `assets.listAcrossCompanies`). A drift test compares `toolArguments` with `tools/list` and
 * `covers` with the SDK registry, so a rename or a re-pointed operation fails rather than silently
 * under- or over-advertising the ungated path.
 *
 * `assets.list` is deliberately NOT covered even though `hudu_list` reaches the same rows: its
 * registry arguments are `{ companyId, params }`, a nested shape the tool's flat filters would not
 * carry, turning a company-scoped request into an account-wide one.
 */
export const DEDICATED_READ_TOOLS = {
  hudu_list: {
    // The registry operations `hudu_list(resource)` serves, keyed to the resource it takes.
    covers: ['companies.list', 'articles.list', 'assets.listAcrossCompanies', 'asset_layouts.list'],
    toolArguments: ['resource', 'page', 'page_size', 'expand', 'filters'],
  },
  hudu_fetch_many: {
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
export function dedicatedToolAdvertised(operation: string, searchableResources: readonly string[]): boolean {
  const resource = operation.slice(0, operation.indexOf('.'));
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
    return tool !== undefined && dedicatedToolAdvertised(row.op, searchableResources);
  }).length;
}

/** Re-label one reachable row with its dedicated tool, when this deployment can call it. */
function relabelRow(row: CatalogRow, searchableResources: readonly string[]): CatalogRow {
  const tool = dedicatedToolFor(row.op);
  if (tool === undefined || !dedicatedToolAdvertised(row.op, searchableResources)) return row;
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
      if (tool === undefined || !dedicatedToolAdvertised(row.op, searchableResources)) corrected.push(row);
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
  if (tool === undefined || !dedicatedToolAdvertised(described.op, searchableResources)) {
    return described;
  }
  const input_schema =
    tool === 'hudu_list'
      ? listInputSchema(described.op)
      : Object.fromEntries(
          Object.entries(described.input_schema).filter(([field]) => (DEDICATED_READ_TOOLS[tool].toolArguments as readonly string[]).includes(field)),
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

/**
 * The tools this server serves. The catalogue also maps some operations to SDK tools this server
 * does not register (`asset_passwords.resolve` -> `hudu_get_asset_password`); naming one would send
 * a model to a tool that does not exist, so those rows report no tool of their own.
 */
const SERVED_TOOLS: ReadonlySet<string> = new Set([
  ...CORE_TOOLS,
  ...Object.keys(DEDICATED_READ_TOOLS),
  'hudu_read', 'hudu_write', 'hudu_delete',
]);
const served = (tool: string | null): boolean => tool === null || SERVED_TOOLS.has(tool);

export function nullUnservedToolCatalog(page: CatalogPage): CatalogPage {
  return { ...page, rows: page.rows.map((row) => (served(row.tool) ? row : { ...row, tool: null })) };
}

export function nullUnservedToolDescribe(described: Described): Described {
  return served(described.exposed_tool) ? described : { ...described, exposed_tool: null };
}

/** The `hudu_list` arguments for one covered operation, in the registry's describe shape. */
function listInputSchema(operation: string): Described['input_schema'] {
  const resource = (Object.keys(LIST_RESOURCES) as ListResource[]).find((r) => LIST_RESOURCES[r].operation === operation)!;
  const field = (name: string, type: string, required: boolean, extra: object = {}) => [name, { name, type, required, ...extra }] as const;
  return Object.fromEntries([
    field('resource', 'string', true, { enum: [resource] }),
    field('page', 'integer', false),
    ...(LIST_RESOURCES[resource].pageSize ? [field('page_size', 'integer', false)] : []),
    field('expand', 'boolean', false),
    field('filters', 'object', false, { description: `Accepted keys: ${listFilterNames(resource).join(', ')}.` }),
  ]) as Described['input_schema'];
}
