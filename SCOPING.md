# SCOPING: iit-mcp-hudu

**SDK:** `node-hudu` (npm). **Server repo:** `https://github.com/msoukhomlinov/iit-mcp-hudu`. This file was written retroactively (2026-10-24, at 0.3.0) to bring the repository under `intellectit-mcp-server-builder` 1.9.0; it records the decisions the code already embodies.

## Decisions

- **Server identity:** `iit-mcp-hudu`, the MCP server for Hudu IT documentation, built on `node-hudu`.
- **Gateway deployment:** YES. A gateway may front it for client authentication, rate limiting and credential injection; the server also works standalone over stdio.
- **Stateless:** YES, with the exception recorded below.
- **Credential model:** per-request, never persisted. stdio: `HUDU_API_KEY` and `HUDU_BASE_URL` from the environment. http: `X-Hudu-Api-Key` and `X-Hudu-Base-Url` headers, with `HUDU_ALLOWED_BASE_HOSTS` as the SSRF allow-list and a literal-IP floor on caller-named origins.
- **Write posture:** read-only by default. `HUDU_WRITE_POLICY` (`deny` | `allow_list` | `all`) is the single switch; `deny` registers no `hudu_write` / `hudu_delete`. Writes are dry-run unless `dry_run:false`; destructive operations also need an exact `confirm`. Plaintext credential reads are a separate switch, `HUDU_SECRET_READS`, default `deny`.
- **Article bodies:** Markdown (node-hudu 0.14 dialect) on single-article reads and on writes; list, search and batch rows stay stored HTML.
- **Observability:** structured JSON logging only (`src/logger.ts`); no metrics or tracing package.
- **CI pipeline:** YES (`.github/workflows/ci.yml`: install, build, typecheck, lint, test, `pnpm audit --prod`, then a container build and smoke job). Publishing to npm is manual.
- **API docs supplied:** YES, through the SDK capability registry (236 operations at node-hudu 0.16.0).
- **Vendor-specific MCP extensions:** NO.
- **Tenancy:** multi-tenant under http (origin and key per request); single-tenant under stdio.
- **Skills layer:** NO. There are no multi-step workflows that need outcome skills behind a guide tool; the dispatchers' dry-run default and the tool descriptions carry the guidance, and the server ships no `instructions`.
- **Key workflows:** company, asset and article context in one call; knowledge search across articles, assets, companies, passwords (redacted) and more; slug and name resolution; bounded paged lists; batch fetch; the whole registry through `hudu_read` / `hudu_write` / `hudu_delete`.

## SDK consumption

- The SDK is consumed from npm, never from a checkout.
- SDK pin exception: `node-hudu` is pinned exactly (0.16.0). `BUILT_AGAINST_PLAN_HASH` in `src/tools.ts` and `test/tools/meta.test.ts` pin the SDK's catalogue, so an SDK upgrade must be a deliberate, reviewed change rather than a range drift.

## Exceptions

| Rule | Reason | Approver | Date |
|---|---|---|---|
| Stateless: no cross-request caches | Bounded in-process LRU of per-(origin, credential) SDK clients (`MAX_SCOPED_CLIENTS`) with the SDK's TTL read cache and body index; never cross-credential, never on disk. | Max Soukhomlinov | 2026-10-24 |
| Dispatcher naming `_read` / `_write` (preview) / `_apply` / `_delete` | `hudu_write` and `hudu_delete` are dry-run by default and apply with `dry_run:false`, through the SDK governor that owns preview, apply and exact `confirm`. A separate `_apply` tool would add a 23rd tool to a surface already over budget and a second apply path beside the SDK's. Decision delegated to the Lead ("whatever is more strategically sound"), kept as is. | Max Soukhomlinov (delegated) | 2026-10-24 |
| Served surface above the default budget (about 6k tokens core, under 10k per profile) | Measured at 0.3.0: write-enabled profile 22 tools, 53,770 bytes (about 13.4k tokens); read-only profile 20 tools, 46,867 bytes (about 11.7k tokens). Ratcheted at node-hudu 0.16.0 after schema slimming, dropping `_meta` and merging the four list tools into `hudu_list`: 19 tools / 38,480 bytes write-enabled and 17 tools / 33,224 bytes read-only (about 9.6k and 8.3k tokens, both under the 10k per-profile figure; the 6k core figure is still exceeded). Names and descriptions are curated upstream in node-hudu and not editable here; the largest are `hudu_search` (6.1 KB), `hudu_read`, `hudu_write`, `hudu_fetch_many`. Interim scoped budgets (approved at 56,000 and 49,000 bytes, ratcheted down to 39,500 and 34,500) are enforced by `test/conformance/surface-audit*.profile.json`. Reduction is tracked as node-hudu issue #112. | Max Soukhomlinov | 2026-10-24 |
