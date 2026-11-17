---
type: architecture
title: Architecture overview
description: How the Hudu MCP server boots, chooses between stdio and streamable HTTP, builds a per-request MCP server and Hudu client, registers tools, and shuts down.
tags: [architecture, transport, lifecycle, mcp]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-17T00:09:40.208Z
sources:
  - id: openwiki-source-98396f2fbf8466b8b1bcb0a1
    resource: repo://src/http.ts
  - id: openwiki-source-bafd370ab4ac08bff65d53c6
    resource: repo://src/lifecycle.ts
  - id: openwiki-source-d4189bbeecb62806cb297b5a
    resource: repo://src/main.ts
  - id: openwiki-source-c388505a88e5f28dce116374
    resource: repo://src/search-budget.ts
  - id: openwiki-source-a20de129d9c1b43cec859e19
    resource: repo://src/tools/register.ts
  - id: openwiki-source-85648816930dc890fba8082d
    resource: repo://src/tools/server.ts
generated: { by: "openwiki/0.9.0", at: "2026-11-17T00:09:40.208Z" }
---

# Architecture overview

`iit-mcp-hudu` is an MCP server over the `node-hudu` SDK. All configuration comes from the environment (see [configuration](../operations/configuration.md)).

## Module map

| Module | Role |
| --- | --- |
| `src/main.ts` | Process entry: subcommands, config load, logger, transport choice |
| `src/stdio.ts` | Local transport |
| `src/http.ts` | Streamable HTTP listener and fetch-level routing |
| `src/lifecycle.ts` | Crash/signal handling for HTTP |
| `src/tools.ts` | Public entry point of the tool surface |
| `src/tools/server.ts` | `createMcpServerFactory`: Hudu client construction and per-request server build |
| `src/tools/register.ts` | `registerTools`: derives context, registers tool groups |

## Boot sequence

`main()` in `src/main.ts` handles, before loading config, `--version`/`-v` and `--help`/`-h`, then the `doctor` subcommand (see [configuration](../operations/configuration.md) for what it reports). Otherwise it:

1. Calls `loadConfig(process.env)`. A `ConfigError` is written to stderr and the process exits 1.
2. Creates the logger, logs the effective write policy and a Typesense shape line (only when configured).
3. Under HTTP with `HUDU_SEARCH_TIER_POLICY=index`, logs a warning that calls may block on a corpus-wide index walk; under HTTP with neither `HUDU_BASE_URL` nor `HUDU_ALLOWED_BASE_HOSTS`, warns that any caller-named origin will be dialled. Neither fails the boot.
4. Starts stdio or HTTP depending on `MCP_TRANSPORT`.

(evidence: `src/main.ts`)

## Transports

**stdio** (`startStdio`): `serveStdio` with the shared server factory. The process boundary is the trust boundary; there is no caller authentication. stdout carries protocol, so logging defaults to stderr. `main.ts` adds an `uncaughtException` handler that logs, closes the handle and exits 1.

**HTTP** (`startHttpServer`): a Node `http` server bridged to a fetch-style handler. `createFetchHandler` routes in this order:

1. `/healthz` returns `{status:"ok"}`, unauthenticated and never touching Hudu.
2. `/doctor` returns the credential-shape report of the *server-held* credential, unauthenticated, no Hudu dial.
3. Everything else goes to the MCP handler (`createMcpHandler` from the SDK).

A request without a Hudu key is deliberately let through so `initialize` and `tools/list` work; the per-request client then fails closed on any tool call. How the key and origin are resolved is owned by [auth and base hosts](../security/auth-and-base-hosts.md).

`toWebRequest` reads `headersDistinct` and drops any credential header (`x-hudu-api-key`, `x-hudu-base-url`) presented more than once, so a duplicated credential counts as absent. Responses are streamed, not buffered. A listen failure logs and exits 1; a request-handling failure logs and returns a generic 500 body without the error text.

## Shutdown and crash handling (HTTP only)

`installHttpLifecycle` logs and exits 1 on `uncaughtException` and `unhandledRejection`. On the first `SIGTERM`/`SIGINT` it logs "shutting down", calls `server.close`, and after a 2000 ms grace (`SHUTDOWN_GRACE_MS`, unref'd timer) force-closes connections; either path logs "server closed" and exits 0. A second signal is ignored.

## Server factory and per-request lifecycle

`createMcpServerFactory(config, log)` returns a function called per serving unit: **one stdio connection, or one HTTP request**. Shared across units (built once at factory creation):

- Hudu client "mode entries": a `read` entry always, plus `write` and `delete` entries unless `HUDU_WRITE_POLICY` is `deny`. Each entry holds a parent client, three fail-closed placeholder clients (no base URL, invalid base URL, base not allowed), a lazily built map of malformed-credential clients, and a `ScopedClientCache`.
- `ScopedClientCache` keys clients by SHA-256 of `baseUrl\0apiKey`, with least-recently-used eviction at `MAX_SCOPED_CLIENTS` (equal to `SCOPED_INDEX_BUDGET_DIVISOR`, 2) per mode cache. Scoped clients set `blockPrivateHosts: true`; the operator's own base is not floored.

Common client options: `profile: 'agent'`, `cache: 'recommended'`, `timeoutMs: 30000`, cooldown enabled, and an `onAudit` hook that logs each Hudu request with query values reduced to shapes. Under HTTP the base URL is a reserved `.invalid` placeholder; under stdio it is `HUDU_BASE_URL`. The parent client holds the API key under stdio and a credential-less strategy under HTTP.

Body-index memory is sized from the V8 heap limit (see [search tiers](../search/search-tiers.md)); scoped clients take a divided share of the pool.

Per unit, the returned function resolves the read client (and write/delete clients when enabled), builds a fresh `McpServer`, installs renamed-tool answers and schema slimming, wraps every tool handler in a credential-shape view scope, then calls `registerTools`.

## Tool registration

`registerTools` derives a `ToolContext` once per server (searchable resources, default search scope, whether body tiers are allowed, whether Typesense is configured, the default tier, and whether tier is policy rather than a parameter) and registers meta, search, read, list and fetch-many tools in order. Default-tier and policy rules belong to [search tiers](../search/search-tiers.md); the tools themselves to [tool surface](tool-surface.md); write gating to [write policy](../security/write-policy.md).

`src/tools.ts` also exports `BUILT_AGAINST_PLAN_HASH`, compared in a drift test against the installed SDK's catalogue plan hash.
