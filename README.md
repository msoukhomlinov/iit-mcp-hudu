# iit-mcp-hudu

MCP server for Hudu IT documentation, built on the [`node-hudu`](https://www.npmjs.com/package/node-hudu) SDK.

## Tool surface
17 tools by default: `hudu_list_operations`, `hudu_describe_operation`, `hudu_read`,
`hudu_fetch_many`, twelve core reads, and `hudu_list`. Setting `HUDU_WRITE_POLICY` `allow_list` or
`all` adds `hudu_write` and `hudu_delete` (19 tools). Each dispatcher uses a separate SDK client in
its matching mode; names, annotations and the dispatcher field text are the SDK's curated metadata.
SDK enforcement rejects cross-effect calls before any request. The old `hudu_invoke`,
`hudu_catalog` and `hudu_describe` names are removed; consumers must resync their tool catalog.

`hudu_list(resource)` replaces the four `hudu_list_companies` / `hudu_list_articles` /
`hudu_list_assets` / `hudu_list_asset_layouts` tools of 0.2.x (a call to an old name answers with a
pointer to `hudu_list`). `resource` selects one of four fixed registry operations (`companies.list` /
`articles.list` / `assets.listAcrossCompanies` / `asset_layouts.list`); the tool takes exactly one
page and accepts no operation selector or nested invocation, so an ungated reader can page these
collections without the registry dispatcher and without exposing the write surface. Filters go in
`filters`; each resource accepts only its own set, and any other key is refused naming the accepted
ones (never dropped, which would turn a company-scoped request into an account-wide one). Companies,
articles and assets take `page` / `page_size` (capped at 100); `asset_layouts` takes `page` only,
because `/asset_layouts` ignores `page_size`: a caller bound would truncate the vendor page and skip
rows as `page` advanced, so the tool returns the vendor page whole and page N is always the
vendor's Nth page. For searchable resources (`companies` / `articles` / `assets`) a resource
excluded by `HUDU_SEARCH_RESOURCES` is refused by the list tool too, before any request;
`asset_layouts` is not searchable (the SDK declares no vendor text filter for it), so it follows the
same reachability as the existing ungated `hudu_get_asset_layout` tool. The tool set is the SDK's
`CORE_TOOLS` plus `hudu_list`, which is this server's own; a future SDK upgrade must not re-add the
four old names. Rows are compact summaries by default (id, name, key scalar fields, `url`,
`created_at`, `updated_at`; no custom-field values, article bodies or layout field definitions), which keeps a
25-row assets page under 20,000 characters instead of ~88,000; pass `expand: true` for the full
records (`hudu_read` `articles.list` rows are always full). Article rows carry no body unless expanded. Paging is unchanged (`asset_layouts` still takes no `page_size`).

These tools run on node-hudu 0.20.0; the `SDK behaviour (0.12.0)` section below covers the behaviours that shape them: redirect refusal, the closed input contract, the error envelope, and the client opt-ins. Numeric ids must be positive integers on every tool; anything else is refused before a request is made.

`hudu_fetch_many` (node-hudu 0.12.0) fetches up to 20 single records across mixed resources in
one call: each item is exactly `{ resource, id, fields? }` — one of the 22 bare-id resources, a
numeric vendor id, and an optional client-side field projection. A shape violation is refused at
the schema layer before any request, and failure is per-item: a miss or a vendor fault lands on
its own row as a typed error while the rest of the batch is served. The deployment's secret-read
policy applies to the batch's items exactly as to a single read, so a credential item is
refused pre-request under the default `HUDU_SECRET_READS=deny`; `HUDU_WRITE_POLICY=deny` keeps the tool
— it is a read. The same batch stays reachable through `hudu_read` with operation
`operations.fetchMany`, gated the same way.

## Transports

| Transport | For | Caller auth | Hudu credential |
|---|---|---|---|
| `stdio` | Claude Code, Claude Desktop, VS Code | none — the process boundary is the trust boundary | `HUDU_API_KEY` + `HUDU_BASE_URL` env |
| `http` | Remote MCP clients | none — private, unpublished network | per request: `X-Hudu-Api-Key` + `X-Hudu-Base-Url` headers, or the optional `HUDU_API_KEY` + `HUDU_BASE_URL` defaults |

## Local use (stdio)

Needs Node 24+, a Hudu API key and your Hudu origin. `stdio` is the default transport, so no
`MCP_TRANSPORT` is needed. Mutation tools stay off unless you set `HUDU_WRITE_POLICY`.

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
`node /absolute/path/to/iit-mcp-hudu/dist/main.js` after `pnpm run build`.

## Loading credential values (read this before a live session)

A Hudu credential whose bytes reach this server mangled costs a real authentication failure against
your Hudu account, and repeated ones risk an account lock. Two rules keep that from happening.

**Load an env file the way the file documents — shell sourcing, not a generic dotenv parse.**

```
set -a; . ./.env; set +a      # the .env.example recipe, for a file of single-quoted values
```

`.env.example` writes its example values in single quotes, which is the normal `.env` style. A
**shell** consumes those quotes when the file is sourced, so the value the process sees is exactly
the secret. A **quote-preserving dotenv parser** (`dotenv`-style `KEY=VALUE` splitting that keeps
the quotes) does not: it hands `'…'` to the server, quotes included, and the vendor rejects it.
The trap is sharpest when the secret itself contains `$` — `HUDU_API_KEY='a$b'` becomes `a$b` when
sourced and `'a$b'` (with quotes) when naively parsed, and both look correct in the file.

The client-config and `--env` paths shown under *Local use* pass values verbatim and never parse a
file, so they are already safe — this rule is for anyone loading a `.env`.

**Run `doctor` before the first live call.** It answers "did my credential load intact?" from the
environment alone, with zero Hudu requests:

```
npx -y iit-mcp-hudu doctor     # or: node dist/main.js doctor
```

It prints, per credential field, the value's `length`, its two-character `prefix2` and a `shapeOk`
flag with the anomaly names when it is not; plus the origin that will actually be dialed. It exits
non-zero when the credential would be refused, so a runbook step can gate on it:

```
node dist/main.js doctor && <start the live session>
```

**The contract: a green `doctor` makes any later 401 vendor-side.** With `doctor` clean, a 401 means
Hudu refused a well-shaped credential — a rotated, revoked, or role-restricted key — and the fix is
at the vendor, not in the load recipe. Do not re-dial to test it: a 401 at the auth gate is the
signal to stop and check, because repeated failures risk locking the account. Conversely, a 401
whose envelope names a shape anomaly (`credentialShape: "anomalous"`) points back at the load.

The server enforces the shape itself, so a bad load cannot reach the wire even if `doctor` is
skipped: a malformed `HUDU_API_KEY` fails boot; a malformed `X-Hudu-Api-Key` header is refused
before any client is built, with the typed `CREDENTIAL_MALFORMED` envelope (value-free, and
`retryable: false`). Neither path dials. Since node-hudu 0.14.0 the SDK enforces credential shape
itself too — refusing a contaminated value at client construction and attaching a value-free shape
diagnostic to a refused credential — and this server consumes that diagnostic directly on a 401;
the server's own gate stays as the boundary guard, a superset of the SDK's checks.

The server inspects **shape only** — length, a two-character prefix, and anomaly names. A credential
value is never logged, never echoed in an error, and never returned by `/doctor`. The anomalies that
fail a value are: preserved surrounding quotes (single or double), an embedded quote, a carriage
return, a newline, an embedded control character (any non-printable ASCII byte besides those),
edge whitespace, and a NUL byte.

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
pair gets its own scoped client (its own search index) cached by the pair's hash and capped — at most
two pairs stay warm in EACH mode cache, so a credential occupies one client per cache (read, plus
write and delete when writes are enabled) and a further scope rebuilds its index on demand — so one
caller's indexed article bodies can never answer another's search.

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

`HUDU_WRITE_POLICY` is the write switch. `deny` (the default) omits `hudu_write` and
`hudu_delete` entirely; `allow_list` permits only the canonical keys in `HUDU_WRITE_ALLOW` and
registers `hudu_write` only if the list holds at least one write-effect operation, and `hudu_delete`
only if it holds at least one destructive-effect one (per the SDK registry's effect) (a write allowed here also allows the writes it delegates to: allowing
`articles.patchSection` allows `articles.update`); `all` permits the SDK's whole mutation surface.
An empty or invalid allow-list fails startup. The SDK clients receive the same allow-list plus
reads needed by helper dependencies.
Writes default to dry-run previews; execution requires `dry_run:false`, and destructive
operations additionally require exact `confirm`. A confirmation string is not human consent.
Discovery reports deployment-policy refusals as unreachable.

`HUDU_READ_ONLY=true` is a hard override of the write policy: no `hudu_write` / `hudu_delete` tool is
registered and every mutation is refused, whatever `HUDU_WRITE_POLICY` and `HUDU_WRITE_ALLOW` say. Unset or
`false` leaves `HUDU_WRITE_POLICY` in charge (default `deny`). The effective policy is logged once at boot.
Because the two tools are not registered, a client that calls them gets the protocol-level JSON-RPC error
`-32602` (`Tool hudu_write not found`), not a tool error envelope.

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
request is issued — so a deployment cannot hand a secret to a model by omission. The batch read
`operations.fetchMany` (reachable through `hudu_read`) is refused the same way, per item: its
operation key is not itself a credential read, so each item's resource is checked before any
request, and a mixed batch is refused whole rather than partially dialed. The
cross-resource resolve `operations.resolveAny` (also reachable through `hudu_read`) is gated the
same way: under deny an explicitly named credential resource is refused, and an omitted resource
list resolves to the permitted set, which excludes the credential resources from the fan-out. It
is scoped to the
whole resource rather than to the `expand` flag, because `asset_passwords.get` returns the secret
without `expand`. It is independent of `HUDU_WRITE_POLICY`: `all` does not imply open secrets, and
`allow` does not open writes. `hudu_search` is unaffected — it already redacts hits on those two
resources. Refusals are `POLICY_DENIED` and appear as unreachable rows in `hudu_list_operations`.

Password share links (node-hudu 0.16.0): `asset_passwords.listShares`, `getShare`, `createShare` and
`deleteShare` are credential-resource operations, so they are refused under the default
`HUDU_SECRET_READS=deny`; the two writes also need `HUDU_WRITE_POLICY` (or `HUDU_WRITE_ALLOW`) to permit
them. Under `allow`, `listShares` / `getShare` work and the share `url` (a bearer link) is masked.
`createShare` is never runnable here: the SDK refuses it (`POLICY_DENIED`, `reveal_required`, dry-run
included, no request) without its `reveal` capability, this server never grants `reveal`, and
`hudu_list_operations` marks the row unreachable. Link-shaped text is scrubbed from share errors.
Observed live, `deleteShare` of a share that does not exist returns `404 NOT_FOUND` on every attempt, repeats included.
This server never creates a share (`createShare` is unreachable), but under `HUDU_SECRET_READS=allow` and a permitting
write policy `deleteShare` will delete any existing share, including one created in the Hudu UI.

`hudu_get_company_context` accepts `opts.skip` (`assets`, `articles`, `websites`, `asset_passwords`); pass
`["asset_passwords"]` when the key cannot read credentials. The skipped list comes back empty with
`skipped` set, and no request is made for it. `hudu_resolve_any` returns `unauthorized` (the resources the
credential may not read) beside the permitted hits; it errors only when every requested resource refuses.

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

Under `http` each caller's search scope starts cold, so `hudu_search` uses `tier:"auto"` rather than
`"index"`: it answers from Hudu search immediately and builds the body index in the background, so a
caller's later search is body-aware without the first one awaiting a corpus-wide walk. The tier
decides whether a call may *wait*, and the calling model can observe neither the index's warmth nor
the walk's duration, so under `http` the tier is deployment policy, not a call parameter: the served
schema offers neither `tier` nor `refresh`, and a request that still sends either is answered by the
policy path, which records the stripped fields in `meta.policyOverride`. That path returns
immediately only when the resolved policy is `auto` or `vendor`:
with `HUDU_SEARCH_TIER_POLICY=index` an `http` call still waits for a complete body-index answer,
which is exactly that knob's documented purpose. `meta.index` reports the index state (`state`: `cold`,
`refreshing`, `partial`, `warm`), and `meta.degraded` says when the answer was body-blind. Under
`stdio` the one long-lived index stays warm, both fields stay in the schema, and the default is
`"index"`; a caller there can still pass `tier:"index"` for a complete first answer.

`HUDU_SEARCH_TIER_POLICY=auto|index|vendor|typesense` sets that policy explicitly (default `auto`
under `http`, `index` under `stdio`, and `typesense` under **both** when the Typesense pair is
configured — it has no cold start, so the transport asymmetry does not apply): `vendor` forces the
vendor tier and never uses a body tier, `index` lets a call wait for a complete body-index answer,
`typesense` searches the whole corpus through Hudu's own index. Naming `typesense` without the pair
fails boot. When `HUDU_SEARCH_RESOURCES` excludes articles or assets the policy is `vendor` and no
body tier runs, whatever the variable says: every body tier is corpus-wide.

A search answer also reports **which** body source produced it: `meta.bodySource` is `index`,
`typesense` or `none`, and the compact header names it. `meta.degraded.reason` gains
`typesense-unavailable` (the configured endpoint refused or timed out; the answer fell back to the
local index or the vendor tier) and `typesense-unauthorized` (the key was rejected — the key is the
thing to fix), so a body-blind answer always says why.
`HUDU_SEARCH_INDEX_TTL` (milliseconds, default `600000`) is the body index's freshness window. What
the SDK does past it — answer from the stale index while rebuilding in the background — is
UNVERIFIED here: this repo sets the knob (a test asserts it reaches the client) but has not measured
the stale-rebuild behaviour.

`HUDU_TYPESENSE_*` configure the optional Typesense body tier — the same index Hudu's own UI
searches, so body coverage does not depend on this process's heap:

| Variable | Default | Meaning |
|---|---|---|
| `HUDU_TYPESENSE_URL` | — | Origin only (`https://typesense.example.com`, or `http://127.0.0.1:8108` through an SSH tunnel). No path, query or fragment. |
| `HUDU_TYPESENSE_API_KEY` | — | Search-only key (`documents:search` on the two collections). Never logged, never returned by a tool. |
| `HUDU_TYPESENSE_ARTICLES_COLLECTION` | `articles` | Articles collection name. |
| `HUDU_TYPESENSE_ASSETS_COLLECTION` | `assets` | Assets collection name; must differ from the articles one. |
| `HUDU_TYPESENSE_TIMEOUT_MS` | `4000` | Per-search deadline; `15000` is the maximum and a larger value fails boot. |
| `HUDU_TYPESENSE_VERIFY_HITS` | `true` | Re-read every hit through the Hudu API under the caller's credential (see below). |

`HUDU_TYPESENSE_URL` and `HUDU_TYPESENSE_API_KEY` are set together or not at all: one without the
other fails boot, naming both. With both set the server builds its SDK client with this block and
the boot log gains one line, `typesense: enabled (collections articles, assets)` — the collections
only, never the URL or the key. With both unset nothing changes, boot output included: no Typesense
request is ever made.

Setting the pair makes the `typesense` tier the default for `hudu_search`: the call reads the whole
corpus directly from Hudu's index, with no local build. `HUDU_SEARCH_TIER_POLICY` still chooses the
tier explicitly — `index` or `vendor` overrides that default, and naming `typesense` without the pair
fails boot. The served schema advertises the `typesense` value only on a deployment that configured
it.

`HUDU_TYPESENSE_VERIFY_HITS` (default `true`) is the credential re-read flag. What the SDK does when
it is on — re-read every candidate id through the Hudu API under the credential that made the call
before returning a hit — is the SDK's behaviour: this repo sets the flag (a test asserts it reaches
the client) and has not measured the re-read itself. Hudu's index carries neither folder permissions
nor deletions (it keeps discarded articles), so the re-read is what stops a hit being a record the
caller may not see. `false` skips it: faster, but a hit can be discarded or permission-hidden. Use
`false` only on a single-tenant, non-restricted, read-only deployment.

A request cancelled while a call waits on a body-index build answers instead of throwing.
`meta.degraded.reason` stays `body-not-indexed` (the SDK's closed union), `meta.cancelled` records
`{ during: "index-build", waited }` as a deliberate SERVER extension (the SDK's meta has no
cancellation field; it travels in the open `meta` object beside the SDK vocabulary, and
`meta.policyOverride` is the same kind of extension on the http path), and `meta.reasons` stays empty because no bound bit — the answer
was cancelled, not bounded. Its `meta.index.state` is `cold` or `refreshing`; `cold` here means no
generation was observed by THIS call, not that the process has no warm index (under `stdio` a warm
index is possible, and this answer does not claim otherwise). The served `hudu_search` outputSchema
types `meta` as an open object on purpose (a closed union costs about 1.1 KB against ~233 B of
surface headroom); the meta vocabulary is enforced by the tests that publish it
(`test/tools/search-progress.test.ts`), not by the outputSchema.

The body index is bounded by TWO caps derived from the same heap estimate: a text budget and a
document cap. The text budget is a SIXTEENTH of the process's V8 heap ceiling, clamped to 8-64 MiB;
the document cap is one document per KiB of that budget (`maxDocs`), capped at 50,000. Both
travel the SDK's `search` options, so neither is an env knob. The divisor moved from 10 to 16 in
round 11 because the tenth left no usable production margin (the arithmetic below).

Where the sixteenth comes from, and what the "4x" is a ratio of. The #51 crash trace is a 512 MiB
container running the OLD behaviour — the SDK-default 64 MiB text budget — which peaked at ~252 MB
of heap and died with `Reached heap limit` mid-search. It measured the ~90 MB baseline heap and about
4 bytes of index structures per byte of text ACTUALLY HELD, not per byte of budget: that index held
~41 MB of text out of its 64 MiB budget, and the peak reconciles as ~90 + 4 x 41 = ~254 MB. Read
against the budget instead of the held text the same ratio would predict 90 + 4 x 64 = ~346 MB, which
the trace never saw. A 512 MiB container (roughly a 259 MB heap ceiling) now gets a 16 MiB pool,
divided THREE ways for one read-only cache (5.33 MiB per scoped client) or nine ways when writes are
enabled, because read, write and delete each keep their own cache and each counts one eviction of
margin (1.78 MiB per client). The division is an exact byte quotient, so no pool space is lost to
rounding. The share is SIZED so the cache capacity plus one eviction of margin per cache fits the
pool; it is not an enforced peak. A scope evicted by the LRU stays resident while an in-flight
request that resolved it finishes, and because the SDK cannot revoke a live index, concurrent
evictions of distinct credentials can exceed the pool until those requests settle. A standalone walk of a synthetic 25,000-asset / 3,300-article tenant through
the real SDK client under a ~262 MB V8 ceiling (an uncommitted one-off probe; `--max-semi-space-size=1`
brings V8's reported limit to ~262 MB, while `--max-old-space-size=259` alone reports ~451 MB in
Node 24) peaked at ~136 MiB with the ROUND-10 tenth settings; the same walk with the OLD
64 MiB / 50,000 settings peaked at ~147 MiB. Both survived. That probe's baseline is lower than the
server's ~90 MB. A 1 GiB container's ~816 MB V8 ceiling — an ASSUMED ~80% container-to-heap ratio; the MEASURED ratio for the 512 MiB container is ~50.6% (259 MB) — gets a 51 MiB pool and 17 MiB per scoped client (5.67 MiB with writes enabled); a 1024 MB heap ceiling is
what reaches the 64 MiB cap.

The document cap exists because the text budget bounds index TEXT only: a document whose text was
evicted keeps its record and postings, the SDK's own default is 50,000 documents, and a walk can
reach 250 pages x 100 rows x 2 body resources. Pairing the caps bounds that overhead — a 512 MiB
container indexes up to 5,461 documents per scoped client read-only, 1,820 with writes (a stdio
parent carries the whole pool instead: 16,384 documents; writes enabled builds one parent per mode,
so up to three of them carry it), a 1 GiB container's ~816 MB ceiling (assumed ~80%) 17,408 per
client read-only, 5,802 with writes (50,000 in a stdio parent), and only a 1024 MB ceiling 21,845
read-only, 7,281 with writes. The per-document cost is an ESTIMATE (~1 KB of record
plus postings per document, on top of the text ratio), so the pair bounds growth without proving a
peak. HONEST SCOPE: the SDK upserts every walked document and calls its cap only AFTER the walk, so
`maxDocs` bounds the RETAINED index, not the build-time peak; the peak during a walk is bounded by
the heap ceiling and the text budget's eviction, not by `maxDocs`. A capped index reports index state
`partial`, exactly as it already does when the text budget bites.

ARTICLES ARE RESERVED THE WHOLE CAP. Without a reservation the SDK keeps the freshest `updated_at`
across ALL resources, so on an account with more assets than articles the assets take every slot and
the older articles have no index entry at all. `maxDocsByResource` (node-hudu 0.20.0) is a hard
reservation inside `maxDocs`: the server names `articles` with the whole cap, which makes it
articles-first — each article keeps its slot up to the cap, and assets fill whatever room is left,
in the SDK's `updated_at` order. That is the resource split the index exists for: article rows carry
the long text, asset rows do not.
A smaller reservation would also be a hard ceiling on articles, so an article-heavy account would
drop articles while its cap sat half empty (measured against the SDK: 300 articles and 5 assets at a
100-document cap retain 30 documents with a quarter reserved and 100 with the whole cap; an
asset-heavy corpus fills the cap either way).

THE ASSET SHARE IS DERIVED, AND CAN BE ZERO: assets keep `maxDocs - min(articles, maxDocs)` slots.
On the production corpus that is 18,641 of 21,845; where the article corpus meets or exceeds the cap
the assets get none — the 512 MiB write-enabled profile derives a 1,820-document cap against 3,204
articles, so `docs.assets.indexed` is 0 there and asset hits come from Hudu's own title/custom-field
search, which every call runs. `meta.index.docs.<resource>.capped` (node-hudu 0.20.0) names the
documents the caps dropped, per resource, so the loss is visible in the answer. The reservation
tracks the cap,
so it deepens with the heap like the rest of the budget: 17,408 article slots at a 1 GiB container's
assumed ~816 MB heap ceiling, 21,845 at a 1024 MB one, 50,000 in a stdio parent. This is what the
Unreleased CHANGELOG entry measures.

MEASURED on the production tenant (19,991 assets + 3,204 articles = 23,195 documents). At the former
division by eight (6,144 documents): 4,666 assets and 1,478 of the 3,204 articles retained, 1,036
article bodies indexed, 317 evicted by the text budget and 3 truncated (the counts do not decompose
the 1,478 — some retained articles carry no body text). Dividing the pool by two instead of eight
was expected (INFERRED at the time) to keep all 3,204 articles at 17 MiB / 17,408 documents; the
deployment measured that expectation FALSE — 15,588 assets and 1,820 articles — because the asset
count fills whatever cap the pool offers. At the 21,845-document ceiling the split was 19,991 assets
and 1,854 articles, i.e. 1,350 articles with no body index, while the asset rows (titles and custom
fields, no long text) held 91% of the cap. Reserving the cap for articles is the fix: the same
21,845-document cap then keeps all 3,204 articles and gives assets the remaining 18,641 slots (the
SDK's reservation arithmetic, reproduced with a synthetic corpus in `test/index-reservation.test.ts`);
`node-hudu` #122 has the upstream detail.

BEFORE THE DIVISOR CHANGE. The round-10 end-to-end run measured the real server (`dist/main.js`) under
a 259 MiB V8 ceiling: peak heapUsed 187.96 MB with a 24.6 MB baseline, so the INDEX STRUCTURES cost
~163 MB. Production's baseline is ~90 MB, so the honest production peak was 163 + 90 = ~253 MB
against 259 MiB — ~98%, about 6 MB of headroom. That leaves no usable margin. The round-10 README
instead added 90 MB to a standalone-walk figure and reported ~233 MB; that understated the risk.

AFTER THE DIVISOR CHANGE (one sixteenth, this round's measurement). The same SHAPE of probe — the
built server under `node --max-old-space-size=259 --max-semi-space-size=1 --import <uncommitted
heap-sampler.mjs> dist/main.js`, stdio against a stub tenant of 25,000 assets (250 pages x 100 rows) and 3,300 articles
with HTML bodies, `hudu_search` with `tier:"index"` and `refresh:true` — peaked at 118.51 MB
heapUsed against a 27.57 MB base, so the structures cost ~90.93 MB. The process survived (exit 0)
and the call took 11.62 s. The index retained 16,384 documents (articles 3,300, assets 13,084) and
reported state `partial`; bodiesEvicted was 0. PRODUCTION EXTRAPOLATION: 90.93 + 90 = ~180.93 MB,
~70% of the 259 MiB ceiling and ~26 MB below the 207 MB (80%) target. MEASURED PROBE PEAK: 118.51 MB,
~45.8% of the 259 MiB ceiling. The target is met. The fraction shipped is one sixteenth. The
probe scripts were removed from the tree after measuring (the review asked for no ad-hoc probes in
the repo), and the stub was recreated for this round, so the before/after delta also reflects stub
differences and is not a controlled A/B;
the production extrapolation uses this round's measured structures. The stub corpus is synthetic,
its bodies are smaller than production's, and its ~27.6 MB baseline is lower than the ~90 MB
production baseline, so the production figure is an extrapolation. bodiesEvicted 0 means this run
did not exercise eviction. Issue #51's trace remains the only PRODUCTION measurement (~252 MB peak
on the old 64 MiB profile).

The read-through cache (SDK `recommended` preset), the 429 cooldown gate and the 30 s whole-call deadline are fixed, not env-tunable.
`blockPrivateHosts` deliberately gets no override: it is the literal-IP SSRF floor for
caller-named origins — a security property, not a deployment preference.

## Article bodies are Markdown (node-hudu 0.14+)

`hudu_read` and `hudu_write` pass `contentFormat: 'markdown'` to the SDK, and `hudu_get_article_context`
asks for Markdown, so single-article bodies (`articles.get`, `create`, `update`, and
`articles.resolve` / `articles.getContext` only with `opts.expand: true`) are returned and accepted as Markdown. Hudu callouts (`> [!INFO]`), accordions, task
lists and Mermaid fences round-trip as the dialect documents. Observed live (Hudu 2.48.1), a ```` ```mermaid ```` fence is stored as `<pre class="language-mermaid"><code class="language-mermaid">...</code></pre>` (entity-escaped, indentation preserved) and reads back as the identical fence, including through `articles.patchSection`. The read path matches the `<pre>` by class and takes its text, so it accepts both that form and the bare `<pre class="language-mermaid">` form. That is also what the Hudu editor itself stores (checked on 2026-10-25 against a diagram saved in the UI editor): the same `<pre class="language-mermaid"><code class="language-mermaid">` element pair, plus a `data-id` attribute on the `pre` (and on other blocks such as `<p>`). A Markdown round trip drops those editor `data-id` attributes and keeps the diagram text unchanged; it does not use the `code-block-mermaid-source` class. Rows from `hudu_fetch_many`, `hudu_read` `articles.list`, `articles.search` and `articles.findBySlug` still carry stored HTML:
those operations take no format. Rules a caller needs:

- A write's `data.content` is parsed as Markdown unless it opens with block-level HTML (`<p>`, `<div>`,
  `<h1>`-`<h6>`, `<table>`, lists, `<pre>`, `<blockquote>`, `<hr>`, Hudu's `mce-accordion`), in which case
  it is sent as HTML. Re-read an article through `articles.get` before editing it.
- A Markdown write is refused when the stored article holds something the dialect cannot express
  (for example a `<video>`); send HTML to keep it. The SDK's loss guard runs on every write.
- Prefer Markdown (or editor-native HTML): Hudu reshapes API-written HTML on the next UI save (h5/h6 flattened, `small`/`abbr`/`q`/`section`/`aside` unwrapped, `thead` removed, an unknown callout type becomes info).
- `articles.getSection` / `articles.patchSection` read or edit one section as Markdown, with dry-run.
  `articles.getSection` carries the same `markdown_lossy` / `markdown_lossy_codes` signal as `articles.get`;
  it describes the whole article, so the loss may be in another section.
- A Markdown read can be incomplete: anything the dialect cannot express is dropped or reduced
  (`<video>` and `<script>` are dropped entirely). `hudu_read` (`articles.get` / `getSection`, and `resolve` / `getContext` with `opts.expand: true`) and `hudu_get_article_context` with `opts.expand: true` then set `markdown_lossy: true` (with `markdown_lossy_codes`, the SDK's
  `diffArticleRoundTrip` content-loss codes) and add one sentence to the result text; fetch the stored
  HTML with `hudu_fetch_many` (`{items:[{resource:"articles", id}]}`) to see the full body. The read is one
  fetch: the SDK converts the body and reports the loss on the record (no second request); a caller's own
  `opts.format: "html"` returns the stored HTML untouched with no flag. Callouts, accordions, task
  lists, Mermaid, inline `<svg>` and `<iframe>` round-trip cleanly and are never flagged; a lossless read is unchanged.
  A body that converts to nothing (only `<video>`, `<input>`, `<p></p>`) reads as `content: ""` with
  `markdown_lossy_codes` containing `ROUNDTRIP_BODY_EMPTY` (it used to fail with `CONVERSION_EMPTY_OUTPUT`).
  The SDK fails a Markdown read with `CONFIG_ERROR` when the Markdown form exceeds 256 KiB.
- `articles.resolve`, `articles.getContext` and `hudu_get_article_context` carry no lossy signal in the default mode: the result
  holds an article summary (no body), so there is nothing to convert. Only with `opts.expand: true` is the full record
  returned (for getContext, as `article`) with a Markdown body, and then the same `markdown_lossy` /
  `markdown_lossy_codes` signal applies.

## SDK behaviour (0.12.0)

Three SDK behaviours changed in the 0.12.0 line and shape a deployment:

- **Redirects are refused, not followed.** Every Hudu request is sent with `redirect: 'manual'`;
  a 3xx answer (any except 304) is a `REDIRECT_BLOCKED` error carrying the `location`, and the SDK
  never follows it. If a reverse proxy in front of the Hudu origin answers 301/302 (scheme upgrade,
  trailing slash, host rename), dial the final origin instead — the fix is topology, not config.
- **Reads have a closed input contract.** `hudu_read` now refuses unknown input fields at the
  schema layer with a typed `CONFIG_ERROR` naming the accepted fields, before any request;
  `hudu_describe_operation` serves the same contract as `input_contract`. The batch read
  `operations.fetchMany` (up to 20 single records across mixed resources in one call) is part of
  the `hudu_read` surface; this server also registers the dedicated `hudu_fetch_many` tool from
  the 0.12.0 CORE profile, with the secret-read policy applied to the batch's items on both
  paths.
- **Error envelopes carry the status in a field.** The error `message` is the vendor's short
  detail (or a fixed default), never the status or the dialed host; those travel in their own
  fields, and a long upstream body is still replaced by the response shape, not served. The
  envelope also carries the SDK's `category`, `retryable`, `operation`, `suggestedAction`,
  `fieldErrors` and `details` where the error has them, `notSent` on a locally issued 429
  cooldown refusal, and `location` on a `REDIRECT_BLOCKED` refusal; the status field is
  `httpStatus`. A 401/403-class credential refusal collapses to the fixed `UNAUTHORIZED`
  envelope on every tool — the vendor's own message never crosses the boundary, and the
  credential-shaped keys are redacted out of the payload the same way as the success path.
  Two honest corners: `details` may carry the SDK's own 256-char vendor body snippet, labelled
  untrusted like the rest of the envelope, and the `location` of a `REDIRECT_BLOCKED` refusal
  is the vendor's own target, served so the deployment can report or verify it.

Every client the server builds — the parent, the fail-closed placeholders and each
(origin, credential) scope — opts into four 0.12.0 behaviours:

- `profile: 'agent'`: the conservative agent preset for every option this server leaves unset
  (1 retry, 240/min rate limit, concurrency 3, bounded resolution scans). The rate-limit bucket
  is per client, i.e. per scope. The preset stays a deployment-wide constant with no env
  override; the one deadline it would otherwise govern is pinned explicitly instead
  (a fixed 30 s, below), and the 429 now arms the cooldown gate instead of retrying
  blindly.
- `cache: 'recommended'` — fixed on: the
  per-entity read-through TTL preset (1 h structural / 5 min mutable / 1 min base). Caches are
  per client, so per scope — and a scope's client survives only while it stays in its mode cache,
  which holds two pairs: a deployment serving more than two credentials therefore re-fetches more
  from Hudu after an eviction, the same breadth-for-depth trade the body index makes. The write and delete clients have their own caches, so after every `hudu_write` /
  `hudu_delete` attempt that is not a dry run (including a failed or timed-out one, which may have
  applied) the server clears the read client's cache for the same scope: a record read (get, getSection, fetch_many, article context) after a write in
  the same server process is fresh. A write made by another process or deployment can still be served
  stale for up to the TTL, because caches are per process. The `hudu_search` body index is a separate store that a write does not refresh: after a write, pass `refresh: true` or wait for the index TTL (SDK default 10 min) before relying on a body search to find new text.
- `blockPrivateHosts` on the per-scope clients: the literal-IP SSRF floor for CALLER-named
  origins, fail-closed at client construction. It complements the `HUDU_ALLOWED_BASE_HOSTS`
  hostname matcher (which alone can express wildcard suffixes) and holds even in
  bring-your-own-origin mode, where that matcher is wide. The operator's own base — the
  `HUDU_BASE_URL` under `stdio`, the default origin under `http` — is trusted at the process /
  env boundary and is never floor-checked, so an on-prem install whose Hudu sits on a literal
  private IP is unaffected by the upgrade. Deliberately no env override: it is a security
  property, not a deployment preference.
- `cooldown: { enabled: true }` — fixed on: the 429
  cooldown gate; a call refused locally by the gate answers with `notSent: true` in the error
  envelope, so a model does not read a local refusal as a vendor rejection of a sent call.

The whole-call deadline is a fixed `30000` ms:
it is always passed to the SDK explicitly, so it stays above the agent profile's 20 s
regardless of preset — the preset's 20 s would shorten a cold `tier:'index'` body-index walk
that the 0.9.2 deployment tolerated at the SDK's 30 s, and a cold-scope search must not start
timing out because of an upgrade.

These are deployment-wide constants, not per-caller and not env-tunable.


## Development

```
git clone https://github.com/msoukhomlinov/iit-mcp-hudu.git
cd iit-mcp-hudu
pnpm install
pnpm run build
pnpm test
pnpm run dev
```

CI (`.github/workflows/ci.yml`) runs `typecheck`, `lint` and `test` on every push and pull request.

`node-hudu` is pinned to `0.20.0`. The catalog hash test detects metadata drift; upgrades require
review of the client authority, operation enums and redaction regressions. Docker uses `pnpm install --frozen-lockfile`.

## Deployment

`Dockerfile` builds a non-root runtime image. The healthcheck is liveness-only and deliberately does
not call Hudu — otherwise an upstream outage would cycle the container, turning a partial failure
into a total one.

`GET /doctor` (same trust model as `/healthz`: unauthenticated, answered before the MCP handler,
zero Hudu requests) serves the same zero-wire credential-shape report the `doctor` subcommand
prints, so a deployment can check its loaded credential without a vendor dial.

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
