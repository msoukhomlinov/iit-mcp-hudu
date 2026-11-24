---
type: reference
title: Configuration and environment variables
description: Every environment variable the server reads, its default and bounds, the cross-field boot refusals, removed variables, and the zero-wire doctor preflight.
tags: [configuration, environment, doctor, validation]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-17T00:09:40.208Z
sources:
  - id: openwiki-source-2b68006c6421e01c95988dcc
    resource: repo://src/config.ts
  - id: openwiki-source-67e7d6c76250bfd0f309e879
    resource: repo://src/doctor.ts
  - id: openwiki-source-d4189bbeecb62806cb297b5a
    resource: repo://src/main.ts
generated: { by: "openwiki/0.9.0", at: "2026-11-17T00:09:40.208Z" }
---

# Configuration and environment variables

Configuration is environment-only. `loadConfig` (`src/config.ts`) parses `process.env` with a zod schema plus a cross-field refinement, and throws a `ConfigError` that lists **every** problem at once, naming variables but never values. `main.ts` prints it to stderr and exits 1 (see the [architecture overview](../architecture/overview.md)). A blank value for the optional URL/key variables (as a copied `.env.example` leaves them) is normalised to unset.

## Variables

| Variable | Default / allowed | Notes |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` \| `http`; default `stdio` | Selects the transport. |
| `PORT` | integer 1-65535, default `8787` | HTTP listener. |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error`, default `info` | |
| `HUDU_BASE_URL` | absolute URL, optional | Required under `stdio`. Under `http` it is the default origin; when `HUDU_ALLOWED_BASE_HOSTS` is unset it restricts callers to that one origin. |
| `HUDU_API_KEY` | non-empty, optional | Required under `stdio`. Under `http` it is the default key for a request that brings none. Shape-checked at boot under both transports. |
| `HUDU_ALLOWED_BASE_HOSTS` | comma list, optional | Lowercased, de-duplicated. See below. |
| `HUDU_ALLOW_ANY_BASE_HOST` | `true` \| `false`, default `false` | Opt-in for bring-your-own-origin under `http`. |
| `HUDU_WRITE_POLICY` | `deny` \| `allow_list` \| `all`, default `deny` | Semantics on [write policy](../security/write-policy.md). |
| `HUDU_WRITE_ALLOW` | comma list | Read only under `allow_list`. |
| `HUDU_READ_ONLY` | `true` \| `false` | `true` forces policy `deny` and an empty allow list (`applyReadOnly`). |
| `HUDU_SECRET_READS` | `deny` \| `allow`, default `deny` | Gates the credential-bearing resources; see [write policy](../security/write-policy.md). |
| `HUDU_SEARCH_RESOURCES` | comma list, optional | Narrows searchable resources. |
| `HUDU_SEARCH_TIER_POLICY` | `auto` \| `index` \| `vendor` \| `typesense`, optional | Meaning on [search tiers](../search/search-tiers.md). |
| `HUDU_SEARCH_INDEX_TTL` | positive integer (milliseconds), optional | Body-index TTL; the SDK default applies when unset. |
| `HUDU_TYPESENSE_URL` | http(s) origin, optional | Origin only. |
| `HUDU_TYPESENSE_API_KEY` | non-empty, optional | Search-only key. |
| `HUDU_TYPESENSE_ARTICLES_COLLECTION` | default `articles` | |
| `HUDU_TYPESENSE_ASSETS_COLLECTION` | default `assets` | |
| `HUDU_TYPESENSE_TIMEOUT_MS` | positive integer, default `4000`, max `15000` | Whole-call deadline for one Typesense search. |
| `HUDU_TYPESENSE_VERIFY_HITS` | `true` \| `false` (case-insensitive), default `true` | Re-reads each hit under the caller's credential. |

Removed variables `HUDU_CACHE_PRESET`, `HUDU_COOLDOWN`, `HUDU_TIMEOUT_MS` and `HUDU_SEARCH_MAX_INDEX_PAGES` fail boot if set, directing to `HUDU_WRITE_POLICY` / `HUDU_READ_ONLY`.

## Cross-field boot refusals

- A mangled `HUDU_API_KEY` (shape anomalies detected by `src/credential.ts`) is refused before any client exists; the message gives the length and anomaly names, never the value.
- Under `stdio`, both `HUDU_API_KEY` and `HUDU_BASE_URL` are required.
- Under `http`, one of `HUDU_ALLOWED_BASE_HOSTS`, `HUDU_BASE_URL` or `HUDU_ALLOW_ANY_BASE_HOST=true` is required. How these are enforced per request is on [auth and base hosts](../security/auth-and-base-hosts.md).
- Each `HUDU_ALLOWED_BASE_HOSTS` entry must be a bare hostname or `*.` suffix (no scheme, port or path) and be structurally able to match a real host: labels are 1-63 characters, with no leading/trailing hyphen and no empty labels.
- `HUDU_SEARCH_RESOURCES`, when set, must be non-empty and every name must be in the SDK's searchable set.
- `HUDU_TYPESENSE_URL` and `HUDU_TYPESENSE_API_KEY` must be set together; they require a node-hudu build that provides `operations.probeBodySearch` (node-hudu 0.21.0 or later); the URL must be an http(s) origin with no credentials, path, query or fragment; the articles and assets collections must differ.
- `HUDU_SEARCH_TIER_POLICY=typesense` requires the Typesense URL (and thus the key).
- Under `HUDU_WRITE_POLICY=allow_list`, `HUDU_WRITE_ALLOW` must be non-empty and every key must be a registry operation whose effect is a write (an unknown key or a read-only key fails boot).

## `doctor`

`iit-mcp-hudu doctor` (and the HTTP `/doctor` route) run `runDoctor(config)` in `src/doctor.ts`. It imports no Hudu client and reports `dialed: 0`. The report has `ok`, `transport`, per-credential shape facts (status `absent`/`ok`/`malformed`, length, two-character prefix, anomaly names, and whether it `blocks`), the origin (never the path) of `HUDU_BASE_URL`, an optional Typesense block of three booleans (`configured`, `keyPresent`, `urlShapeOk`; no key material), and notes. Only the server-held `HUDU_API_KEY` is checked; the per-request key under `http` is checked at the tool boundary. The CLI exits 1 when the config fails to load or the report is not `ok`; the HTTP route simply returns the report.

Other CLI flags handled before config load (`--version`, `--help`) are described in the [architecture overview](../architecture/overview.md).
