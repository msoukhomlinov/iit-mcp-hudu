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
