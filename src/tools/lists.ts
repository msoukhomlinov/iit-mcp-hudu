/**
 * tools/lists.ts — the four dedicated bounded list reads: `hudu_list_companies`,
 * `hudu_list_articles`, `hudu_list_assets` and `hudu_list_asset_layouts`.
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
import { errorContent, createResultBuilders } from './results.js';
import { LIST_OUTPUT, LIST_PAGE, LIST_PAGE_SIZE } from './schemas.js';

/**
 * The four dedicated read tools this module registers.
 *
 * Exported so the surface test derives its expected set instead of retyping names: a renamed tool
 * fails the test rather than silently changing what the server advertises.
 */
export const LIST_TOOLS = [
  'hudu_list_companies',
  'hudu_list_articles',
  'hudu_list_assets',
  'hudu_list_asset_layouts',
] as const;

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

/** Register `hudu_list_companies`, `hudu_list_articles`, `hudu_list_assets` and `hudu_list_asset_layouts`, in that order. */
export function registerListTools(server: McpServer, ctx: ToolContext): void {
  const { ok } = createResultBuilders(ctx.huduOrigin);
  const { hudu } = ctx;

  server.registerTool(
    'hudu_list_companies',
    {
      title: 'List Companies',
      description:
        'List ONE bounded page of companies, backed by the fixed operation companies.list. Returns at most page_size rows plus whether more exist; it never pages through the tenant. This tool takes no operation argument and cannot be redirected to a write. Prefer hudu_search or hudu_resolve_any to identify a single company, and hudu_get_company_context to read one. This is the ungated path for the companies.list read; use it rather than the approval-gated hudu_read / hudu_write / hudu_delete.',
      inputSchema: z.object({
        page: LIST_PAGE,
        page_size: LIST_PAGE_SIZE,
        name: z.string().optional().describe('Exact or partial company name.'),
        phone_number: z.string().optional().describe('Company phone number.'),
        website: z.string().optional().describe('Company website.'),
        city: z.string().optional().describe('Company city.'),
        id_number: z.string().optional().describe('Company id number.'),
        state: z.string().optional().describe('Company state.'),
        slug: z.string().optional().describe('Exact company slug.'),
        search: z.string().optional().describe('Free-text search within companies.'),
        id_in_integration: z.string().optional().describe('Vendor-side integration id.'),
        updated_at: z.string().optional().describe('ISO 8601; only companies updated at or after it.'),
      }),
      outputSchema: LIST_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { backingOperation: 'companies.list', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      const { page, page_size, ...filters } = args;
      try {
        assertListReadPermitted('companies.list', 'companies', ctx);
        const answered = await firstPage(
          hudu.companies.listPages({ ...filters, page, page_size }),
        );
        if (answered === null) {
          return ok('No companies matched.', { rows: [], page, page_size, has_more: false, count: 0 });
        }
        const bounded = boundPage(answered, page_size, page, isNonPaginated('companies.list'));
        return ok(
          `${bounded.rows.length} company row(s) on page ${page} (page_size ${page_size}); ${bounded.hasMore ? 'more pages exist' : 'no more pages'}${bounded.note}.`,
          {
            rows: bounded.rows,
            page,
            page_size: answered.page_size,
            has_more: bounded.hasMore,
            count: bounded.rows.length,
          },
        );
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    'hudu_list_articles',
    {
      title: 'List Articles',
      description:
        'List ONE bounded page of knowledge-base articles, backed by the fixed operation articles.list. Returns at most page_size rows plus whether more exist; it never pages through the tenant. This tool takes no operation argument and cannot be redirected to a write. Prefer hudu_search to find an article by text, and hudu_get_article_context to read one. This is the ungated path for the articles.list read; use it rather than the approval-gated hudu_read / hudu_write / hudu_delete.',
      inputSchema: z.object({
        page: LIST_PAGE,
        page_size: LIST_PAGE_SIZE,
        name: z.string().optional().describe('Exact or partial article name.'),
        company_id: z.number().int().positive().optional().describe('Only articles belonging to this company id.'),
        draft: z.boolean().optional().describe('true for drafts, false for published articles.'),
        enable_sharing: z.boolean().optional().describe('Only articles with sharing enabled/disabled.'),
        slug: z.string().optional().describe('Exact article slug.'),
        search: z.string().optional().describe('Free-text search within articles.'),
        updated_at: z.string().optional().describe('ISO 8601; only articles updated at or after it.'),
      }),
      outputSchema: LIST_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { backingOperation: 'articles.list', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      const { page, page_size, ...filters } = args;
      try {
        assertListReadPermitted('articles.list', 'articles', ctx);
        const answered = await firstPage(
          hudu.articles.listPages({ ...filters, page, page_size }),
        );
        if (answered === null) {
          return ok('No articles matched.', { rows: [], page, page_size, has_more: false, count: 0 });
        }
        const bounded = boundPage(answered, page_size, page, isNonPaginated('articles.list'));
        return ok(
          `${bounded.rows.length} article row(s) on page ${page} (page_size ${page_size}); ${bounded.hasMore ? 'more pages exist' : 'no more pages'}${bounded.note}.`,
          {
            rows: bounded.rows,
            page,
            page_size: answered.page_size,
            has_more: bounded.hasMore,
            count: bounded.rows.length,
          },
        );
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    'hudu_list_assets',
    {
      title: 'List Assets',
      description:
        'List ONE bounded page of assets across all companies, backed by the fixed operation assets.listAcrossCompanies. Returns at most page_size rows plus whether more exist; it never pages through the tenant. The operation is page-paginated by the vendor (page and page_size are sent upstream), so later pages are reachable by raising page. This tool takes no operation argument and cannot be redirected to a write. Filter by company_id, primary_serial, asset_layout_id or search. Prefer hudu_get_asset_context to read one asset in full, and hudu_search to find one by text. This is the ungated path for both assets.listAcrossCompanies and the company-scoped assets.list read (filter by company_id); use it rather than the approval-gated hudu_read / hudu_write / hudu_delete.',
      inputSchema: z.object({
        page: LIST_PAGE,
        page_size: LIST_PAGE_SIZE,
        company_id: z.number().int().positive().optional().describe('Only assets belonging to this company id.'),
        id: z.number().int().positive().optional().describe('Exact asset id.'),
        name: z.string().optional().describe('Exact or partial asset name.'),
        primary_serial: z.string().optional().describe('Asset primary serial.'),
        asset_layout_id: z.number().int().positive().optional().describe('Only assets using this asset layout id.'),
        archived: z.boolean().optional().describe('true for archived assets, false for active ones.'),
        slug: z.string().optional().describe('Exact asset slug.'),
        search: z.string().optional().describe('Free-text search within assets.'),
        updated_at: z.string().optional().describe('ISO 8601; only assets updated at or after it.'),
      }),
      outputSchema: LIST_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { backingOperation: 'assets.listAcrossCompanies', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      const { page, page_size, ...filters } = args;
      try {
        assertListReadPermitted('assets.listAcrossCompanies', 'assets', ctx);
        const answered = await firstPage(
          hudu.assets.listAcrossCompaniesPages({ ...filters, page, page_size }),
        );
        if (answered === null) {
          return ok('No assets matched.', { rows: [], page, page_size, has_more: false, count: 0 });
        }
        const bounded = boundPage(answered, page_size, page, isNonPaginated('assets.listAcrossCompanies'));
        const rows = bounded.rows;
        return ok(
          `${rows.length} asset row(s) on page ${page} (page_size ${page_size}); ${bounded.hasMore ? 'more pages exist' : 'no more pages'}${bounded.note}.`,
          {
            rows,
            page,
            page_size: answered.page_size,
            has_more: bounded.hasMore,
            count: rows.length,
          },
        );
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    'hudu_list_asset_layouts',
    {
      title: 'List Asset Layouts',
      description:
        'List ONE bounded page of asset layouts, backed by the fixed operation asset_layouts.list. The vendor endpoint honours page but ignores page_size, so a page is the vendor’s own size and is returned whole; page N is always the vendor’s Nth page, so walking page never skips rows. has_more is conservative (true for any non-empty page); stop when a page comes back empty. This tool takes no operation argument and cannot be redirected to a write. Use the name or slug filter to find a layout; asset_layouts is not searchable, so hudu_search cannot return one. Prefer hudu_get_asset_layout to read one layout in full by name or slug. This is the ungated path for the asset_layouts.list read; use it rather than the approval-gated hudu_read / hudu_write / hudu_delete.',
      inputSchema: z.object({
        page: LIST_PAGE,
        name: z.string().optional().describe('Exact or partial asset layout name.'),
        slug: z.string().optional().describe('Exact asset layout slug.'),
        active: z.boolean().optional().describe('true for active layouts, false for archived ones.'),
        updated_at: z.string().optional().describe('ISO 8601; only layouts updated at or after it.'),
      }),
      outputSchema: LIST_OUTPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: { backingOperation: 'asset_layouts.list', sensitive: false, requiresApproval: false },
    },
    async (args) => {
      const { page, ...filters } = args;
      try {
        assertNonSearchableListReadPermitted('asset_layouts.list', ctx);
        // No `page_size` and no client-side cap: `/asset_layouts` ignores `page_size`, so any bound
        // smaller than the vendor page would truncate page N while `page` advanced to the vendor's
        // N+1, leaving the skipped rows unreachable. The page is returned whole —
        // one vendor page is the bound — so page N stays contiguous.
        const answered = await firstPage(hudu.assetLayouts.listPages({ ...filters, page }));
        if (answered === null) {
          return ok('No asset layouts matched.', { rows: [], page, page_size: 0, has_more: false, count: 0 });
        }
        const rows = answered.items;
        return ok(
          `${rows.length} asset layout row(s) on page ${page}; ${answered.hasMore ? 'more pages may exist' : 'no more pages'}.`,
          {
            rows,
            page,
            // The SDK's own page size for the vendor response; the page is returned whole.
            page_size: answered.page_size,
            has_more: answered.hasMore,
            count: rows.length,
          },
        );
      } catch (err) {
        return errorContent(err);
      }
    },
  );
}
