# Architecture

`iit-mcp-hudu` is a thin MCP layer over the `node-hudu` SDK. The SDK owns the Hudu API, the operation registry, validation, dry-run, confirmation and the error taxonomy; this server owns transport, credential resolution, deployment policy and result shaping.

## 1. Transports

- **stdio** (default): one process, one credential, the process boundary is the trust boundary. `HUDU_BASE_URL` and `HUDU_API_KEY` are required.
- **http** (Streamable HTTP, stateless per request): the caller names its origin and key per request (`X-Hudu-Base-Url`, `X-Hudu-Api-Key`). `/healthz` is liveness only and never calls Hudu; `/doctor` is the zero-wire credential preflight.

## 2. Tool surface

19 tools when writes are enabled, 17 when `HUDU_WRITE_POLICY=deny`. See `docs/capability-matrix.md`.

- Generic layer: `hudu_list_operations`, `hudu_describe_operation`, `hudu_read`, `hudu_write`, `hudu_delete` reach the whole SDK registry by canonical key with slim, closed schemas.
- Dedicated tools exist only where a model would otherwise pay for a long path: context composites, search, resolve, bounded lists, slug lookups, `hudu_fetch_many`.
- `hudu_write` and `hudu_delete` are never registered under `deny` or `HUDU_READ_ONLY=true`; under `all` both are; under `allow_list` `hudu_write` only if the list holds a write-effect operation and `hudu_delete` only if it holds a destructive-effect one.

## 3. Safety layers (outermost first)

1. **Write policy** (`src/policy.ts`): `deny` | `allow_list` | `all`. Server-side, default deny, checked before any request. An allowed write also allows the writes it delegates to (`articles.patchSection` -> `articles.update`).
2. **Secret-read policy**: `asset_passwords.*` and `password_folders.*` are refused unless `HUDU_SECRET_READS=allow`, through every path including `fetchMany`. Search results stay redacted regardless.
3. **Per-mode SDK clients**: separate read, write and delete clients, so the read dispatcher can never borrow mutation authority. Each client is also given an operation allow-list.
4. **SDK governor**: dry-run by default, exact `confirm` for destructive operations, loss guard on Markdown writes.

No human is required to answer anything; approval is policy, not a prompt.

## 4. Credentials and SSRF

The credential never appears in a tool schema, a log line or a result. Under http, `HUDU_ALLOWED_BASE_HOSTS` (or a default `HUDU_BASE_URL`) bounds caller-named origins; booting with neither requires `HUDU_ALLOW_ANY_BASE_HOST=true`. The SDK additionally refuses literal private IPs for caller-named origins and never follows redirects. Malformed credential shapes (preserved quotes, control characters) fail boot or are refused per request.

## 5. State (exception to the stateless baseline)

A bounded LRU (`MAX_SCOPED_CLIENTS = 8`) holds per-(origin, credential) SDK clients, each with the SDK's read-through TTL cache and search body index. In-process only, never shared across credentials, never persisted. Recorded in `SCOPING.md` Exceptions.

## 6. Article content format

`hudu_read` and `hudu_write` pass `contentFormat: 'markdown'`; `hudu_get_article_context` asks for Markdown (its default result, like `articles.resolve`, is an article summary with no body, so no lossy signal; only `opts.expand: true` returns a Markdown body that can carry one). Fetch-many, `articles.list` (via `hudu_read`), search and company-context rows carry stored HTML because those operations take no format; `hudu_list` article rows carry no body unless `expand: true`. These rules live in the ON-DEMAND documentation surfaces, not in `tools/list`: `hudu_search` `mode:"help"` carries the block-HTML passthrough rule (a write whose content opens with block HTML is sent as HTML), and `hudu_describe_operation` of an article body read (`articles.get`, `articles.getSection`, `articles.resolve`, `articles.getContext`) carries the recovery hint for a lossy Markdown read (fetch the stored HTML with `hudu_fetch_many`). The compact tool descriptions only say that single-article reads are Markdown and other rows stored HTML.

## 7. Configuration

Environment only, validated once at boot (`src/config.ts`); an invalid or stale variable fails boot naming it. Fixed SDK settings: agent profile, `recommended` cache, 429 cooldown, 30 s deadline.

## 8. Deployment

Multi-stage Docker image, non-root runtime, liveness-only healthcheck. CI runs install, build, typecheck, lint, test and a production audit, then builds the image and smokes it (no package manager, fail-fast boot, non-default port, origin guard).
