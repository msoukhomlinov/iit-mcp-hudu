# Changelog

## 0.3.0

- Behaviour change: `hudu_read` / `hudu_write` / `hudu_delete` serve and accept article bodies as Markdown (node-hudu `contentFormat: 'markdown'`). Bodies that open with block HTML are still sent as HTML.
- Tooling: the repository moves from npm to pnpm (`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `packageManager`); the Dockerfile and CI use pnpm, and the runtime image carries no package manager. Contributors run `pnpm install`.
- The MCP handshake reports the package version (it was hardcoded 0.1.0).
- CLI: `--version` and `--help` work without configuration. The package no longer ships source maps or `.d.ts` files. The SDK's tracker references ("issues #70/#72") are stripped from served tool descriptions.
- CI: adds `pnpm audit --prod` and a container job (build, no package manager, fail-fast boot, non-default port, origin guard).
- Dependency: node-hudu 0.13.2 to 0.14.0 (Hudu Markdown dialect, `articles.getSection`, `articles.patchSection`); catalog plan hash and reachable-operation counts updated for the two new operations.
- Breaking: `HUDU_READ_ONLY` is removed. `HUDU_WRITE_POLICY` (`deny` default | `allow_list` | `all`) is the single switch; `deny` registers no `hudu_write` / `hudu_delete` tool. Allowing a write also allows the writes it delegates to (`articles.patchSection` -> `articles.update`).
- Breaking: `HUDU_CACHE_PRESET`, `HUDU_COOLDOWN`, `HUDU_TIMEOUT_MS` and `HUDU_SEARCH_MAX_INDEX_PAGES` are removed; the defaults (cache on, cooldown on, 30 s deadline, SDK default index pages) are fixed. A stale removed variable fails boot, so a leftover `HUDU_READ_ONLY=true` can never be ignored silently: delete it and set `HUDU_WRITE_POLICY`.
- `hudu_get_article_context` returns Markdown; `hudu_read`, `hudu_write`, `hudu_list_articles` and `hudu_fetch_many` descriptions state which paths speak Markdown and which carry stored HTML.
- Tests: Markdown read and write loss-guard coverage through the dispatchers.
