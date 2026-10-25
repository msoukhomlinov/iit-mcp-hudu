/**
 * tools/tool-prose.ts — the served `description` of every tool, written for THIS server.
 *
 * The SDK's curated descriptions repeat the same paragraphs on every tool (the bound, the article
 * format note, the "prefer X" guidance), so 17 tools cost ~33.7 KB of `tools/list` JSON — ~8.4k
 * tokens every client pays before its first call. Here each tool states what it does and what
 * happens when a bound bites, once; the long tail (per-operation contracts, filter lists, query
 * syntax) stays in the discovery surfaces that exist for it: `hudu_describe_operation`,
 * `hudu_list_operations` and `hudu_search`'s `mode:"help"`.
 *
 * Prose only. No default, bound, refusal code or mode rule may change here; the served weight is
 * asserted in `test/tools/surface-size.test.ts`, so this table cannot silently regrow.
 */

const DESCRIPTIONS: Record<string, string> = {
  hudu_search:
    "Search Hudu first for text discovery. mode=\"search\" (default) runs `query`; \"help\" and \"resources\" explain the tool.\nmode=\"search\": ranked, fuzzy search over article TITLE and BODY content, asset names, custom-field VALUES and identifiers, plus company/user/group/website names. As a tool it defaults to tier \"index\" (builds/awaits the body index), so results are body-complete.\nRead meta.degraded before trusting an empty result; an unhonoured field is a CONFIG_ERROR.",
  hudu_read:
    "Execute READ operations only, by registry key (hudu_list_operations lists them; contract: hudu_describe_operation). input is closed: an unknown field is a CONFIG_ERROR naming the valid ones. Results mask credentials and custom fields. Article bodies: single-article reads are Markdown, other rows stored HTML; a lossy read sets markdown_lossy.",
  hudu_write:
    "Execute a WRITE operation by registry key (hudu_list_operations; contract: hudu_describe_operation). input is closed: an unknown field is a CONFIG_ERROR naming the valid ones. dry_run:true previews without writing; confirm is the SDK confirmation string, not human consent. Article bodies: writes are Markdown; Hudu reshapes API-written HTML on the next UI save.",
  hudu_delete:
    "Execute a DESTRUCTIVE operation by registry key (hudu_list_operations; contract: hudu_describe_operation). input is closed: an unknown field is a CONFIG_ERROR naming the valid ones. dry_run:true previews without deleting; confirm is the SDK confirmation string, not human consent.",
  hudu_list:
    "List ONE bounded page of companies, articles, assets (all companies) or asset_layouts. It takes no operation argument, so it cannot become a write, and it never pages the tenant. Each collection accepts only its own filters (hudu_describe_operation lists them); another is refused naming the accepted ones. Article bodies: compact rows carry none; expand:true returns stored HTML. The ungated read path: prefer it, or hudu_search, over hudu_read.",
  hudu_list_operations:
    "List SDK operations with the tool exposing each, its effect, dry-run/confirm need and required arguments. This server is a curated SUBSET: hudu_describe_operation gives one operation's contract, hudu_read/hudu_write/hudu_delete run it. Bounded 1-100 rows (default 40), offset pages; the catalog is ~10k tokens, so filter or page.",
  hudu_describe_operation:
    "Full input contract, effect, dry-run support, errors and usage for ONE operation, by exact catalog key (never a tool name). An unknown key is a CONFIG_ERROR naming the nearest.",
  hudu_resolve_any:
    "Resolve an identifier across several resources when the resource type is unknown; otherwise call that resource's hudu_get_<singular>. Unreadable resources are listed in `unauthorized`; it fails only if all are refused.",
  hudu_get_api_info:
    "Return the API information document. Prefer api_info.get.",
  hudu_get_company_context:
    "Fetch a company with its bounded context (CompanyContext). Required: numeric `id`, never a name or slug. Without password_access it 401s unless opts.skip omits asset_passwords; a refused sub-list answers UNAUTHORIZED, other failures keep their code.",
  hudu_get_article_context:
    "Fetch an article with its company and folder context (ArticleContext). Pass the numeric `id`, not a slug. Bodies here are Markdown; a refused sub-list answers UNAUTHORIZED, other failures keep their code.",
  hudu_get_asset_context:
    "Fetch an asset with its context (AssetContext). Pass `identifier`: id, name, slug or serial. A refused sub-list answers UNAUTHORIZED; other failures keep their code.",
  hudu_get_asset_layout:
    "Resolve an asset layout from an id, name or slug; asset_layouts.get is cheaper for a known id. expand:true returns the full AssetLayout instead of the compact summary.",
  hudu_get_folder:
    "Resolve a folder from an id or name, optionally company-scoped; folders.get is cheaper for a known id. expand:true returns the full Folder.",
  hudu_get_password_folder:
    "Resolve a password folder from an id or name, optionally company-scoped; password_folders.get is cheaper for a known id. Credential-shaped fields are masked by default.",
  hudu_get_group:
    "Resolve a user group from an id, name or slug; groups.get is cheaper for a known id. expand:true returns the full Group, members included.",
  hudu_find_asset_passwords_by_slug:
    "Find one password record by its URL slug, instead of a full scan. At most one exact match; to enumerate use hudu_search. Credential-shaped fields are masked by default.",
  hudu_find_websites_by_slug:
    "Find one website by its URL slug, instead of a full scan. At most one exact match; to enumerate use hudu_search or hudu_get_website.",
  hudu_fetch_many:
    "Read-only. Fetch up to 20 single records across MIXED resources in ONE call: each item is EXACTLY { resource, id, fields? }. All items are validated first (a CONFIG_ERROR names every problem, zero wire); one failed item never aborts the rest. Article bodies: rows here are stored HTML.",
};

/**
 * The served description of `name`.
 *
 * Throws rather than falling back to an SDK string: a tool added without a line here would silently
 * reintroduce the weight this module exists to remove, so the omission is a startup error.
 */
export function toolDescription(name: string, extra = ''): string {
  const base = DESCRIPTIONS[name];
  if (base === undefined) throw new Error(`tool-prose: no served description for ${name}; add one to DESCRIPTIONS`);
  return extra === '' ? base : `${base} ${extra}`;
}

/** Whether the table has an entry for `name` (the weight test checks the surface against it). */
export function hasToolDescription(name: string): boolean {
  return DESCRIPTIONS[name] !== undefined;
}
