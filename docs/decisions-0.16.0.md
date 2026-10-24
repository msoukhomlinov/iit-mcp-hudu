# Decisions for node-hudu 0.16.0 (issue #24)

## Share operations

`asset_passwords.listShares` / `getShare` / `createShare` / `deleteShare` stay dispatcher-only (no dedicated tool: size budget). They are credential-resource operations, refused under the default `HUDU_SECRET_READS=deny`; the writes also need the write policy. `createShare` is never runnable: the SDK refuses it without `reveal`, every scoped client here is built with `reveal: false`, and the row is listed unreachable. Opting in (`reveal: true` behind `createShare` in `HUDU_WRITE_ALLOW` plus `HUDU_SECRET_READS=allow`) is possible later on explicit request. Pin/unpin are dispatcher-only too.

## `hudu_get_company_context` and `HUDU_SECRET_READS=deny`

`opts.skip` is caller-controlled. Skipping `asset_passwords` by default under `deny` was considered (saves one request) and rejected: it would change the default result shape for every caller, and the summary-only projection already protects the data.

## Per-user identity (milestone 1: decision record)

Hudu API keys carry no user or role and OAuth tokens work only on Hudu's native `/mcp`, so `/api/v1` can never act with a person's permissions. Decision: if per-user control is needed, build it server-side first (users sign in with Entra ID; issuer/audience/tenant validated, user from `oid`/`upn`; per-user policy by group; own audit log; the shared REST key stays tightly scoped). Linking each user's Hudu account and routing article work to Hudu's `/mcp` (step 4) is NOT justified yet: it adds an encrypted refresh-token store (a crown-jewel secret), a second code path and unverified behaviour (deactivated-user tokens, refresh rotation, per-IP limits) for a benefit Entra + server-side policy already delivers for the shared key. Revisit only if auditors require Hudu-side attribution.

Milestone 2 (live unknowns on a non-production Hudu) and milestone 3 (prototype) are NOT done: they need a non-production Hudu tenant and an Entra app registration, and no build is warranted until the decision above is reviewed.

## Ideas from Hudu's native MCP

| Idea | Decision |
|---|---|
| Server's own text vs SDK text (paging, report-not-retry, verify-after-edit, routing) | Checked: the SDK 0.16.0 text covers them; the appended sentences add nothing to duplicate. |
| Trimmed default rows with `include` | Defer to #22 (list tools return full rows); not duplicated here. |
| Asset custom fields by label on read/write | Skip: an SDK feature (node-hudu), not a server-side one. |
| Images as `/public_photo` references | Skip: no consumer demand; the SDK does not serve them. |
| Archive flag instead of delete | Skip: `articles.archive` already exists in the registry and is reachable through `hudu_write`; deletion stays `hudu_delete` with `confirm`. |

## Served-surface size (issue #24 F): met

Measured with node-hudu 0.16.0 (compact `tools/list` UTF-8 bytes; write-enabled / read-only):

| Step | Write-enabled | Read-only |
|---|---|---|
| Baseline (0.16.0, no change) | 50,070 | 43,714 |
| Low-loss levers (`$schema`, safe-integer `maximum`, SDK dispatcher field text, shorter `hudu_search` query and format note) | 46,261 | 40,767 |
| Drop served `_meta` + merge the four `hudu_list_*` tools into `hudu_list(resource)` | 38,500 | 33,242 |
| + `markdown_lossy` output fields and note clause (current) | 39,473 | 33,928 |

Both profiles are under 40,000 B (write by 527 B). `surface_audit.py` (incl. instructions): 39,453 / 33,910 B, 19 / 17 tools. Measured, not landed: operation `enum` to plain string (-3,817 / -1,922 B on the 46,261 / 40,767 baseline) is the next lever if more headroom is needed; moving thin resolve/find tools to the discoverable tier needs a node-hudu CORE rule change and an SDK release first, so it is not started here.

`_meta` (`backingOperation`, `sensitive`, `requiresApproval`, `registryWide`, `dryRunAffordance`) is dropped from every served tool definition (owner confirmed nothing external reads it). The drift check in `dedicated.test.ts` now reads the SDK registry instead.

`hudu_list(resource)` replaces `hudu_list_companies` / `_articles` / `_assets` / `_asset_layouts` (breaking). Filters move inside `filters`; a filter the resource does not accept is refused naming the accepted ones; `asset_layouts` refuses `page_size`. A call to an old name answers with a pointer to `hudu_list` (`src/tools/renamed.ts`; the old names are never listed, so they cost no served bytes). This is surface size only: #22 (full-record results per call) is a separate change and is not folded in.

This server registers the SDK `CORE_TOOLS` plus `hudu_list`, which the SDK does not know; the README records that a future SDK upgrade must not re-add the four old names.

## Review follow-ups resolved

Both items previously listed here as open are done in 9320e28:

- Lossy Markdown reads: `articles.get` / `getContext` / `resolve` and `hudu_get_article_context` now set `markdown_lossy` (with `markdown_lossy_codes`) when the stored HTML holds content the Markdown dialect cannot express, using the SDK's `diffArticleRoundTrip` (content-impact findings only). Served surface after the change: 39,473 / 33,928 B (`tools/list`), still under 40,000 B on both profiles.
- allow_list registration: `hudu_write` is registered only when the list holds a write-effect operation and `hudu_delete` only when it holds a destructive-effect one; the boot log states which tools were registered. The one-level `withWriteDependencies` stays as is (it fails closed).

## node-hudu follow-ups to raise (reported, not yet reproduced here)

- `htmlToMarkdown` can throw `CONVERSION_EMPTY_OUTPUT` (non-empty input converting to empty output). A Markdown read of such an article now fails with that error exactly as the SDK's own conversion did; a lossy-but-non-empty body degrades to the `markdown_lossy` flag instead.
- Converting a ~157 KB article with a 2,500-row table was reported to take ~26 s, which looks quadratic in the table path. The read now converts locally, so the cost is paid per read in this process; worth a performance issue on node-hudu before large articles are common.
