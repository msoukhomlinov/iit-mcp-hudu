/**
 * tools/schemas.ts — the zod input/output schemas and bounds shared by the tool registrations.
 */
import * as z from 'zod/v4';
import { SEARCH_HELP } from 'node-hudu/mcp';

/** Helper `limit` bounds (manifest: "default 25 results, hard maximum 100"). */
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

/**
 * A resource-name enum built from the deployment's effective searchable set.
 *
 * Derived rather than retyped: the SDK publishes the searchable resources, and a second local list
 * would be one more thing to keep in step. Non-empty is a config invariant — `loadConfig` rejects
 * an empty `HUDU_SEARCH_RESOURCES` — and the tuple cast is how zod is told that.
 */
export function resourceEnum(resources: readonly string[]) {
  return z.enum([...resources] as [string, ...string[]]);
}

/**
 * The topics `mode="help"` accepts: the SDK's text sections plus its composites (`core`, `all`).
 *
 * `SEARCH_HELP.sections` lists only the text sections; the composites that select several of them
 * (`core`, the SDK's `default`, and `all`) are separate keys, not section names. Validating against
 * `sections` alone rejected the tool's own documented default. Derived from the SDK so a new section
 * or composite cannot drift out of the enum.
 */
const HELP_COMPOSITES: string[] = Object.entries(SEARCH_HELP)
  .filter(([key, value]) => key !== 'sections' && Array.isArray(value))
  .map(([key]) => key);
export const HELP_TOPICS: string[] = [...SEARCH_HELP.sections, ...HELP_COMPOSITES];

/** Every read tool's bound, stated identically everywhere. */
export const LIMIT = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .default(DEFAULT_LIMIT)
  .describe('Maximum rows returned (1-100, default 25). A larger value throws CONFIG_ERROR - the SDK never silently clamps.');

export const EXPAND = z
  .boolean()
  .default(false)
  .describe('Return the full typed records instead of the compact summaries (default false).');

/** Accepts a bare id/name/slug or the identifier object the resource documents. */
export const IDENTIFIER = z.union([
  z.number().int().positive(),
  z.string().min(1),
  z.object({
    id: z.number().int().positive().optional().describe('Numeric id - the direct fetch.'),
    name: z.string().optional().describe('Exact name.'),
    slug: z.string().optional().describe('Exact slug.'),
    external_id: z.string().optional().describe('Vendor-side external id.'),
    domain: z.string().optional().describe('Domain, for resources that have one.'),
  }),
]);

/** `assets.resolve` / `assets.getContext` also accept a primary serial and a company scope. */
export const ASSET_IDENTIFIER = z.union([
  z.number().int().positive(),
  z.string().min(1),
  z.object({
    id: z.number().int().positive().optional(),
    companyId: z.number().int().positive().optional(),
    name: z.string().optional(),
    slug: z.string().optional(),
    primary_serial: z.string().optional(),
  }),
]);

/**
 * Row shape of a compact summary (`CompanySummary`, `ArticleSummary`, …).
 *
 * Stays loose on purpose: the exact kept/dropped field list is published per resource in
 * MCP_TOOL_MANIFEST.md (`outputSchema.drops`). Restating it here would add ~15 fields of JSON
 * schema per resource for no extra information the model does not already have.
 */
export const ROWS = z.array(z.unknown());

/** One resolved record: `found: false` is a complete answer, not an error. */
export const ONE_OUTPUT = z.object({ found: z.boolean(), record: z.unknown() });

/**
 * `page` for the dedicated list tools.
 *
 * The SDK pages from here (`companies.listPages` / `articles.listPages`), and the tool returns this
 * single page only — it never follows `has_more`.
 */
export const LIST_PAGE = z
  .number()
  .int()
  .min(1)
  .default(1)
  .describe('Page number to fetch (1-based, default 1). This tool returns that one page and never follows it.');

/**
 * `page_size` for the dedicated list tools.
 *
 * Bounded by the registry record's `maxPageSize` (100). A larger value is refused by the schema,
 * never silently clamped, so a caller cannot make one call walk the whole tenant.
 */
export const LIST_PAGE_SIZE = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .default(DEFAULT_LIMIT)
  .describe(`Rows per page (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}). The registry record caps a page at ${MAX_LIMIT}; a larger value is refused, never clamped.`);

/** One bounded list page: the rows plus the pagination the SDK actually answered with. */
export const LIST_OUTPUT = z.object({
  rows: ROWS,
  page: z.number(),
  page_size: z.number(),
  has_more: z.boolean(),
  count: z.number(),
});

/** A cross-resource result; `truncated` names resources whose scan hit its cap (undecided). */
export const HITS_OUTPUT = z.object({
  hits: ROWS,
  total: z.number(),
  truncated: z.array(z.string()),
  scanned: z.number(),
});

/**
 * `hudu_search` returns ONE shape per mode, each echoing the mode that ran, so a response can never
 * be misread as another mode's.
 */
export const SEARCH_OUTPUT = z.union([
  z.object({ mode: z.literal('search'), query: z.string(), hits: ROWS, meta: z.unknown() }),
  z.object({ mode: z.literal('help'), topic: z.string(), help: z.unknown() }),
  z.object({ mode: z.literal('resources'), resources: z.unknown(), modes: z.array(z.string()) }),
]);

/** A bundled context read (`getContext`). */
export const CONTEXT_OUTPUT = z.object({ context: z.unknown() });

/** A catalog page (`hudu_list_operations`): counts plus the rows the filters matched. */
export const CATALOG_OUTPUT = z.object({
  total_operations: z.number(),
  reachable_operations: z.number(),
  unexposed_operations: z.number(),
  unreachable_operations: z.number(),
  matched: z.number(),
  offset: z.number(),
  limit: z.number(),
  has_more: z.boolean(),
  rows: ROWS,
});

/** An `hudu_read / hudu_write / hudu_delete` result: `simulated: true` means the dry-run path ran and nothing was written. */
export const INVOKE_OUTPUT = z.object({ simulated: z.boolean(), operation: z.string(), result: z.unknown() });
