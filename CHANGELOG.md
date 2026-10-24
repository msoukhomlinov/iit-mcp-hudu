# Changelog

## 0.3.0

- Behaviour change: `hudu_read` / `hudu_write` / `hudu_delete` serve and accept article bodies as Markdown (node-hudu `contentFormat: 'markdown'`). Bodies that open with block HTML are still sent as HTML.
- Dependency: node-hudu 0.13.2 to 0.14.0 (Hudu Markdown dialect, `articles.getSection`, `articles.patchSection`); catalog plan hash and reachable-operation counts updated for the two new operations.
- Breaking: `HUDU_READ_ONLY` is removed. `HUDU_WRITE_POLICY` (`deny` default | `allow_list` | `all`) is the single switch; `deny` registers no `hudu_write` / `hudu_delete` tool. Allowing a write also allows the writes it delegates to (`articles.patchSection` -> `articles.update`).
- Breaking: `HUDU_CACHE_PRESET`, `HUDU_COOLDOWN`, `HUDU_TIMEOUT_MS` and `HUDU_SEARCH_MAX_INDEX_PAGES` are removed; the defaults (cache on, cooldown on, 30 s deadline, SDK default index pages) are fixed. A stale removed variable fails boot, so a leftover `HUDU_READ_ONLY=true` can never be ignored silently: delete it and set `HUDU_WRITE_POLICY`.
- `hudu_get_article_context` returns Markdown; `hudu_read`, `hudu_write`, `hudu_list_articles` and `hudu_fetch_many` descriptions state which paths speak Markdown and which carry stored HTML.
- Tests: Markdown read and write loss-guard coverage through the dispatchers.
