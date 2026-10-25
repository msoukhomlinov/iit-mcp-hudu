# Decision record: per-user identity (issue #25, milestone 1)

Status: proposed. Basis: node-hudu `docs/per-user-identity.md` (Hudu 2.48.1 source read, read-only). No live tenant was used.

## Question

Does optionally linking each user's Hudu account (calling Hudu's `/mcp` with that user's OAuth token) earn its complexity over Entra sign-in plus server-side per-user policy and audit?

## Facts that bound the options

- Hudu API keys carry no user and no role. Hudu's log shows which key acted, never which person.
- Hudu OAuth tokens work on `/mcp` (and an undocumented `/external_apps`), not on `/api/v1`. This server is built on `/api/v1`, so a per-user Hudu token can never run the broad surface (assets, passwords, layouts, lists and so on).
- There is no token exchange, no JWT-bearer grant and no trust of Entra tokens in Hudu. Token passthrough breaks the MCP spec (confused deputy).
- Hudu's `/mcp` offers 37 tools, no deletes, unversioned tool names and argument shapes, and does not check scopes.

## Threat model (what per-user identity must defend)

| Threat | Entra + server-side policy and audit | Plus Hudu account link |
|---|---|---|
| A shared service credential leaks, anyone acts with full rights | Closed for users: tokens are per-user, short-lived, validated (issuer, audience, tenant). The server holds no shared-token gate today (`X-MCP-Token` is removed and ignored, see `src/auth.ts`); any service-caller token would be a re-introduced control or live at the gateway. | Same |
| Over-privileged user (read-only person calls write or delete) | Closed: Entra group maps to tool set, companies, destructive rights, in this server. Already partly present via `HUDU_WRITE_POLICY` and `HUDU_SECRET_READS`. | Same, plus Hudu RBAC, but only on `/mcp` article work |
| Cannot attribute an action to a person | Closed in this server's audit log (user, tool, argument digest, record ids). Hudu still shows one key. | Closed in Hudu for `/mcp` calls only; the `/api/v1` majority stays one key |
| Departed or deactivated user keeps access | Closed: Entra disable stops new tokens. Residual: token lifetime. | Worse: refresh tokens do not expire and Hudu may not check `discarded?` (untested), so a stolen refresh token is a long-lived Hudu credential |
| Credential store compromise | No new secret store. | New crown-jewel: encrypted per-user refresh tokens |
| Confused deputy, Hudu cannot tell this server from any other MCP client | n/a | Present: shared public client, first grant skips consent |
| Availability | Hudu key only, as today | Breaks if MCP is disabled account-wide or Hudu changes `/mcp` tool shapes |

## Decision

Recommend NOT building the Hudu account link now. Build Entra sign-in with server-side per-user policy and audit, which closes every threat in the table that matters for this server. The link adds Hudu-side attribution only for the article subset reachable on `/mcp`, while adding a token store, a dependency on an unversioned upstream surface, and a long-lived credential class. It does not remove the shared REST key, so least privilege still has to be enforced server-side anyway.

Revisit the link only if all of these become true: (a) a concrete requirement for Hudu-native per-person attribution on article edits that the server audit log cannot satisfy, (b) milestone 2 shows deactivated-user tokens are rejected and refresh tokens rotate, (c) Hudu documents or versions `/mcp`.

Order if work continues (matches milestone 3): Entra validation and audit first; no shared-token gate exists today, so decide whether service callers need a re-introduced control or a gateway-side token; Hudu link last, if ever.

## Milestone 2: live experiments still needed (non-production Hudu only)

Only needed if the link is to be reconsidered; none block Entra work.

1. Deactivated user: do that user's access and refresh tokens still work on `/mcp`? (Decisive: a yes makes the link a net security loss.)
2. Device-code grant: can it issue MCP-app tokens for headless flows?
3. Refresh rotation: does a refresh token rotate on use, and does the 8 hour TTL apply to refreshed access tokens?
4. `/mcp` stability: record tool names and argument shapes across a Hudu upgrade; does `/external_apps` keep accepting MCP tokens?
5. Per-IP rate limit: measure the generic limit value and behaviour when several users share this server's egress IP.

Sandbox data points (2026-10-25), Hudu 2.48.1 tenant, unauthenticated requests only:

- `GET /mcp` returns 401 with `application/json`, (consistent with an authenticated MCP route).
- `GET /external_apps` returns 302 with `text/html` (a redirect, probably to login).
- The five experiments above remain NOT run: they need, variously, OAuth client registration, a second Hudu user, or a Hudu upgrade.
