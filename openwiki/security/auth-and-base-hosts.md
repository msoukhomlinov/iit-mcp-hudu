---
type: security
title: Authentication, credentials and base hosts
description: How the HTTP transport takes per-request Hudu credentials and origins, how the client is resolved and fails closed, how allowed base hosts guard against outbound abuse, and which credential shape anomalies are refused.
tags: [security, auth, credentials, ssrf, http]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-17T00:09:40.208Z
sources:
  - id: openwiki-source-f7c142d54c919db5f16a5ea3
    resource: repo://src/auth.ts
  - id: openwiki-source-599b6af02084f2acb39d81a2
    resource: repo://src/base-hosts.ts
  - id: openwiki-source-6c7bb11e61508b3acaad0d9c
    resource: repo://src/credential.ts
  - id: openwiki-source-85648816930dc890fba8082d
    resource: repo://src/tools/server.ts
generated: { by: "openwiki/0.9.0", at: "2026-11-17T00:09:40.208Z" }
---

# Authentication, credentials and base hosts

There is no shared-secret gate on the server: the legacy `X-MCP-Token` header is gone and a client that sends it is treated as if the header were absent. Under HTTP the trust boundary is the network (the listener is meant to stay on a private network); under stdio it is the process (see the [architecture overview](../architecture/overview.md)). Variable names, defaults and boot refusals are on [configuration](../operations/configuration.md).

## Per-request headers (HTTP)

Two fixed header names carry the caller's identity (`src/auth.ts`):

- `x-hudu-api-key`: the caller's own Hudu API key. It is what actually reaches Hudu, so a caller can read only what its Hudu role allows.
- `x-hudu-base-url`: the Hudu origin the key belongs to.

Neither header ever appears in a tool input schema or the server's config surface. Each is single-valued: a header presented twice is treated as absent, both when the Node request is converted (`toWebRequest` drops duplicated credential headers) and in `readSingleHeader`/`headerRecord`. A blank or whitespace-only value is treated as not sent.

## Client resolution

`resolveHuduClient` (`src/tools/server.ts`) runs once per serving unit (stdio connection or HTTP request) and picks a client. Under stdio it returns the parent client built from the environment and never reads headers. Under HTTP:

1. The request's key and base win; the server-held `HUDU_API_KEY` and `HUDU_BASE_URL` only fill in what the request omits.
2. A base is **caller-named** when the header is present and its origin differs from the default origin (or does not parse).
3. A caller-named origin must be allowed. If `HUDU_ALLOWED_BASE_HOSTS` is set, `baseHostAllowed` must accept it. If it is unset, a caller-named origin is accepted only in bring-your-own-origin mode, that is when no default `HUDU_BASE_URL` exists (config refuses to boot into that mode without `HUDU_ALLOW_ANY_BASE_HOST=true`). A refusal resolves to a fail-closed placeholder client. The default origin is operator-chosen and never checked against the list.
4. The server-held default key is presented **only** to the default origin; a request that names another origin without its own key gets no credential.
5. With no usable key, the request resolves to the credential-less parent, so `initialize` and `tools/list` still work but every tool call fails closed.
6. The chosen key is shape-checked. A malformed key resolves to a per-anomaly-set placeholder client and a warning is logged with anomaly names, length and a hint, never the value.
7. A key with no origin resolves to the "no request base URL" placeholder; an origin the SDK rejects at construction resolves to the "invalid base URL" placeholder; an `INVALID_CREDENTIAL_SHAPE` from the SDK where the server gate passed is logged as gate divergence and refused as malformed.
8. Otherwise a scoped client for `(origin, key)` comes from the LRU cache (eviction and sizing are in the [overview](../architecture/overview.md)).

Placeholder clients throw before any Hudu request is built, so nothing is dialed. The resulting refusal is also stored in the per-unit credential-shape view so error responses can name the cause.

## Allowed base hosts

`baseHostAllowed` (`src/base-hosts.ts`) lowercases the hostname of the URL and matches entries exactly, or via a `*.` suffix entry that matches subdomains only, never the bare domain. An unparsable URL is refused. An undefined list permits everything at this level (the default-only and bring-your-own-origin rules above sit on top). Hostname matching is complemented by the SDK's `blockPrivateHosts` literal-IP floor on scoped (caller-named) clients, which holds even in bring-your-own-origin mode; the operator's own base URL is trusted and not floored, so an on-prem Hudu on a private IP works.

## Credential shape anomalies

`src/credential.ts` exists because a quote-preserving `.env` load once sent quotes as part of the secret. `detectCredentialShape` returns any of these anomalies, and every one is fatal (`isFatalAnomaly`): `surrounding_double_quotes`, `surrounding_single_quotes`, `embedded_quotes`, `carriage_return`, `newline`, `embedded_control_character`, `edge_whitespace`, `nul_byte`. It reports only names, length and a two-character prefix, never characters of the value. The server-held key is refused at boot ([configuration](../operations/configuration.md)); the per-request key is refused at client resolution. On an authentication failure the error envelope can include the anomalies of the credential actually presented, scoped to the call through an async-local view. The zero-wire `doctor` route and command report the same shape facts without dialing ([configuration](../operations/configuration.md)).
