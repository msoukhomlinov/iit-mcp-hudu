# Contributing to iit-mcp-hudu

Design of record: [`docs/architecture.md`](docs/architecture.md). Capability surface: [`docs/capability-matrix.md`](docs/capability-matrix.md) and [`capabilities.json`](capabilities.json). Scoping decisions: [`SCOPING.md`](SCOPING.md).

## Prerequisites

- Node 24 or newer.
- pnpm 12 (`corepack enable` picks the version from `package.json`).

## Setup

```
pnpm install
pnpm run build       # tsc -> dist/
pnpm run dev         # run from source (tsx)
pnpm run typecheck && pnpm run lint && pnpm test
```

No Hudu credential or live tenant is needed to build or test. Every test stubs `globalThis.fetch` (see `test/helpers/mcp-session.ts`); a test that reaches the network fails by design.

## Rules

- The tool surface is curated upstream in `node-hudu`; do not edit tool names or descriptions locally. A description that reads wrong is an SDK issue.
- No Hudu credential in any tool `inputSchema`.
- The server only narrows SDK authority (`HUDU_WRITE_POLICY`, `HUDU_SECRET_READS`); validation, dry-run and confirmation stay SDK-owned.
- Behaviour changes need a `CHANGELOG.md` entry and the right SemVer bump (minor for a behaviour change while 0.x).
- A new test is mutation-checked: revert the fix, see it fail, restore.
- No AI attribution in commits, PRs, comments or docs.

## Upgrading node-hudu

1. Bump the exact version in `package.json` and run `pnpm install`.
2. `pnpm test` fails on the catalogue plan hash if the SDK's operation set moved. Review that the change is only what the SDK changelog says, then update `BUILT_AGAINST_PLAN_HASH` and the counts in `test/tools/meta.test.ts`.
3. Re-read the SDK changelog for behaviour changes (content format, policy) and update `README.md`.

## Release checklist

1. `pnpm run typecheck && pnpm run lint && pnpm test`, and `pnpm audit --prod` clean.
2. Update `CHANGELOG.md`, bump `package.json` and `server.json` / `capabilities.json` versions together.
3. `pnpm pack --dry-run` shows only `dist`, `README.md`, `CHANGELOG.md`, `LICENSE`, `.env.example`.
4. Publishing to npm is a manual decision by the maintainer.
5. Deploy with `scripts/deploy.sh` (tags the image with the git short SHA; never `:latest`).
