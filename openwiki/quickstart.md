---
type: "Reference"
title: "Quickstart"
openwiki_generated: true
verified:
  - by: openwiki/0.9.0
    at: 2026-11-17T00:09:40.208Z
sources:
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-2b68006c6421e01c95988dcc
    resource: repo://src/config.ts
generated: { by: "openwiki/0.9.0", at: "2026-11-17T00:09:40.208Z" }
---


# Quickstart

`iit-mcp-hudu` is an MCP server for Hudu IT documentation, built on the `node-hudu` SDK. It is an ESM package that exposes the `iit-mcp-hudu` binary (`dist/main.js`) and requires a recent Node runtime; the exact engine range and dependency versions are declared in `package.json`.

## Run, build and test

The scripts in `package.json` are the entry points:

- `pnpm run dev` runs `src/main.ts` through `tsx`; `pnpm run build` compiles with `tsc`; `pnpm start` runs the compiled `dist/main.js`.
- `pnpm test` runs `vitest`; `pnpm run lint` runs ESLint over `src` and `test`; `pnpm run typecheck` runs `tsc --noEmit`.

All runtime configuration comes from environment variables, owned by [configuration](operations/configuration.md). The `doctor` subcommand there checks a configuration without contacting Hudu. How the process starts, picks stdio or HTTP and builds per-request servers is in the [architecture overview](architecture/overview.md).

## Where to read

| If you want to... | Read |
| --- | --- |
| Understand boot, transports, lifecycle and module layout | [Architecture overview](architecture/overview.md) |
| See which MCP tools exist and how they are registered | [Tool surface](architecture/tool-surface.md) |
| Set or look up an environment variable, default or boot refusal | [Configuration](operations/configuration.md) |
| Know how credentials and base URLs are accepted or refused per request | [Auth and base hosts](security/auth-and-base-hosts.md) |
| Change or reason about what writes and credential reads are allowed | [Write policy](security/write-policy.md) |
| Work on search, its tiers or the body index | [Search tiers](search/search-tiers.md) |
| Write tests or cut a release | [Testing and release](development/testing-and-release.md) |

## Orientation tips

- Source code is the truth; the wiki pages cite the file that owns each behaviour, and each concrete fact (default, limit, error code) lives on one page that the others link to.
- Writes are off by default and credential reads are denied by default; both are enforced in `src/policy.ts` before any Hudu request is made.
