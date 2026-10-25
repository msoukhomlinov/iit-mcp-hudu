# Changelog

## Unreleased

## 0.5.0

**Upgrading from 0.4.0:** clients now see `markdown_lossy` / `markdown_lossy_codes` on `articles.getSection` (the signal describes the whole article, so the loss may be in another section). `hudu_list` compact rows are unchanged. node-hudu 0.17.0 -> 0.18.0, plan hash re-stamped to `9d110798...`, operation set unchanged (236).

- `articles.getSection` lifts the SDK's whole-body `content_loss` into `markdown_lossy` / `markdown_lossy_codes` like the other article reads; `content_loss` is never passed through. This supersedes the 0.4.0 note that section reads carry no signal (#42, #39).
- `COMPACT_FIELDS` is built from the SDK's `SUMMARY_FIELDS` plus explicit extras (`created_at`, `url`), with a test that derives from the SDK and a literal pin of the final lists, so SDK drift fails CI. Served rows are byte-identical (#42, #39).
- Dependency: node-hudu 0.17.0 -> 0.18.0 (exact pin). Plan hash re-stamped to `9d110798...`; operation set unchanged (236).

## 0.4.0

**Upgrading from 0.3.0:** `hudu_list` now returns compact summary rows by default. Callers that read custom `fields`, article `content` or layout `fields` from list rows must pass `expand: true`. Everything else is additive or a fix.

- Docs: `articles.getSection` carries no `markdown_lossy` signal (node-hudu drops `content_loss` inside `readSection`); the README now says so and a test pins it. Read the whole article with `articles.get` to learn whether a body is lossy.
- Behaviour change: `hudu_list` serves compact summary rows by default (the node-hudu `*Summary` field sets, plus `url` / `created_at` / `updated_at`) instead of full records, cutting a default page from ~49-88k to under 20k characters. `expand: true` returns the full records as before. Envelope, `page_size` default 25 and `asset_layouts` paging (no `page_size`) are unchanged. Callers that read custom `fields`, article `content` or layout `fields` from list rows must pass `expand: true` (issue #22).
- Fix: the 401 shape annotation is bound to the call (AsyncLocalStorage) instead of module-level state written per request, so under http a 401 never carries another concurrent request's credential anomalies (#16).
- Fix: a 401 is annotated only with the anomalies of the credential actually presented on that call (the request key wins over the server-held `HUDU_API_KEY`; the env key's anomalies join only when it is the one dialed), and `hudu_search`'s fully-refused branch now carries the same annotation as every other tool (#16).
- Fix: `hudu_search` and `hudu_read` `operations.searchKnowledge` / `operations.searchAcrossResources` now refuse a malformed `x-hudu-api-key` (`CREDENTIAL_MALFORMED`) and an origin outside the allow-list (the `AUTH_ERROR` envelope other tools return) before any request, instead of returning a successful 0-hit result (#32).
- Fix: the same search paths now refuse every other refusing client state (key with no origin, invalid base URL, keyless request) with the `AUTH_ERROR` envelope, and `hudu_fetch_many` / `hudu_read` `operations.fetchMany` return that top-level refusal for a whole-batch credential or origin refusal instead of `ok: 0, failed: 1` with per-item errors; a genuine per-item vendor failure still lands on its row. A keyless `hudu_search` is no longer a soft 0-hit result (#35).
- Dependency: node-hudu 0.16.0 -> 0.17.0. Plan hash re-stamped to `1ad5e23b...`; operation set unchanged (236).
- Markdown article reads take their loss signal from the SDK: node-hudu now attaches `content_loss` to the record on a Markdown read, so the server no longer forces HTML and converts and diffs the body itself. `markdown_lossy` / `markdown_lossy_codes` are unchanged; the per-record `content_loss` is lifted into them and not passed through.
- Behaviour change: inline `<svg>` and `<iframe>` now survive Markdown reads and writes (they were flagged lossy and writes over them were refused). A body that converts to nothing reads as an empty body flagged `ROUNDTRIP_BODY_EMPTY` instead of failing.
- Docs: decision record for per-user identity (`docs/decisions/per-user-identity.md`): do not build the Hudu account link now; Entra sign-in plus server-side per-user policy and audit instead.

## 0.3.0

**Upgrading from 0.2.3: breaking changes.** (1) Article bodies through `hudu_read` / `hudu_write` / `hudu_delete` are Markdown by default. (2) `HUDU_CACHE_PRESET`, `HUDU_COOLDOWN`, `HUDU_TIMEOUT_MS` and `HUDU_SEARCH_MAX_INDEX_PAGES` are removed and a set one now fails boot. (3) `hudu_list_companies` / `_articles` / `_assets` / `_asset_layouts` are replaced by `hudu_list(resource)`. (4) Served tool definitions drop `_meta`. (5) The repository uses pnpm. The SDK is pinned exactly to node-hudu 0.16.0 (plan hash `fba0aa46...`); 0.15.0 was never published. `HUDU_READ_ONLY` is NOT removed: `true` is a hard override (see below). **UPGRADE HAZARD:** on 0.2.3 an UNSET `HUDU_READ_ONLY` meant read-only. Now only `HUDU_WRITE_POLICY` decides when it is unset, so these two configs, with `HUDU_READ_ONLY` unset, now give the model `hudu_write` / `hudu_delete`: (a) `HUDU_WRITE_POLICY=all`; (b) `HUDU_WRITE_POLICY=allow_list` with a non-empty `HUDU_WRITE_ALLOW`. Set `HUDU_READ_ONLY=true` to keep them read-only. The server logs a warning at boot in exactly this case.


- Behaviour change: `hudu_read` / `hudu_write` / `hudu_delete` serve and accept article bodies as Markdown (node-hudu `contentFormat: 'markdown'`). Bodies that open with block HTML are still sent as HTML.
- Tooling: the repository moves from npm to pnpm (`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `packageManager`); the Dockerfile and CI use pnpm, and the runtime image carries no package manager. Contributors run `pnpm install`.
- The MCP handshake reports the package version (it was hardcoded 0.1.0).
- CLI: `--version` and `--help` work without configuration. The package no longer ships source maps or `.d.ts` files. The SDK's tracker references ("issues #70/#72") are stripped from served tool descriptions.
- CI: adds `pnpm audit --prod` and a container job (build, no package manager, fail-fast boot, non-default port, origin guard).
- Dependency: node-hudu 0.13.2 to 0.14.0 (Hudu Markdown dialect, `articles.getSection`, `articles.patchSection`); catalog plan hash and reachable-operation counts updated for the two new operations.
- Dependency: node-hudu 0.14.0 -> 0.16.0 (0.15.0 was never published). New discoverable operations: `articles.pin`, `articles.unpin`, `asset_passwords.listShares` / `getShare` / `createShare` / `deleteShare`; no served tool added. `asset_layouts.create` / `update` now send the body nested under `asset_layout` (SDK fix: fields were silently dropped). Plan hash re-stamped to `fba0aa46...`.
- `hudu_resolve_any` returns `unauthorized` (resources the credential may not read) beside the permitted hits; it errors only when every requested resource refuses. The dispatcher path returns it too.
- `hudu_get_company_context` accepts `opts.skip` and returns `skipped`.
- Share operations: refused under the default `HUDU_SECRET_READS=deny`; `createShare` is never runnable (the SDK needs `reveal`, this server never grants it) and is listed unreachable.
- Fix: the `hudu_search` default-tier sentence rewrite matched stale SDK text, so `auto` and narrowed deployments advertised a false `index` default; it now fails loudly if the anchor drifts.
- Discovery no longer names tools this server does not serve (`hudu_get_asset_password`, `hudu_get_website`).
- Served surface: `$schema` and safe-integer `maximum` stripped, SDK dispatcher field text served verbatim, shorter article-format note and `hudu_search` `query` text; an intermediate 46.3 / 40.8 KB. A size-gate test ratchets both.
- Mermaid is stored in the bare editor-native `<pre class="language-mermaid">` form (SDK 0.16.0); round-trip test added.
- Breaking: the four `hudu_list_companies` / `hudu_list_articles` / `hudu_list_assets` / `hudu_list_asset_layouts` tools are replaced by one `hudu_list` with a `resource` argument. Filters move inside `filters`; an unaccepted filter is refused, `asset_layouts` refuses `page_size`. A call to an old name answers with a pointer to `hudu_list`. Same bounds and pagination as before. Resync tool catalogs.
- Breaking (metadata): served tool definitions no longer carry `_meta` (`backingOperation`, `sensitive`, `requiresApproval`, ...).
- Served surface after these: 19 tools / 39.5 KB write-enabled, 17 tools / 33.9 KB read-only (`tools/list`), down from 22 / 50.1 KB and 20 / 43.7 KB on node-hudu 0.16.0.
- Markdown article reads (`hudu_read` `articles.get` / `getContext` / `resolve`, `hudu_get_article_context`) that lose content the dialect cannot express (e.g. an inline `<svg>`) now set `markdown_lossy: true` and `markdown_lossy_codes` and add one sentence to the result text; a lossless read is byte-identical to before. Detection uses the SDK's `diffArticleRoundTrip` (content-impact findings only).
- `allow_list` registers `hudu_write` only when the list holds a write-effect operation and `hudu_delete` only when it holds a destructive-effect one (previously both). `all` registers both; `deny` and `HUDU_READ_ONLY=true` neither. The boot log states which were registered.
- `HUDU_WRITE_POLICY` (`deny` default | `allow_list` | `all`) is the write switch; `deny` registers no `hudu_write` / `hudu_delete` tool. Allowing a write also allows the writes it delegates to (`articles.patchSection` -> `articles.update`). `HUDU_READ_ONLY=true` stays a HARD OVERRIDE: no write or delete tool and every mutation refused, whatever `HUDU_WRITE_POLICY` / `HUDU_WRITE_ALLOW` say; unset or `false` leaves `HUDU_WRITE_POLICY` in charge. The effective policy is logged once at boot.
- Behaviour note: on 0.2.3 an UNSET `HUDU_READ_ONLY` defaulted to true (read-only). It is now unset = `HUDU_WRITE_POLICY` decides, so a deployment that sets `HUDU_WRITE_POLICY=allow_list` or `all` without `HUDU_READ_ONLY=true` gets the write tools. Set `HUDU_READ_ONLY=true` to keep a deployment read-only regardless.
- Breaking: `HUDU_CACHE_PRESET`, `HUDU_COOLDOWN`, `HUDU_TIMEOUT_MS` and `HUDU_SEARCH_MAX_INDEX_PAGES` are removed; the SDK client now uses the fixed agent profile, recommended cache, a 30 s timeout and an armed cooldown. A set one fails boot.
- `hudu_get_article_context` returns Markdown; `hudu_read`, `hudu_write`, `hudu_list` and `hudu_fetch_many` descriptions state which paths speak Markdown and which carry stored HTML.
- Tests: Markdown read and write loss-guard coverage through the dispatchers.
