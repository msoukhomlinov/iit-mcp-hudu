# Changelog

## 0.3.0

**Upgrading from 0.2.3: breaking changes.** (1) Article bodies through `hudu_read` / `hudu_write` / `hudu_delete` are Markdown by default. (2) `HUDU_READ_ONLY`, `HUDU_CACHE_PRESET`, `HUDU_COOLDOWN`, `HUDU_TIMEOUT_MS` and `HUDU_SEARCH_MAX_INDEX_PAGES` are removed and a set one now fails boot; `HUDU_WRITE_POLICY` is the single write switch. (3) `hudu_list_companies` / `_articles` / `_assets` / `_asset_layouts` are replaced by `hudu_list(resource)`. (4) Served tool definitions drop `_meta`. (5) The repository uses pnpm. The SDK is pinned exactly to node-hudu 0.16.0 (plan hash `fba0aa46...`); 0.15.0 was never published.


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
- Served surface after these: 19 tools / 38.5 KB write-enabled, 17 tools / 33.2 KB read-only (`tools/list`), down from 22 / 50.1 KB and 20 / 43.7 KB on node-hudu 0.16.0.
- Breaking: `HUDU_READ_ONLY` is removed. `HUDU_WRITE_POLICY` (`deny` default | `allow_list` | `all`) is the single switch; `deny` registers no `hudu_write` / `hudu_delete` tool. Allowing a write also allows the writes it delegates to (`articles.patchSection` -> `articles.update`).
- Upgrade hazard: on 0.2.3 an UNSET `HUDU_READ_ONLY` meant read-only (it defaulted to true). In 0.3.0 only `HUDU_WRITE_POLICY` decides, so a deployment that sets `HUDU_WRITE_POLICY=allow_list` or `all` and never set `HUDU_READ_ONLY` now gets `hudu_write` / `hudu_delete` (boot cannot warn: the variable is unset). Check `HUDU_WRITE_POLICY` before upgrading; the default `deny` is unchanged.
- Breaking: `HUDU_CACHE_PRESET`, `HUDU_COOLDOWN`, `HUDU_TIMEOUT_MS` and `HUDU_SEARCH_MAX_INDEX_PAGES` are removed; the defaults (cache on, cooldown on, 30 s deadline, SDK default index pages) are fixed. A stale removed variable fails boot, so a leftover `HUDU_READ_ONLY=true` can never be ignored silently: delete it and set `HUDU_WRITE_POLICY`.
- `hudu_get_article_context` returns Markdown; `hudu_read`, `hudu_write`, `hudu_list` and `hudu_fetch_many` descriptions state which paths speak Markdown and which carry stored HTML.
- Tests: Markdown read and write loss-guard coverage through the dispatchers.
