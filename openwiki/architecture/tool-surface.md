---
type: architecture
title: Tool surface and dispatch
description: The MCP tools the server registers, how the read/write/delete dispatchers wrap the SDK, how list, fetch-many and context reads are shaped, and how results and errors are normalised.
tags: [tools, dispatch, mcp, results]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-17T00:09:40.208Z
sources:
  - id: openwiki-source-0c06ba72fda063f5dcf60aa5
    resource: repo://src/tools/article-loss.ts
  - id: openwiki-source-9a2d17e676ec16ff1706784b
    resource: repo://src/tools/dispatch.ts
  - id: openwiki-source-722f049c5a27442f7f8bea5a
    resource: repo://src/tools/fetch-many.ts
  - id: openwiki-source-caa71778fef1e3997835ce38
    resource: repo://src/tools/lists.ts
  - id: openwiki-source-4872d52b3548bd8beadf8680
    resource: repo://src/tools/meta.ts
  - id: openwiki-source-dcd8ff5bada8039faa1aafbe
    resource: repo://src/tools/renamed.ts
  - id: openwiki-source-80c29767ea7514834bb81288
    resource: repo://src/tools/result-urls.ts
  - id: openwiki-source-da6bf1bc1c6d1b4ea2e5ed68
    resource: repo://src/tools/slim.ts
generated: { by: "openwiki/0.9.0", at: "2026-11-17T00:09:40.208Z" }
---

# Tool surface and dispatch

Tools are registered per serving unit by `registerTools` (see [architecture overview](overview.md)) in this order: meta tools, search, read tools, list tool, fetch-many. Tool names and input schemas come largely from the `node-hudu` SDK (`META_TOOLS`, `metaSpec`); the served prose comes from `src/tools/tool-prose.ts`. Search tools are owned by [search tiers](../search/search-tiers.md); the policy gates by [write policy](../security/write-policy.md).

## Tool groups

- **Discovery** (`src/tools/meta.ts`): `hudu_list_operations` pages the SDK capability catalog (`limit` 1-100, default 40; filters `effect`, `resource`, `unexposed_only`) and `hudu_describe_operation` looks up one exact operation key. Both pass the SDK row through deployment-policy rewriting so an operation that is refused here is reported as "NOT callable here" instead of steering the model to a guaranteed failure; an operation with a dedicated tool names it (`exposed_tool`). There is no fuzzy matching: an unknown key raises a config error naming nearby keys.
- **Dispatchers** `hudu_read`, `hudu_write`, `hudu_delete` (`src/tools/dispatch.ts`): one strict-object schema per mode with `operation` (an enum from SDK metadata), optional `input`, and for write/delete `dry_run` and `confirm`. The write and delete tools are only registered when `writeToolRegistered` says so.
- **Dedicated reads** (`src/tools/reads.ts`): `hudu_resolve_any`, `hudu_get_api_info`, the three context reads (`hudu_get_company_context`, `hudu_get_article_context`, `hudu_get_asset_context`), `hudu_get_asset_layout`, `hudu_find_asset_passwords_by_slug`, `hudu_find_websites_by_slug`, `hudu_get_folder`, `hudu_get_password_folder`, `hudu_get_group`.
- **List**: a single `hudu_list` tool over four resources.
- **Batch**: `hudu_fetch_many`.

## Dispatcher flow

For each call the handler in `dispatch.ts`:

1. Asserts write policy, secret-read policy and the "never reachable" set (`assertWritePermitted`, `assertSecretReadPermitted`, `assertNeverReachablePermitted`). These refuse before any request.
2. Rewrites the input for read-edge operations: search-knowledge, resolve-any, search-across and fetch-many each get a policy-applied input bag.
3. Calls the SDK's `dispatchOperation(client, effect, operation, bag, opts)` with `contentFormat: 'markdown'`; `dryRun` and `confirm` are forwarded only when present. The SDK is the single authority for validation, forcing a dry run first on writes, and requiring `confirm` for destructive operations.
4. Post-processes: strips SDK `content_loss` from Markdown article reads into `markdown_lossy` fields (`src/tools/article-loss.ts`; the recovery hint points to `hudu_fetch_many` for the stored HTML), redacts credential fields from `companies.getContext`, sanitises search failure/index metadata, converts an all-resources-401 search into an unauthorized error, and summarises committed (non-dry-run) article writes instead of echoing the record (`article-write-summary.ts`).
5. In `finally`, after a real write/delete attempt (`dry_run === false` and the SDK call was reached), calls `clearCache()` on the read client.

Cache note: each effect mode has its own client with its own read-through cache, so a write does not clear the read client's cache by itself; this explicit clear is why. A write from another process stays TTL-bounded stale. Cache presets are set in the server factory ([overview](overview.md)).

A search that may wait (tier `index` or `refresh:true`) gets progress ticks and an honest "cancelled" answer if the request has been aborted before the SDK walk starts.

Errors are mapped by `errorContent` and variants (`searchErrorContent`, `resolveErrorContent`, `contextErrorContent`): the search/context variants avoid leaking which resources a credential cannot read.

## `hudu_list`

Lists `companies`, `articles`, `assets` or `asset_layouts` one page at a time (`src/tools/lists.ts`). Input is a strict object: `resource`, `page`, optional `page_size`, `expand`, and a closed per-resource `filters` map; unknown filters are refused naming the accepted ones. Page size is capped by `MAX_LIMIT` with `DEFAULT_LIMIT` as default (constants in `src/tools/schemas.ts`), and a larger value is refused, never clamped. `asset_layouts` accepts no `page_size` because the vendor ignores it; its `has_more` is conservative. Searchable resources are subject to the `HUDU_SEARCH_RESOURCES` scope; asset layouts are not. Without `expand`, rows are compacted per resource. Old names `hudu_list_companies`, `hudu_list_articles`, `hudu_list_assets`, `hudu_list_asset_layouts` are answered by `src/tools/renamed.ts` with an error pointing to `hudu_list`; they are never listed.

## `hudu_fetch_many`

Fetches up to 20 records across mixed resources in one call; the item is exactly `{resource, id, fields?}` with a positive integer id and a non-empty `fields` when present. `resource` is a closed enum of 22 names kept in parity with the registry by test. The same secret-read policy wrapper as the `hudu_read` path runs before any request. Items run as individual `get`s and failure is per item: the result is `{ok, failed, results}`, with schema violations refused before any request. It is registered in every mode, including read-only.

## Result shaping

- Every success goes through `ok(...)`, which returns text plus `structuredContent`, with root-relative URL fields (a fixed set such as `url`, `full_url`, `share_url`) rewritten to absolute URLs on the request's Hudu origin (`result-urls.ts`); unsafe or non-root-relative values are left alone.
- `runWithCredentialShapeView` stores, per serving unit in an `AsyncLocalStorage`, the value-free anomaly list of the credentials presented, so `errorContent` can enrich auth failures (see [auth and base hosts](../security/auth-and-base-hosts.md)).
- `slim.ts` strips `$schema` and safe-integer `minimum`/`maximum` bounds from every served schema by proxying the standard-schema JSON converter, leaving validation untouched.
- Company context reads keep only a fixed safe-field projection of asset passwords unless secret reads are permitted (`company-context-policy.ts`).
