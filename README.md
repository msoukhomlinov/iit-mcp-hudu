# iit-mcp-hudu

MCP server for Hudu IT documentation, built on the [`node-hudu`](https://www.npmjs.com/package/node-hudu) SDK.

## Tool surface

19 tools by default: `hudu_list_operations`, `hudu_describe_operation`, `hudu_read`, twelve
core reads, and four bounded list reads. Setting `HUDU_READ_ONLY=false` adds `hudu_write` and
`hudu_delete` (21 tools). Each dispatcher uses a separate SDK client in its matching mode,
with names, annotations and operation enums from the SDK's curated metadata. SDK enforcement
rejects cross-effect calls before requests. The old `hudu_invoke`, `hudu_catalog` and
`hudu_describe` names are removed; consumers must resync their tool catalog.

The four list tools each wrap exactly ONE fixed registry operation (`companies.list` /
`articles.list` / `assets.listAcrossCompanies` / `asset_layouts.list`), take exactly one page and
accept no operation selector or nested invocation, so an ungated Reader can page companies,
articles, assets or asset layouts without using a registry dispatcher and without exposing the write
surface. The first three take `page` / `page_size` (capped at 100); `hudu_list_asset_layouts` takes
`page` only, because `/asset_layouts` ignores `page_size` — a caller bound would truncate a vendor
page and skip rows as `page` advanced, so the tool returns the vendor page whole and page N is
always the vendor's Nth page. For the searchable resources (`companies` / `articles` /
`assets`) a resource excluded by `HUDU_SEARCH_RESOURCES` is refused by the list tool too, before any
request; `asset_layouts` is not searchable (the SDK declares no vendor text filter for it), so
`hudu_list_asset_layouts` follows the same reachability as the existing ungated
`hudu_get_asset_layout` tool.

## Transports

| Transport | For | Caller auth | Hudu credential |
|---|---|---|---|
| `stdio` | Claude Code, Claude Desktop, VS Code | none — the process boundary is the trust boundary | `HUDU_API_KEY` + `HUDU_BASE_URL` env |
| `http` | Remote MCP clients | none — private, unpublished network | per request: `X-Hudu-Api-Key` + `X-Hudu-Base-Url` headers, or the optional `HUDU_API_KEY` + `HUDU_BASE_URL` defaults |

## Local use (stdio)

Needs Node 24+, a Hudu API key and your Hudu origin. `stdio` is the default transport, so no
`MCP_TRANSPORT` is needed. Mutation tools stay off unless you set `HUDU_READ_ONLY=false`.

**From npm** (recommended):

```
claude mcp add hudu \
  --env HUDU_API_KEY=your-key --env HUDU_BASE_URL=https://your.hudu.host \
  -- npx -y iit-mcp-hudu
```

or in `.mcp.json` / Claude Desktop config:

```json
{
  "mcpServers": {
    "hudu": {
      "command": "npx",
      "args": ["-y", "iit-mcp-hudu"],
      "env": { "HUDU_API_KEY": "your-key", "HUDU_BASE_URL": "https://your.hudu.host" }
    }
  }
}
```

`npx` fetches the package on first run and caches it; use `iit-mcp-hudu@<version>` to pin one.

**From a clone** (for development): see [Development](#development). Point your client at
`node /absolute/path/to/iit-mcp-hudu/dist/main.js` after `npm run build`.

## Configuration

Copy `.env.example`. Every variable is validated at boot; the process exits non-zero on an invalid
config rather than failing at the first tool call.

Under `http` the caller normally supplies both per request: its own Hudu API key in `X-Hudu-Api-Key`
and the origin that key belongs to in `X-Hudu-Base-Url` (an absolute `http`/`https` origin, no
path — validated by the SDK when the scoped client is built). A client can scope the key
per user or per agent to match how the connection is configured, so a caller can read exactly
what its own Hudu role permits and no more. There is no shared token: the listener is
unauthenticated and must stay on a private, unpublished network.

Both may instead be set as **defaults**. `HUDU_BASE_URL` and `HUDU_API_KEY` are required under
`stdio` and optional under `http`, where a request's headers win and the defaults fill in whatever
it omits. Setting `HUDU_API_KEY` under `http` means every request without its own key runs as that
key, so set it only when that is intended: with no shared token, the private network is the only
gate on who can use it. It is only ever presented to the default
`HUDU_BASE_URL`: a request that names some other origin and brings no key of its own gets no
credential and fails closed, so a caller cannot aim the server's key at a host it controls. (A
blank value, as a copied `.env.example` leaves it, is treated as unset.) Each (origin, credential)
pair gets its own scoped client (its own search index) cached by the pair's hash and capped, so
one caller's indexed article bodies can never answer another's search.

`HUDU_ALLOWED_BASE_HOSTS` (`http` only; required unless `HUDU_ALLOW_ANY_BASE_HOST=true`) restricts which origins a caller may name in
`X-Hudu-Base-Url`: a comma-separated list of exact hostnames or `*.example.com` subdomain suffixes
(no scheme, port or path; write an internationalised name in punycode). When it is unset and
`HUDU_BASE_URL` is set, only that default origin is accepted. When both are unset, any caller-named
origin would be accepted, so anyone who can reach the listener could make the server send requests
(carrying their key) to hosts of their choosing; the server refuses to boot in that case unless
`HUDU_ALLOW_ANY_BASE_HOST=true` opts in, for a listener only trusted callers can reach. The check is
on the hostname string: it does not resolve DNS or block private addresses, so do not list a name you
do not control. A request naming a host outside the effective policy fails closed on every tool call
without dialing it. Only the hostname is checked for an explicit list: an allowed host is accepted on
any port and over `http`. The default `HUDU_BASE_URL` is never checked against an explicit list.

With no usable key (none in the header and no `HUDU_API_KEY` default) a request is still let
through: `initialize` and `tools/list` never reach Hudu, and a client's catalog sync needs them. Such
a request resolves to a credential-less client that throws before any Hudu request is built, so
every tool call fails closed rather than borrowing an identity. A request that has a key but no
origin (no header and no `HUDU_BASE_URL` default) is let through the same way and fails closed on
every tool call, with the error naming the missing header. A
credential header sent twice (which Node would otherwise join with `", "`) is treated as absent
for the same reason.

`HUDU_READ_ONLY=true` is the default and omits both mutation tools entirely, regardless of
write policy. To enable mutations, explicitly set it to `false` and configure
`HUDU_WRITE_POLICY`: `deny` rejects all mutations, `allow_list` permits only the canonical
keys in `HUDU_WRITE_ALLOW`, and `all` permits the SDK's mutation surface. An empty or invalid
allow-list fails startup. The SDK clients receive the same allow-list plus reads needed by
helper dependencies; client mode and effect dispatch remain independent restrictions.
Writes default to dry-run previews; execution requires `dry_run:false`, and destructive
operations additionally require exact `confirm`. A confirmation string is not human consent.
Discovery reports deployment-policy refusals as unreachable.

`HUDU_WRITE_POLICY` stays a **deployment-wide** decision, not a per-caller one. Per-caller
credentials make each caller's Hudu role an external authority too, but that authority is not ours
to trust and cannot be allowed to widen this server's surface: the server-side policy is the floor,
`deny` by default, and it holds even when a caller presents a key whose Hudu role could write. The
same applies to `HUDU_SECRET_READS` and `HUDU_SEARCH_RESOURCES` — all three narrow what *this
server* will ever offer, independent of what any one caller's key might otherwise permit.

`HUDU_SECRET_READS` governs the other thing no write policy covers: reads that return a plaintext
credential. `asset_passwords.get` returns `password` and `otp_secret` as an ordinary read, and the
curated tools `hudu_find_asset_passwords_by_slug` and `hudu_get_password_folder` reach the same
records. It is `deny` by default and refuses every operation on the `asset_passwords` and
`password_folders` resources — through `hudu_read` and through those two tools alike, before any
request is issued — so a deployment cannot hand a secret to a model by omission. It is scoped to the
whole resource rather than to the `expand` flag, because `asset_passwords.get` returns the secret
without `expand`. It is independent of `HUDU_WRITE_POLICY`: `all` does not imply open secrets, and
`allow` does not open writes. `hudu_search` is unaffected — it already redacts hits on those two
resources. Refusals are `POLICY_DENIED` and appear as unreachable rows in `hudu_list_operations`.

All SDK clients keep default redaction enabled, including when `HUDU_SECRET_READS=allow`.
That flag permits credential-resource operations; it never enables plaintext results. The
SDK masks credential fields and confidential or unclassified custom fields as `[REDACTED]`.
Untyped fields may therefore be masked even when an external layout calls them public.
Under `deny`, both company-context paths additionally project password rows to the summary
field allow-list, dropping free-text descriptions and unknown future fields. No extra layout
lookups are needed. The common result
boundary also uses the SDK redactor with `otp_seed`, `recovery_code`, and `recovery_codes`
as additional secret keys, preserving protections absent from the SDK's default key list.

Result text is a JSON envelope labelled `untrusted_data`; its fixed instruction marks both
text and `structuredContent` as data, never instructions or authorization to invoke tools.

`HUDU_SEARCH_RESOURCES` is the read-edge counterpart: it narrows which resources the cross-resource
reads — `hudu_search` and `hudu_resolve_any`, plus the same operations reached through `hudu_read`
— may offer and query, because a Hudu API key inherits its user's role and may read fewer than the
SDK's eight searchable resources. Unset means the full set; set it to what the credential can read so
the schema never advertises a guaranteed-empty read. A per-resource read failure, and an auth failure
thrown by the resolve fan-out, are reported as unavailable — never with Hudu's own authorization
message, which is a fact about the calling credential, not the caller's query.

Under `http` each caller's search scope starts cold, so `hudu_search` defaults to `tier:"auto"`
rather than `"index"`: it answers from Hudu search immediately and builds the body index in the
background, so a caller's later search is body-aware without the first one awaiting a corpus-wide
walk (some clients enforce a 60s call timeout). Under `stdio` the one long-lived index stays warm and the
default is `"index"`. Pass `tier:"index"` explicitly for a complete first answer.

## Development

```
git clone https://github.com/msoukhomlinov/iit-mcp-hudu.git
cd iit-mcp-hudu
npm install
npm run build
npm test
npm run dev
```

CI (`.github/workflows/ci.yml`) runs `typecheck`, `lint` and `test` on every push and pull request.

`node-hudu` is pinned to `0.9.2`. The catalog hash test detects metadata drift; upgrades require
review of the client authority, operation enums and redaction regressions. Docker uses `npm ci`.

## Deployment

`Dockerfile` builds a non-root runtime image. The healthcheck is liveness-only and deliberately does
not call Hudu — otherwise an upstream outage would cycle the container, turning a partial failure
into a total one.

The deployment definition is `docker-compose.yml`: its own Compose project, joining an existing
`app_net` external network (create it with `docker network create app_net`, or rename it in the
file). The listener is not published to the host, so put a TLS-terminating reverse proxy in front of
it, or share the network with the client that calls it. Copy `.env.example` to `.env` and fill it
in, then deploy from a clean git checkout with:

    scripts/deploy.sh

The script tags the build with the git short SHA of HEAD (`iit-mcp-hudu-iit-mcp-hudu:<sha>`) —
never `:latest` — so the running container is always tied to a commit.

### Rolling back

A rebuild cannot touch a previous tag, so it stays resolvable in the local image store. Roll back
from the same checkout — and only from it:

    docker image inspect iit-mcp-hudu-iit-mcp-hudu:<previous-sha> >/dev/null  # must exist locally
    HUDU_IMAGE_TAG=<previous-sha> docker compose up -d --no-build --pull never

`--no-build` and `--pull never` are not optional: the service declares both `image` and `build`,
so without them Compose would fall back to pulling — or building the current source under the old
tag — if the image is missing, a rollback that deploys the new code instead. The compose file
also pins `pull_policy: never` as the backstop for any invocation, and the `docker image inspect`
line makes a pruned or absent image fail loudly before anything is started.

The image that was running before the first tagged deploy was `:latest` (unpinned); until a newer
pinned tag exists it remains the rollback target via the same two commands with `latest`.

## Release checklist

- Server identity (`name` / `version` reported in `initialize`) is hardcoded in `src/tools/server.ts`,
  because `rootDir: "src"` forbids importing `package.json` from across the repo root. Bump it there
  as well as in `package.json`.
- `BUILT_AGAINST_PLAN_HASH` in `src/tools.ts` pins the SDK catalogue this server was built against.
  If its test fails after an SDK upgrade, re-read the catalogue and re-check the 19 registered tools,
  then move the constant. Never move it to make CI green — that is the one thing it exists to stop.
