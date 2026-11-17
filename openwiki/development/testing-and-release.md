---
type: workflow
title: Testing, CI and release
description: Build/test scripts, vitest layout and the MCP session harness, the CI workflow including the container smoke test, Docker packaging, and the manifest files that carry the package version.
tags: [testing, ci, docker, release, vitest]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-17T00:09:40.208Z
sources:
  - id: openwiki-source-164e2da859b5277df81c7d94
    resource: repo://.github/workflows/ci.yml
  - id: openwiki-source-bb1ebe868e35e9e500714501
    resource: repo://Dockerfile
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-1dc440f1c32e4b1aa3404861
    resource: repo://server.json
  - id: openwiki-source-94e29252eb6795aa8bc1865a
    resource: repo://test/helpers/mcp-session.ts
  - id: openwiki-source-fbadcd8591b65031efaaedce
    resource: repo://vitest.config.ts
generated: { by: "openwiki/0.9.0", at: "2026-11-17T00:09:40.208Z" }
---

# Testing, CI and release

Environment variables referenced here are defined on [configuration](../operations/configuration.md); runtime behaviour is described from the [architecture overview](../architecture/overview.md).

## Scripts

`package.json` requires Node `>=24.0.0` and defines: `build` (`tsc`), `start` (`node dist/main.js`), `dev` (`tsx src/main.ts`), `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `test:watch`, `lint` (`eslint src test`), `lint:fix`, `clean` (`rimraf dist coverage`) and `prepublishOnly` (clean, build, test). The package manager is pnpm; the published bin is `iit-mcp-hudu` at `dist/main.js`.

## Test layout

Vitest (`vitest.config.ts`) runs `test/**/*.test.ts` with globals enabled; coverage uses the v8 provider over `src/**/*.ts`, excluding `src/main.ts`.

- Top-level tests under `test/` mirror the core modules (config, auth, http, policy, doctor, lifecycle, search budget, boot-log fixtures).
- `test/tools/` covers the tool layer: dispatch, lists, reads, fetch-many, search policy/prose/tier behaviour, read-only mode, read-cache invalidation, result URL and credential handling, and surface-size and drift checks.
- `test/conformance/` holds placeholder env files and profile JSON for a surface audit, in a normal and a read-only variant.

The shared harness `test/helpers/mcp-session.ts` drives a real MCP session through `serveStdio` with a fake transport, so assertions see protocol-converted schemas and real `tools/call` dispatch. Hudu itself is stubbed at `globalThis.fetch`, and the default stub fails loudly if a test reaches it. Its base config uses stdio, the `all` write policy and a `.invalid` base URL.

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests, with read-only contents permission.

1. **verify**: Node 24.x, `pnpm install --frozen-lockfile`, then `build`, `typecheck`, `lint`, `test` and `pnpm audit --prod`.
2. **container** (after verify): builds the image and smoke-tests it. No package manager (`npm`, `npx`, `corepack`, `yarn`, `pnpm`) may exist in the runtime image; running it with no environment must print output naming `HUDU_API_KEY`; and with `PORT=9191`, `MCP_TRANSPORT=http` and `HUDU_ALLOWED_BASE_HOSTS=good.example.com` it must answer `/healthz` and refuse a tool call whose `x-hudu-base-url` is `https://evil.example.org` with "host not allowed".

## Container packaging

The `Dockerfile` has three `node:24-alpine` stages: `build` (installs all dependencies, compiles to `dist/`, and zeroes file mtimes so identical source yields identical layers), `deps` (production dependencies only; the package manager lives only here) and `runtime`. The runtime stage removes npm, corepack and yarn, copies `package.json`, `node_modules` and `dist`, runs as `USER node`, sets `ENV PORT=8787` with `EXPOSE 8787`, and has a `HEALTHCHECK` (30 s interval, 3 s timeout) that fetches `/healthz` on `PORT`, so it never touches Hudu. The command is exec-form `node dist/main.js`, so node is PID 1 and receives SIGTERM directly (shutdown handling is on the [overview](../architecture/overview.md)).

## Release manifests

`capabilities.json` and `server.json` carry the package version and are kept equal to `package.json`'s. `server.json` declares the streamable HTTP endpoint `/`, stdio support, the `/healthz` and `/doctor` endpoints, a per-request credential model, and a pinned `node-hudu` version that matches the exact dependency in `package.json`. `capabilities.json` maps capability IDs to served tool names. An SDK upgrade that changes the operation catalogue moves `BUILT_AGAINST_PLAN_HASH` in `src/tools.ts`, which a drift test compares against the installed SDK.
