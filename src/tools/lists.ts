/**
 * tools/lists.ts — the dedicated bounded list read `hudu_list(resource)` over companies, articles,
 * assets and asset layouts (one tool since 0.3.0; it replaced four `hudu_list_*` tools to cut the served surface).
 *
 * Each tool wraps exactly ONE fixed registry operation (`companies.list` / `articles.list` /
 * `assets.listAcrossCompanies` / `asset_layouts.list`), takes exactly ONE page, and accepts no
 * operation selector and no nested invocation. They exist so a bounded page of companies, articles,
 * assets or asset layouts is reachable WITHOUT a client-side approval flag that `hudu_read / hudu_write / hudu_delete`
 * carries. The write and credential-read surfaces stay unreachable
 * because the backing operation is a constant, not a caller argument.
 *
 * The SDK still owns dispatch and validation: the typed `listPages` method builds the query,
 * paginates and returns a `Page`, and the handler takes its first yield. Nothing here re-implements
 * paging, retries or validation. The handler *does* re-assert the advertised row bound and page
 * navigation, because the SDK only bounds a page when the vendor honours `page_size`. Three cases:
 *
 * - vendor-paginated and honours `page_size` (`companies.list` / `articles.list` and, since
 *   node-hudu 0.9.2, `assets.listAcrossCompanies`): one `page_size` page, `has_more` trusted as the
 *   SDK computed it;
 * - any operation the registry flags `nonPaginated` (none of the three list tools today): the vendor
 *   returns the whole inventory and `boundPage` renders page N as a client-side window of it;
 * - `asset_layouts.list`: the vendor honours `page` but NOT `page_size` (api-docs 2.45.1), so the
 *   SDK drops `page_size` and pages at the vendor's own size. Exposing a caller `page_size` here
 *   would truncate a vendor page and leave the skipped rows unreachable as `page` advances, so this tool takes no `page_size` and returns the vendor page whole: page N is always
 *   the vendor's Nth page and walking `page` never skips a row. The SDK cannot prove the last page
 *   from one request, so `has_more` is conservative (true for any non-empty page); a caller stops
 *   when a page comes back empty.
 *
 * The deployment's read-edge authority still runs before any request. For the searchable resources
 * (`companies` / `articles` / `assets`) a resource excluded by `HUDU_SEARCH_RESOURCES` is refused
 * (the schema must never advertise a read this credential cannot deliver). `asset_layouts` is
 * deliberately NOT searchable (the SDK declares no vendor text filter for it), so it is not
 * subject to that search-scope gate — it is read through the same reachability as the existing
 * ungated `hudu_get_asset_layout` (`asset_layouts.resolve`) tool. Both the write and secret-read
 * policies are asserted on every fixed operation as defence in depth — today they are no-ops
 * because each operation is a read on a non-credential resource, but a future registry
 * reclassification cannot turn a dedicated tool into an ungated path around them.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { getCapability } from 'node-hudu/capabilities';
import { configError } from 'node-hudu/mcp';
import { assertSecretReadPermitted, assertWritePermitted } from '../policy.js';
import type { ToolContext } from './context.js';
import { ARTICLE_FORMAT_NOTE, errorContent, createResultBuilders } from './results.js';
import { LIST_OUTPUT, LIST_PAGE, MAX_LIMIT, DEFAULT_LIMIT } from './schemas.js';

/** The one dedicated list tool this module registers (exported so tests derive the served set). */
export const LIST_TOOLS = ['hudu_list'] as const;

/** The tool names `hudu_list` replaced; a call to one gets a clear pointer instead of "not found". */
export const RENAMED_LIST_TOOLS = {
  hudu_list_companies: 'companies',
  hudu_list_articles: 'articles',
  hudu_list_assets: 'assets',
  hudu_list_asset_layouts: 'asset_layouts',
} as const;

/** One SDK page, structurally — the shape `listPages` yields. */
interface BoundedPage<T> {
  items: T[];
  page: number;
  page_size: number;
  hasMore: boolean;
}

/**
 * The first page of an SDK page iterator, or `null` when it yielded nothing.
 *
 * `return` on the first yield closes the generator, so the SDK's page loop never issues a second
 * request: the tool is bounded by `page_size`, not by the tenant.
 */
async function firstPage<T>(pages: AsyncIterable<BoundedPage<T>>): Promise<BoundedPage<T> | null> {
  for await (const page of pages) return page;
  return null;
}

/**
 * Enforce the advertised row bound, and supply page navigation when the remote does not.
 *
 * A vendor-paginated operation (`companies.list` / `articles.list` / `assets.listAcrossCompanies`)
 * returns one `page_size` page and the SDK's `hasMore` is trusted as is. An operation the registry
 * flags `nonPaginated` (`maxPageSize: null`) has a vendor that ignores `page`/`page_size` and hands
 * back the whole inventory in one response, so the handler renders page N as the Nth `page_size`
 * window of that response and derives `has_more` from what is left — otherwise `page: 2` would
 * repeat page 1 and `has_more` would stay true forever. Either way the tool never returns more
 * than `page_size` rows, exactly as it advertises.
 */
function boundPage<T>(
  result: BoundedPage<T>,
  pageSize: number,
  requestedPage: number,
  nonPaginated: boolean,
): { rows: T[]; hasMore: boolean; note: string } {
  if (nonPaginated) {
    const start = (requestedPage - 1) * pageSize;
    const rows = result.items.slice(start, start + pageSize);
    const hasMore = result.items.length > start + rows.length;
    return {
      rows,
      hasMore,
      note:
        rows.length < result.items.length
          ? ` — the vendor operation is non-paginated; page ${requestedPage} is a client-side window of the account-wide response`
          : '',
    };
  }
  const truncated = result.items.length > pageSize;
  const rows = truncated ? result.items.slice(0, pageSize) : result.items;
  return {
    rows,
    hasMore: result.hasMore || truncated,
    note: truncated
      ? ' — the remote returned more than page_size; the response was truncated to the advertised bound'
      : '',
  };
}

/** Whether the registry marks this fixed operation non-paginated (the vendor ignores `page_size`). */
function isNonPaginated(operation: string): boolean {
  return getCapability(operation)?.pagination?.nonPaginated === true;
}

/**
 * The deployment's authority over a dedicated list read on a searchable resource, answered before
 * the SDK is called.
 *
 * Mirrors the read-edge policy `hudu_search` / `hudu_resolve_any` already apply: a resource the
 * deployment narrowed away must be refused, never offered and then answered with Hudu's own auth
 * error. The write and secret-read checks are no-ops for `companies.list` / `articles.list` /
 * `assets.listAcrossCompanies` today (they are reads on non-credential resources) but keep the tool
 * honest if that ever changes.
 */
function assertListReadPermitted(operation: string, resource: string, ctx: ToolContext): void {
  const { config, log, searchableResources } = ctx;
  if (!searchableResources.includes(resource)) {
    throw configError(
      `${operation}: resource "${resource}" is excluded by HUDU_SEARCH_RESOURCES; this deployment may read: ${searchableResources.join(', ')}.`,
    );
  }
  assertWritePermitted(operation, getCapability(operation), config, log);
  assertSecretReadPermitted(operation, config, log);
}

/**
 * The deployment's authority over a dedicated list read on a NON-searchable resource.
 *
 * `asset_layouts` declares no vendor text filter, so the SDK does not list it as searchable and
 * `HUDU_SEARCH_RESOURCES` (validated against that searchable set) can never name it. Applying the
 * search-scope gate here would refuse the tool in every deployment, including one that already
 * reaches the same resource through the ungated `hudu_get_asset_layout` (`asset_layouts.resolve`).
 * Reachability therefore follows that existing tool; the write and secret-read policies are still
 * asserted as defence in depth.
 */
function assertNonSearchableListReadPermitted(operation: string, ctx: ToolContext): void {
  const { config, log } = ctx;
  assertWritePermitted(operation, getCapability(operation), config, log);
  assertSecretReadPermitted(operation, config, log);
}


const S = z.string();
const D = (t: z.ZodType, d: string) => t.optional().describe(d);
const ID = z.number().int().positive();

/**
 * One list resource: its fixed backing operation, whether `HUDU_SEARCH_RESOURCES` gates it, whether
 * the vendor honours `page_size`, and the exact filter set it accepts. A filter outside that set is
 * refused with the accepted names, never dropped: a silently-stripped `company_id` would turn a
 * company-scoped request into an account-wide one.
 */
export const LIST_RESOURCES = {
  companies: {
    operation: 'companies.list',
    searchable: true,
    pageSize: true,
    label: 'company',
    filters: z.strictObject({
      name: D(S, 'Exact or partial company name.'), phone_number: D(S, 'Company phone number.'), website: D(S, 'Company website.'),
      city: D(S, 'Company city.'), id_number: D(S, 'Company id number.'), state: D(S, 'Company state.'),
      slug: D(S, 'Exact company slug.'), search: D(S, 'Free-text search within companies.'),
      id_in_integration: D(S, 'Vendor-side integration id.'), updated_at: D(S, 'ISO 8601; only companies updated at or after it.'),
    }),
  },
  articles: {
    operation: 'articles.list',
    searchable: true,
    pageSize: true,
    label: 'article',
    filters: z.strictObject({
      name: D(S, 'Exact or partial article name.'), company_id: D(ID, 'Only articles belonging to this company id.'),
      draft: D(z.boolean(), 'true for drafts, false for published articles.'), enable_sharing: D(z.boolean(), 'Only articles with sharing enabled/disabled.'),
      slug: D(S, 'Exact article slug.'), search: D(S, 'Free-text search within articles.'), updated_at: D(S, 'ISO 8601; only articles updated at or after it.'),
    }),
  },
  assets: {
    operation: 'assets.listAcrossCompanies',
    searchable: true,
    pageSize: true,
    label: 'asset',
    filters: z.strictObject({
      company_id: D(ID, 'Only assets belonging to this company id.'), id: D(ID, 'Exact asset id.'), name: D(S, 'Exact or partial asset name.'),
      primary_serial: D(S, 'Asset primary serial.'), asset_layout_id: D(ID, 'Only assets using this asset layout id.'),
      archived: D(z.boolean(), 'true for archived assets, false for active ones.'), slug: D(S, 'Exact asset slug.'),
      search: D(S, 'Free-text search within assets.'), updated_at: D(S, 'ISO 8601; only assets updated at or after it.'),
    }),
  },
  asset_layouts: {
    operation: 'asset_layouts.list',
    searchable: false,
    pageSize: false,
    label: 'asset layout',
    filters: z.strictObject({
      name: D(S, 'Exact or partial asset layout name.'), slug: D(S, 'Exact asset layout slug.'),
      active: D(z.boolean(), 'true for active layouts, false for archived ones.'), updated_at: D(S, 'ISO 8601; only layouts updated at or after it.'),
    }),
  },
} as const;

export type ListResource = keyof typeof LIST_RESOURCES;
const LIST_RESOURCE_NAMES = Object.keys(LIST_RESOURCES) as [ListResource, ...ListResource[]];

/** The accepted filter names of one resource, for refusals and for `hudu_describe_operation`. */
export const listFilterNames = (resource: ListResource): string[] => Object.keys(LIST_RESOURCES[resource].filters.shape);

/** Register `hudu_list`. */
export function registerListTools(server: McpServer, ctx: ToolContext): void {
  const { ok } = createResultBuilders(ctx.huduOrigin);
  const { hudu } = ctx;
  type Params = Record<string, unknown> & { page: number };
  const pages = (resource: ListResource, params: Params): AsyncIterable<BoundedPage<unknown>> => {
    switch (resource) {
      case 'companies': return hudu.companies.listPages(params as never);
      case 'articles': return hudu.articles.listPages(params as never);
      case 'assets': return hudu.assets.listAcrossCompaniesPages(params as never);
      case 'asset_layouts': return hudu.assetLayouts.listPages(params as never);
    }
  };

  server.registerTool(
    'hudu_list',
    {
      title: 'List Records',
      description:
        'List ONE bounded page of companies, articles, assets (across all companies) or asset_layouts, backed by the fixed operations companies.list / articles.list / assets.listAcrossCompanies / asset_layouts.list. Returns at most page_size rows plus whether more exist; it never pages through the tenant. This tool takes no operation argument and cannot be redirected to a write. ' +
        'Filters go in `filters`; each resource accepts only its own: ' +
        LIST_RESOURCE_NAMES.map((r) => `${r}: ${listFilterNames(r).join(', ')}`).join('; ') +
        '. A filter the resource does not accept is refused naming the accepted ones. asset_layouts takes no page_size (the vendor ignores it): a page is the vendor’s own size, returned whole, has_more is conservative (true for any non-empty page), stop when a page comes back empty. ' +
        'Prefer hudu_search or hudu_resolve_any to identify one record, and the *_context / hudu_get_asset_layout reads to read one in full. This is the ungated path for these reads; use it rather than the approval-gated hudu_read / hudu_write / hudu_delete.' +
        ARTICLE_FORMAT_NOTE,
      inputSchema: z.object({
        resource: z.enum(LIST_RESOURCE_NAMES).describe('Which collection to list.'),
        page: LIST_PAGE,
        page_size: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Rows per page (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}); refused for asset_layouts, never clamped.`),
        filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Resource-specific filters (see the tool description).'),
      }),
      outputSchema: LIST_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const { resource, page, page_size, filters } = args;
      try {
        const spec = LIST_RESOURCES[resource];
        const operation = spec.operation;
        const parsed = spec.filters.safeParse(filters ?? {});
        if (!parsed.success) {
          throw configError(`hudu_list: invalid filters for ${resource}; accepted: ${listFilterNames(resource).join(', ')}. ${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        if (!spec.pageSize && page_size !== undefined) {
          throw configError(`hudu_list: ${resource} takes no page_size (the vendor ignores it); omit it and walk page.`);
        }
        if (spec.searchable) assertListReadPermitted(operation, resource, ctx);
        else assertNonSearchableListReadPermitted(operation, ctx);

        if (!spec.pageSize) {
          // No `page_size` and no client-side cap: `/asset_layouts` ignores `page_size`, so any bound
          // smaller than the vendor page would truncate page N while `page` advanced to the vendor's
          // N+1, leaving the skipped rows unreachable. The page is returned whole.
          const answered = await firstPage(pages(resource, { ...parsed.data, page }));
          if (answered === null) return ok('No asset layouts matched.', { rows: [], page, page_size: 0, has_more: false, count: 0 });
          return ok(
            `${answered.items.length} asset layout row(s) on page ${page}; ${answered.hasMore ? 'more pages may exist' : 'no more pages'}.`,
            { rows: answered.items, page, page_size: answered.page_size, has_more: answered.hasMore, count: answered.items.length },
          );
        }
        const size = page_size ?? DEFAULT_LIMIT;
        const answered = await firstPage(pages(resource, { ...parsed.data, page, page_size: size }));
        if (answered === null) return ok(`No ${resource} matched.`, { rows: [], page, page_size: size, has_more: false, count: 0 });
        const bounded = boundPage(answered, size, page, isNonPaginated(operation));
        return ok(
          `${bounded.rows.length} ${spec.label} row(s) on page ${page} (page_size ${size}); ${bounded.hasMore ? 'more pages exist' : 'no more pages'}${bounded.note}.`,
          { rows: bounded.rows, page, page_size: answered.page_size, has_more: bounded.hasMore, count: bounded.rows.length },
        );
      } catch (err) {
        return errorContent(err);
      }
    },
  );
}
