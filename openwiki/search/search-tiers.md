---
type: architecture
title: Search tiers, budget and Typesense
description: How hudu_search chooses between the vendor, in-memory index and Typesense tiers, how the tier is policy under HTTP, how the body-index memory budget is derived from the heap, and what the Typesense probe reports.
tags: [search, typesense, index, budget, policy]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-17T00:09:40.208Z
sources:
  - id: openwiki-source-c388505a88e5f28dce116374
    resource: repo://src/search-budget.ts
  - id: openwiki-source-a20de129d9c1b43cec859e19
    resource: repo://src/tools/register.ts
  - id: openwiki-source-f72145d932a0d3f77213c2f1
    resource: repo://src/tools/search-policy.ts
  - id: openwiki-source-24bc0aaf0e253adb34218bff
    resource: repo://src/tools/search.ts
  - id: openwiki-source-34a2c34ee6aace22973a7030
    resource: repo://src/tools/typesense-probe.ts
generated: { by: "openwiki/0.9.0", at: "2026-11-17T00:09:40.208Z" }
---

# Search tiers, budget and Typesense

`hudu_search` (`src/tools/search.ts`) has modes `search`, `help` and `resources`. Environment variables mentioned here are defined on [configuration](../operations/configuration.md); the dispatcher path that reaches the same search operation is on the [tool surface](../architecture/tool-surface.md).

## Tiers

- `vendor`: Hudu's own search; body-blind, never builds an index.
- `index`: an in-memory body index of articles and assets, walked from the corpus; a call may wait for the walk.
- `auto`: answers from the vendor tier immediately and warms the index in the background.
- `typesense`: queries Hudu's Typesense index; no corpus walk, so no cold start. It is only offered when the Typesense pair is configured.

Every body tier is corpus-wide over **articles and assets**, with no scope parameter.

## Default tier selection

`registerTools` (`src/tools/register.ts`) computes the tier once per server:

1. If `HUDU_SEARCH_RESOURCES` excludes articles or assets (`bodySearchable` false) the default is `vendor` and cannot be overridden by `HUDU_SEARCH_TIER_POLICY`.
2. Otherwise `HUDU_SEARCH_TIER_POLICY` wins if set.
3. Otherwise `typesense` when the Typesense block is configured, else `auto` under HTTP and `index` under stdio.

Rationale in code: under stdio one long-lived credential owns one warmed index; under HTTP every caller scope starts cold and a corpus walk can outlast client timeouts.

## Policy under HTTP vs caller parameter under stdio

Under HTTP (`searchTierIsPolicy`), the served schema omits `tier` and `refresh`, and the input object is loose so a caller that still sends them reaches the handler and is told the value was overridden (`meta.policyOverride` with `stripped` and `appliedTier`). Under stdio the object is strict and both fields are served; the `tier` enum includes `typesense` only when it is configured. Unknown arguments are refused with a config error rather than ignored, and a field a mode cannot honour is refused naming the fields it does honour.

`applySearchPolicyToInvoke` (`src/tools/search-policy.ts`) applies the same rules to `operations.searchKnowledge` reached through `hudu_read`: a scope naming an excluded resource is refused before any request; under HTTP the tier is forced to the default with `refresh:false` (which is `vendor` when body tiers are excluded, so nothing is refused for the tier); under stdio, when body tiers are excluded, an explicit `index`, `auto`, `typesense` or `refresh:true` is refused and an omitted tier becomes `vendor`. Search failure metadata is sanitised so a credential's unreadable resources are not leaked, and a result where every resource was refused for credentials becomes an unauthorized error rather than zero hits.

## Waiting, progress and cancellation

A call that may wait (tier `index` or `refresh:true`) reports progress: a first tick after 2 s (`PROGRESS_FIRST_TICK_MS`) and then every 7 s (`PROGRESS_TICK_MS`), keeping each gap under the 10 s bound the code cites. If the request is already aborted before the SDK walk starts, the walk is not started and a cancelled answer is returned. The `hudu_search` default result limit is 8 (`SEARCH_DEFAULT_LIMIT`); the schema accepts 1-25 and `snippetChars` 0-400.

## Index budget (`src/search-budget.ts`)

The index is sized from the process's V8 heap limit (read in the server factory, see the [overview](../architecture/overview.md)):

- **Process pool**: one sixteenth of the heap, floored to whole MiB, clamped to 8-64 MiB (`indexTextBudgetBytes`).
- **Per scoped client**: the pool divided by `(SCOPED_INDEX_BUDGET_DIVISOR + SCOPED_INDEX_EVICTION_TRANSIENT) x caches`, where the divisor is 2, the transient is 1, and `caches` is 1 when `HUDU_WRITE_POLICY` is `deny` and 3 otherwise (read, write, delete). This is a sizing target, not a hard cap: concurrent distinct credentials can briefly exceed it.
- **Document cap**: one document per KiB of text budget, between 1 and 50,000 (`scopedIndexMaxDocs`).
- **Article reservation**: `indexDocCaps` reserves the whole document cap for `articles`, so assets only take what remains and can get none when articles fill the cap.

A capped or text-evicted index reports index state `partial`. The stdio parent client keeps the whole pool; HTTP scoped clients get the divided share. `HUDU_SEARCH_INDEX_TTL`, when set, becomes the SDK's `indexTtlMs`.

## Typesense tier

When configured, the SDK `search.typesense` block carries the URL, key, collection names, timeout and verify-hits flag; candidate count and circuit-breaker window are deliberately left to the SDK's own calibration. The tier is subject to the same corpus-wide gate as the index.

`probeTypesense` (`src/tools/typesense-probe.ts`) backs the live reachability report on `hudu_get_api_info`. It asks two separate questions with distinct codes: whether the SDK build has `operations.probeBodySearch` (otherwise `NOT_IMPLEMENTED`), and whether this client's policy exposes it, tested with `in` rather than `typeof` because the operations object is a Proxy (otherwise `POLICY_DENIED`). A throw without a string code reports `PROBE_FAILED`. Unconfigured deployments report `configured:false` with no request. Zero-wire shape-only reporting for the same tier is in `doctor` ([configuration](../operations/configuration.md)).
