---
type: concept
title: Write policy, read-only mode and secret reads
description: How the deployment gates writes (deny, allow_list, all, with HUDU_READ_ONLY as a hard override), how credential reads are refused, which operations are never reachable, and how refusals surface to the model.
tags: [security, policy, writes, secrets]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-17T00:09:40.208Z
sources:
  - id: openwiki-source-2b68006c6421e01c95988dcc
    resource: repo://src/config.ts
  - id: openwiki-source-1ae75ea6de7f8aac1d38180f
    resource: repo://src/policy.ts
  - id: openwiki-source-94132ae6c76263527640a457
    resource: repo://src/tools/company-context-policy.ts
  - id: openwiki-source-9a2d17e676ec16ff1706784b
    resource: repo://src/tools/dispatch.ts
  - id: openwiki-source-85648816930dc890fba8082d
    resource: repo://src/tools/server.ts
generated: { by: "openwiki/0.9.0", at: "2026-11-17T00:09:40.208Z" }
---

# Write policy, read-only mode and secret reads

`src/policy.ts` answers one question: **is this operation reachable in this deployment?** It never decides how a write is performed. Validation, the forced dry run and `confirm` for destructive calls stay in the SDK's `dispatchOperation`, which backs `hudu_read`, `hudu_write` and `hudu_delete`. Deployment policy only narrows the SDK's mode and effect gates. Variable defaults and boot validation are owned by [configuration](../operations/configuration.md); the tools themselves are described in the [tool surface](../architecture/tool-surface.md).

## Two independent policies

| Policy | Variable | Question it answers |
| --- | --- | --- |
| Write policy | `HUDU_WRITE_POLICY` (+ `HUDU_WRITE_ALLOW`, `HUDU_READ_ONLY`) | May a `write` or `destructive` operation run? |
| Secret-read policy | `HUDU_SECRET_READS` | May a read that can return a plaintext credential run? |

Both are absolute and independent: `operationPermitted` refuses a credential read under `HUDU_SECRET_READS=deny` even when the write policy is `all`.

### Write policy semantics

`policyAllows` decides by the SDK capability record's `effect`:

- Under `deny`, only an operation explicitly classified `read` is allowed; an unknown record is refused.
- Otherwise a record that is missing or not `write`/`destructive` is allowed (reads are never gated by the write policy).
- Under `allow_list`, a write/destructive operation is allowed only if its key is in `HUDU_WRITE_ALLOW`; under `all` it is allowed.

`HUDU_READ_ONLY=true` is a hard override applied once at server construction by `applyReadOnly`, which rewrites the config to policy `deny` with an empty allow list. Everything downstream (tool registration, SDK clients, catalog) sees that effective config. Refusal text names `HUDU_READ_ONLY=true` when the flag is set.

### Tool registration and SDK clients

`writeToolRegistered` decides whether `hudu_write` (effect `write`) and `hudu_delete` (effect `destructive`) exist at all: never under `deny`, always under `all`, and under `allow_list` only if the list holds at least one operation of that effect. `registerDispatchTools` skips unregistered modes.

In `src/tools/server.ts` each mode gets its own SDK client, built with `reveal: false`. The read client allows only read operations. Under `allow_list`, write and delete clients allow the reads plus the listed operations of their effect, along with write operations they depend on (for example `articles.patchSection` delegating to `articles.update`). Under `deny` no mutation clients are built. So the SDK client's own allow list still refuses an operation even if a gate in `policy.ts` were bypassed.

## Secret reads

Credential-bearing resources are `asset_passwords` and `password_folders` (`CREDENTIAL_RESOURCES`). `isSecretOperation` matches any operation key starting with `<resource>.` (the dot prevents sweeping in a similarly prefixed resource), so a newly added operation on those resources arrives denied. Unlike writes, these are ordinary reads, so the write policy alone would not stop them.

`assertSecretReadPermitted` throws before any Hudu request when the operation is secret and `HUDU_SECRET_READS` is not `allow`. It is called from the generic dispatcher (`src/tools/dispatch.ts`), the list tools (`src/tools/lists.ts`), the dedicated read tools for `asset_passwords.findBySlug` and `password_folders.resolve` (`src/tools/reads.ts`), and the search/resolve policy helpers (`src/tools/search-policy.ts`).

Credentials can also arrive indirectly. `redactCompanyContextCredentials` (`src/tools/company-context-policy.ts`) runs on `companies.getContext` results under `deny`: every `assetPasswords` row is projected to a safe-field summary regardless of `expand`, non-array values are dropped, and a narrowing is logged as a count only.

## Never-reachable operations

`NEVER_REACHABLE` holds operations refused whatever the policy; currently `asset_passwords.createShare`, which mints a live credential link and needs the SDK `reveal` capability that this server never grants. `assertNeverReachablePermitted` refuses it before any request, with the SDK's own reveal refusal as a second line.

## How refusals surface

All refusals throw `PolicyDeniedError` (SDK `POLICY_DENIED` vocabulary) with `retryable: false` and a suggested action not to retry, rather than `CONFIG_ERROR`, because the policy is fixed for the process lifetime and no argument can satisfy it.

Gate order in the `hudu_read`/`hudu_write`/`hudu_delete` handler (`src/tools/dispatch.ts`): write policy, secret-read policy, never-reachable, then search-policy input rewriting, then the SDK `dispatchOperation`. A refusal issues no Hudu request, so the SDK audit hook never sees it; each refusal is logged with `log.warn` carrying the operation key (and effect/policy) but never the input bag, since it can contain a credential or name the record being read.

The read-client cache clear that follows a real write or delete attempt is described in the [tool surface](../architecture/tool-surface.md#dispatcher-flow).

## Policy-aware catalog

`applyCatalogPolicy` and `applyDescribePolicy` (used in `src/tools/meta.ts`) mark policy-refused rows `reachable: false` with a reason (`refused by HUDU_SECRET_READS=deny`, `refused by HUDU_READ_ONLY=true`, or `refused by HUDU_WRITE_POLICY=<policy>`), so the model does not spend turns on calls that cannot succeed. The reachable/unreachable totals are adjusted globally from the whole catalog, not from the page's rows. Rows the SDK already refused keep their own reason.

## Boot logging

`logEffectiveWritePolicy` runs once at startup (`src/main.ts`). It logs at `info` when no write tools are registered and at `warn` when any are, so `LOG_LEVEL=warn` still records it. If `HUDU_READ_ONLY` is unset while writes are enabled it emits a second warning, because 0.2.x treated unset as read-only.
