# Changelog

## 0.11.0

**Upgrading from 0.10.0:** no configuration change. This release adopts node-hudu 0.24.0, whose
plain-path (non-Markdown) `articles.update` dry runs now verify `expectedUpdatedAt`.

- **Behaviour change:** a plain-path (block-HTML-body) `articles.update` dry run carrying
  `opts.expectedUpdatedAt` now issues the guard's single GET and adds a `precondition` check to
  the dry-run report — `updated_at matches|differs (expected X, found Y)` — returning
  `wouldApply: false` on a stale revision instead of the 0.23.0 zero-request `wouldApply: true`
  preview (node-hudu#43, node-hudu PR #129). The live commit still throws `STALE_OBJECT`, the
  Markdown path still throws `StaleObjectError` in a dry run, and a dry run without
  `expectedUpdatedAt` stays zero-request.
- Dependency: `node-hudu` 0.23.0 -> 0.24.0. `BUILT_AGAINST_PLAN_HASH` is unchanged: the node-hudu
  0.24.0 capability-catalog hash is byte-identical to 0.23.0's (served text frozen in that
  release), which the pin bump re-verified.
- Test: `test/tools/dry-run-precondition.test.ts` — a stale plain-path dry run fetches the record
  and reports `wouldApply: false` with the precondition detail and the current record's
  `target.name` / `target.updated_at`; a matching revision reports `wouldApply: true`; a dry run
  without `expectedUpdatedAt` stays zero-request. Fails against the 0.23.0 install.
- **Behaviour change:** a committed `hudu_write` on `articles.create`, `articles.update` or
  `articles.patchSection` now returns a summary — `{ id, name, slug, updated_at, url,
  content_match, sent_bytes, stored_bytes }`, plus `element_deltas` (table/pre/a/img,
  stored-minus-sent) when `content_match` is false — instead of the full stored record with
  its body (issue #63: 13 real-session writes had echoed 324,044 chars of stored HTML, 71% of
  every character the server returned). `content_match` compares the stored body with the body
  the pinned node-hudu sent: verbatim for a block-HTML body or an explicit
  `opts.format: 'html'`, otherwise the pinned `markdownToHtml` of the Markdown — a Hudu image
  `src` rewrite to `/public_photo/<slug>` is the expected false. `articles.patchSection`
  carries the documented weaker presence check (the server does not hold the pre-patch body),
  and a field-only `articles.update` carries no `content_match` / `sent_bytes`. Dry runs and
  every other operation (including `pin` / `unpin` / `archive`) are unchanged. The stored body
  stays available via `articles.get` with `opts.format: "html"` or `hudu_fetch_many`.
- Test: `test/tools/write-summary.test.ts` — 11 cases: the Markdown and both verbatim paths
  for create and update, the element-delta mismatch, `patchSection` presence true/false, a
  field-only update, the full dry-run shape, `folders.create` unchanged, and the
  unexpected-shape passthrough. `BUDGET_WRITE` moved 28,350 -> 28,507 for the new `hudu_write`
  sentence (the measured delta, 200 B margin kept) and the frozen unset surface was
  re-recorded (write profiles only; the deny profiles are byte-identical).
- Fix: the served `hudu_write` prose and the README now name both article-body paths — a body
  opening with block HTML, or an explicit `opts.format: 'html'`, is stored as sent and
  unguarded; otherwise Markdown, converted, guarded on `articles.update` (issue #64: the loss
  guard and the dry-run staleness check run on the Markdown `articles.update` path only).

## 0.10.0

**Upgrading from 0.9.1:** no configuration change. This release adopts node-hudu 0.23.0 and
documents its text-channel tolerance in the three dispatch tools' descriptions.

- Dependency: `node-hudu` 0.22.0 -> 0.23.0. `operations.invoke` now accepts the exact string
  literal of a value in a declared `integer` / `number` / `boolean` field of the
  `hudu_read` / `hudu_write` / `hudu_delete` `input` bag: `"61"` for an id, `"25"` for a limit,
  `"true"` for a flag. A text-channel client (e.g. a Copilot Studio bot that quotes every
  argument) that reads a company id out of a search hit and sends it quoted now gets the company
  instead of a `CONFIG_ERROR`; the converted value dispatches and addresses the same record as
  the unquoted number. Any other string is refused exactly as before, and the #97 path-traversal
  protection is preserved (node-hudu#128).
- Change: the `hudu_read`, `hudu_write` and `hudu_delete` descriptions now state that tolerance
  in one sentence (verbatim from the node-hudu contract text). The size budgets in
  `test/tools/surface-size.test.ts` moved deliberately for this change and the frozen unset
  surface in `test/tools/surface-unset-frozen.test.ts` was re-recorded (deltas are exactly the
  sentence bytes: 543 B write profile, 181 B read-only).
- Test: `test/tools/text-channel-tolerance.test.ts` — `hudu_read` with `operation:
  "companies.get"` and `input: { id: "61" }` dispatches `GET /companies/61`; `id: "abc"` is
  refused with `expected integer, got string` and issues zero requests (iit-mcp-hudu#62).

## 0.9.1

**Upgrading from 0.9.0:** no configuration change. This release sharpens the argument prose a calling
model reads without asking for help, and refuses arguments `hudu_search` does not implement.

- Change: `hudu_search`'s `company_id` description now states the filter's real semantics — a
  **numeric** id only (a company name cannot be filtered: the Typesense tier sends the number into
  `filter_by` and the vendor path compares the number), and omission means all companies **plus
  global articles**, which is the wide answer rather than a narrow one. `resources` now says what the
  list means ("only these resource types") and that fewer collections is less work. Funded by trimming
  redundant prose in `mode` / `updated_since` / `min_score` / `query`, so the served `tools/list`
  surface is **byte-identical in size** to 0.9.0; the frozen hashes were re-recorded and say why.
- Fix: the loose `http` argument object accepted and **silently ignored** any argument the tool does
  not implement. Measured on 0.9.0: `asset_layout_id` (advertised by `mode:"resources"` as an assets
  filter) returned unfiltered results with no signal — a dropped filter answers a different question
  than the one asked. Unknown fields are now refused with a named error, and the looseness is kept
  only for the policy-owned `tier` / `refresh`, where `meta.policyOverride` already discloses the
  override. `stdio` stays strict.
- Documentation: the Typesense tier's 8-finding adversarial audit is closed. Seven were fixed in
  `node-hudu` 0.22.0 (pre-scoring cap in Typesense's ranking order, non-numeric ids miscounted as a
  page cap, a 401 from one collection masking a healthy sibling, the probe reading only `articles`,
  the `hydrated` count's meaning, `verifyHits:false` disclosing nothing, and per-hit provenance now
  carried by the required `source` field); Q8 was clean. Q7 (silent partial LRU body eviction under
  `maxIndexTextBytes`) remains an unverified live-environment question and is not claimed as fixed.

## 0.9.0

**Upgrading from 0.8.0:** no configuration change. The pinned `node-hudu` moves from 0.21.0 to 0.22.0,
which closes four MAJOR and three MINOR defects in the Typesense body tier found by an adversarial
audit. Nothing changes for a deployment that leaves the tier unset.

- Add: `probeBodySearch` results now carry the additive per-collection `results[]` field
  (`node-hudu` 0.22.0). The probe report maps it when present, so a caller can see WHICH collection
  answered or failed instead of only the aggregate `reachable`.
- Change: the pinned SDK's tier is honest about its bounds. Articles are hydrated in full through a
  bounded pool of reads (so title matches ranked 11+ reach the local scorer), `meta.typesense` splits
  `capped` / `unreadable` / `unscored`, the circuit breaker is per collection, a 401 from one
  collection is no longer reported as a bad key when a sibling answered, and `verifyHits:false`
  discloses that the tier contributed no hit. See `node-hudu` 0.22.0 release notes.

## 0.8.0

**Upgrading from 0.7.0:** no configuration change for any existing deployment. Six new optional
variables turn on a Typesense body tier; with both `HUDU_TYPESENSE_URL` and `HUDU_TYPESENSE_API_KEY`
unset, the default tier, prose, the served tool schema, the doctor report, boot output and search
results are byte-identical to the env-wiring head (#59, 41ad81e) — not to 0.7.0, whose `hudu_read`
description differs; the frozen-surface test proves identity to that head only. node-hudu is pinned at
0.21.0 (exact), which is the release
that types `search.typesense` — the boundary cast the tier needed is gone.

- Add: `HUDU_TYPESENSE_*` configure the optional Typesense body tier and the SDK client is built with
  the resulting typed `search.typesense` block. The pair is set together or not at all: one without
  the other fails boot naming both, the URL must be an http(s) origin (no path, query, fragment or
  userinfo), the two collection names must differ, and the deadline is bounded at 15000 ms. The key
  is never logged and never returned by a tool. `HUDU_TYPESENSE_VERIFY_HITS` accepts any case and
  treats a blank as unset.
- Add: optional **Typesense body tier**. It searches Hudu's own Typesense index, so article bodies
  and asset custom-field text are covered for the WHOLE corpus instead of the in-memory index's
  heap-capped slice. `HUDU_TYPESENSE_VERIFY_HITS` (default `true`) is the credential re-read flag:
  the SDK re-reads every hit through the Hudu API under the caller's own credential, because Hudu's
  index carries neither folder permissions nor deletions. This repo sets the flag (a test asserts it
  reaches the client) and has not measured the re-read. `false` is documented as single-tenant,
  non-restricted, read-only deployments only.
- Add: `HUDU_SEARCH_TIER_POLICY` accepts `typesense`, and when the pair is configured the default
  tier is `typesense` under **both** transports — the cold-start asymmetry `auto` exists for does
  not apply to an index that is already built. Naming `typesense` without the pair is a startup
  error, never a silent fallback, and so is naming it on an SDK build whose catalogue lacks the
  probe operation. The corpus gate is renamed `bodySearchable` and now covers every body tier: when
  `HUDU_SEARCH_RESOURCES` excludes articles or assets, the policy stays `vendor` and a request for
  `index`, `auto` or `typesense` is refused, naming both body tiers.
- Add: `hudu_get_api_info` reports `typesense: { configured, reachable, collections, probeMs }`
  when the tier is configured (absent otherwise), from the SDK's one-request probe that a
  search-only key may run; `error {code, message}` appears only when the probe could not answer, and
  its code says which question failed — `NOT_IMPLEMENTED` (this SDK version has no probe),
  `POLICY_DENIED` (the client's policy does not permit it), `PROBE_FAILED` (the call threw without a
  string code, so the failure cannot be attributed) or the endpoint's own code. The tool
  description names each field, and a test pins the exact emitted key set, because the output schema
  keeps that field open (`z.unknown()`) to stay inside the `tools/list` byte budget. `doctor` stays zero-wire: it gains a config-shape row
  (`configured`, `keyPresent`, `urlShapeOk`) only, and the row is absent when the tier is off.
- Docs: `hudu_search` help names `meta.bodySource` (`index` | `typesense` | `none`) and all five
  Typesense degraded reasons, grouped by what the operator must do — `typesense-unavailable`
  (refused or timed out: check URL, tunnel, egress), `typesense-query-error` (the collection name or
  query is wrong: Typesense answered 400/404/422, so the fix is `HUDU_TYPESENSE_*_COLLECTION` and
  NOT an outage), `typesense-unauthorized` (key rejected), `typesense-hits-stale` (records still in
  Hudu's index that this credential can no longer read: retry later or widen), and
  `typesense-hits-unhydratable` (candidates unreadable for structural reasons — no company_id,
  deleted layout, no usable id — so the data is the cause, not staleness). The staleness entry also
  carries a stated LIMITATION: which answer Hudu returns for a permission-hidden record is
  unverified upstream (that needs a live tenant). What is settled is the split — a 404 is a silent
  stale drop (the record is genuinely gone), while a 403 is a surfaced read failure, so the answer
  reports `complete: false` and names the resource in `meta.errors` and a hidden record is not folded
  into staleness. Reported as a limitation, with no sixth degraded reason invented for it. The five strings live in
  ONE exported literal (`TYPESENSE_DEGRADED_REASONS`, in the SDK's union order) that both the help
  builder and the test read, so the prose cannot drift from the assertion; this server holds no
  schema enum of its own for them. `degraded.reason` is passed through unchanged — a walk test feeds
  each of the five, and a reason the server has never seen, and asserts the response and the text
  carry them verbatim, because a rename here would break the pairing silently. The compact result
  header states the body source. The tier sentence
  names the corpus resolution where it states the policy: on a deployment that excludes articles or
  assets, a configured Typesense tier is corpus-wide too, so the corpus gate resolves it to `vendor`
  and the answer carries no body source. All of it is present only where the tier is configured, so
  the unset surface stays byte-identical. README and `.env.example` document the six variables, the
  reach modes (LAN, SSH tunnel, allow-listed egress) and the verification trade.
- Add: the five reason strings live in ONE exported literal (`TYPESENSE_DEGRADED_REASONS`), and
  `test/tools/typesense-tier.test.ts` compares that literal against the SDK's union at test time, in
  order. The server does not compare at runtime: it prints the reason it receives verbatim. Counts
  stay disclosures, never reasons.
- Tests: config XOR both ways, defaults and every refusal branch, key never echoed; the block
  reaching every SDK client and staying absent when unset; the default-tier matrix
  (`configured`/`unset` x `stdio`/`http` x full/excluded corpus); the schema enum and the prose (only
  when configured); `bodySource` header rendering; the api_info probe block and its emitted key set;
  the doctor row without key material; the capability gate failing on a mock SDK without the probe;
  the runtime enum comparison against the SDK's; and a documentation drift test derived from the
  config schema rather than a hand-written list.

## 0.7.0

**Upgrading from 0.6.1:** no configuration change. The articles in the body index are now reserved their slots, so an account with many more assets than articles indexes every article instead of the freshest few: the 512 MiB write-enabled profile derives a 1,820-document cap against a larger article corpus and therefore indexes no assets at all (they stay searchable through Hudu's own title search). node-hudu is now 0.20.0, and `meta.index.docs.<resource>.capped` reports what the caps dropped. Serve over `http` with a 1 GiB container to index a whole midsize article corpus.

- Fix: articles can no longer be crowded out of the body index by assets. node-hudu 0.20.0 adds `search.maxDocsByResource`, a hard reservation inside `maxDocs`; the server now names `articles` with the WHOLE document cap, so articles keep their slots (up to the cap) and assets fill whatever room is left, in `updated_at` order. MEASURED on the production tenant (19,991 assets + 3,204 articles = 23,195 documents): without a reservation the 21,845-document cap retained 19,991 assets and 1,854 of the 3,204 articles, so 1,350 articles had no index entry at all while asset rows (titles and custom fields, no long text) held 91% of the cap; 0.6.1's expectation that dividing the pool by two would keep every article was therefore false. With the cap reserved, that tenant's 21,845 documents hold all 3,204 articles and the remaining 18,641 asset slots (arithmetic from the SDK's reservation semantics, verified with a synthetic probe: 10 articles + 500 assets at a 100-document cap give 10 + 90, and 300 articles + 5 assets give 100 + 0). The asset share is derived and can be zero: assets keep `maxDocs - min(articles, maxDocs)` slots, so the 512 MiB write-enabled profile (a 1,820-document cap against 3,204 articles) indexes no assets and leans on Hudu's own title search for them. A quarter-reservation was rejected because a reservation is also a hard ceiling on the named resource (300 articles + 5 assets at a 100-document cap retained 30 documents with a quarter, 100 with the whole cap).
- Chore: node-hudu 0.19.0 -> 0.20.0 (`server.json` `versionRange` 0.20.0). The SDK's other change also reaches us: `search.maxDocsByResource` is the only new option, and `meta.index.docs.<resource>.capped` (documents dropped per resource by the caps) now travels through `sanitizeIndexMeta` unchanged.

## 0.6.1

**Upgrading from 0.6.0:** no configuration change. Each scoped client's body index is deeper: a read-only http deployment gives one credential a third of the pool instead of an eighth. A write-enabled deployment on a small heap gets a shallower index than 0.6.0 (a ninth of the pool), because the eviction margin and the per-mode caches are both counted.

- Fix: a read-only http deployment now gives each scoped client a THIRD of the pooled index text budget instead of an eighth (the pool is divided by two clients per cache plus one eviction of margin), so the body index is deep enough to search the articles it holds. MEASURED on the production tenant (2026-10-26) with the former division by eight at 1 GiB: a scope retained 4,666 assets and 1,478 of 3,204 articles; 1,036 article bodies were indexed, 317 had been evicted by the text budget and 3 truncated (the counts do not decompose the 1,478 — some retained articles carry no body text). The cause is the SDK's document cap, which keeps the freshest `updated_at` across ALL resources, so newer assets displaced older articles. A read-only deployment at a ~816 MB V8 ceiling now gets 17 MiB of text and 17,408 documents per scope instead of 6 MiB and 6,144 (INFERRED to keep all 3,204 articles and about 2,800 of their bodies, from the measured article density at 6,144; the SDK's cap is global, so this is an expectation, not a guarantee); a 512 MiB container gets 5.33 MiB and 5,461 instead of 2 MiB and 2,048. The document cap lost its 1,500-document floor and now follows the share (one document per KiB): the smallest pool with writes (an 8 MiB pool, 932,067 bytes per client) gets 910 documents instead of a 1,500-document cap above its own share. The pool is also divided by the number of per-mode caches: a read-only deployment creates one (`read`), a write-enabled deployment three (`read`, `write`, `delete`), because each mode entry keeps its own cache of scoped clients, and each cache's clients are counted with one extra eviction transient (the scope the LRU just dropped while an in-flight request finishes). So a write-enabled deployment gets 5.67 MiB and 5,802 per scope at ~816 MB, and a write-enabled 512 MiB container gets LESS than before (1.78 MiB and 1,820 instead of 2 MiB and 2,048) because the eviction margin is now counted, and in every profile the share is sized so the cache capacity (clients x caches) plus one eviction per cache stays within the pool; concurrent evictions beyond that margin can exceed it until their requests finish, because the SDK cannot revoke a live index. This also corrects a pre-existing oversubscription, since with eight shares three caches could hold 144 MiB of text against a 51 MiB pool. The trade is breadth for depth: at most two (origin, credential) pairs stay warm per mode cache, and a credential occupies one client per cache (read, plus write and delete when writes are enabled), so a deployment serving more credentials also loses each evicted scope's read-through TTL cache and re-fetches more from Hudu, and rebuilds an evicted index on demand (searches answer from the vendor tier meanwhile, unless `HUDU_SEARCH_TIER_POLICY=index` makes the call wait on that rebuild, with progress and cancellation), and a deployment needing both breadth and depth needs a larger heap. `MAX_SCOPED_CLIENTS` still equals `SCOPED_INDEX_BUDGET_DIVISOR` (now 2); the per-mode cache count (3: read, write, delete) is the second divisor, and `SCOPED_INDEX_EVICTION_TRANSIENT` (1) is added to the per-cache count before multiplying — it is a margin, not a third multiplicand.

## 0.6.0

**Upgrading from 0.5.1:** under `MCP_TRANSPORT=http` the served `hudu_search` schema no longer offers `tier` or `refresh`, and the tier is server-side policy: `auto` by default, so a call answers from the vendor tier while the index builds. Set `HUDU_SEARCH_TIER_POLICY=index` for an http deployment that should wait. The body-index text budget and document cap are now derived from the process heap (a sixteenth of the V8 ceiling) instead of the SDK's 64 MiB / 50,000 defaults; no configuration change is needed. Under `stdio` the default tier stays `index` and both fields are still served.

- Fix: `hudu_search` no longer blocks a caller on a cold body-index walk under `MCP_TRANSPORT=http` by default (#49): the default policy there is `auto`, which answers from the vendor tier while the index builds. `HUDU_SEARCH_TIER_POLICY=index` opts an http deployment back into that wait, by design. A raw `hudu_read` call that still carries `tier`/`refresh` is answered by policy and says so: `meta.policyOverride` records `{ stripped, appliedTier }` and the response text names the override. The served schema there omits `tier` and `refresh` (a request that still sends either is served by the policy path), the call answers from the vendor tier while the index builds in the background, and `meta.index` / `meta.degraded` report the index state and any body-blind answer. Under `http` the raw `hudu_read` path to `operations.searchKnowledge` follows the same policy; under `stdio` a raw call that omits `tier` keeps the SDK's `auto` default, while `hudu_search` defaults to `index`. New `HUDU_SEARCH_TIER_POLICY=auto|index|vendor` (default `auto` under http, `index` under stdio, `vendor` when `HUDU_SEARCH_RESOURCES` excludes the corpus) and `HUDU_SEARCH_INDEX_TTL` (milliseconds, the SDK's index TTL; default 600000). Under `http` with `HUDU_SEARCH_TIER_POLICY=index` the tool description now says the tier is server-side policy even when the search set is the full corpus (it used to fall back to the SDK's caller-choice sentence there). `stdio` behaviour is unchanged.
- Fix: the body-index text budget is now sized to the process heap (`maxIndexTextBytes` = a sixteenth of the V8 heap ceiling, clamped to 8-64 MiB), so a 512 MiB container reports index state `partial` instead of dying with `Reached heap limit` and restarting mid-search (#51). The budget is derived per process, not configurable by env, and it is a POOL for the process: each scoped client in the http cache receives `floor(pool / 8)` (whole MiB, never below 1 MiB), so eight warm credentials cannot each claim the whole text budget and multiply it by the cache size. The sizing is an ESTIMATE, not a proof. The ~90 MB baseline heap and about 4 bytes of index structures per byte of text ACTUALLY HELD come from the #51 crash trace (a 252 MB peak on the production tenant), and that measurement IS a 512 MiB container running the SDK-default 64 MiB budget: the index held ~41 MB of that budget, and ~90 + 4 x 41 = ~254 MB reconciles with the measured peak, whereas the same ratio read against the 64 MiB budget would predict ~346 MB, which the trace never saw. MEASURED: a standalone walk of a synthetic 25,000-asset / 3,300-article tenant through the real SDK client under a ~262 MB V8 ceiling (an uncommitted one-off probe under `node --max-old-space-size=259 --max-semi-space-size=1`) peaked at ~136 MiB with this budget (25 MiB pool, 25,600 docs) and ~147 MiB with the OLD 64 MiB / 50,000 settings; both survived. MEASURED END TO END BEFORE THE CHANGE (round 10): `dist/main.js` under `node --max-old-space-size=259 --max-semi-space-size=1` peaked at ~188 MB heapUsed (~69% of the 259 MiB ceiling) while building the 25,000-asset / 3,300-article index over stdio; it survived (exit 0, 12.0 s), walked 28,300 documents and retained 26,624 with index state `partial`. bodiesEvicted was 0, so that run did not exercise text eviction. Measured structures were 187.96 - 24.6 = ~163 MB; against a ~90 MB production baseline that extrapolates to ~253 MB, ~98% of 259 MiB and no usable margin. The stub corpus is synthetic and its bodies and baseline heap are smaller than production's. That is a LOWER BOUND for production: the honest round-10 extrapolation was ~253 MB (~98% of 259 MiB). MEASURED END TO END AFTER THE CHANGE (round 11, one sixteenth): the same SHAPE of probe peaked at 118.51 MB against a 27.57 MB base, so structures cost ~90.93 MB; it retained 16,384 documents (articles 3,300, assets 13,084), reported state `partial`, and bodiesEvicted was 0. The extrapolated production peak is ~90.93 + 90 = ~180.93 MB, ~70% of 259 MiB and ~26 MB below the 207 MB (80%) target. The probe script is not committed and the stub was recreated for this round, so the delta also reflects stub differences; the production figure remains an extrapolation. The claim remains that the budget bites and reports `partial`, not that a build cannot exhaust the heap. The text budget alone bounds index TEXT, not the index: a document whose text it evicted keeps its record and postings, the SDK's own default is 50,000 documents, and a walk can reach 250 pages x 100 rows x 2 body resources. So the same heap-derived pool now also sizes `maxDocs` (one document per KiB of text budget, clamped to 1,500-50,000): 512 MiB -> 2 MiB of text and 2,048 documents per scoped client (16,384 for the stdio pool), 1 GiB container's ~816 MB V8 ceiling (an ASSUMED ~80% container-to-heap ratio; the MEASURED 512 MiB ratio is ~50.6%, 259 MB) -> 6 MiB and 6,144 per client (50,000 for the pool), and a 1024 MB ceiling -> 8 MiB and 8,192. The ~1 KB of record plus postings per document is an ESTIMATE, so the pair bounds growth without proving a peak; a document past the cap is not RETAINED (the freshest are kept and the index reports index state `partial`, as it already did for the text budget). The SDK upserts every walked document and applies the cap only AFTER the walk, so `maxDocs` bounds the retained index, not the build-time peak; the peak during a walk is bounded by the heap ceiling and the text budget's eviction. All ~3,300 tenant articles fit at the 1 GiB figure, Which documents a small heap's cap truncates first is INFERRED, not measured: title-only assets are the expected first loss. The end-to-end server run kept 16,384 of 28,300 documents and did not observe the order. The trade is explicit: a deployment holding several credentials builds shallower indexes; a deployment needing depth should raise the container memory or serve over stdio, where one long-lived credential owns the whole pool.
- MEASURED (standalone probe, not committed): the body-index peak under the ROUND-10 tenth settings is ~136 MiB on a synthetic 25,000-asset / 3,300-article tenant at a ~262 MB V8 ceiling (an uncommitted one-off probe under `node --max-old-space-size=259 --max-semi-space-size=1`); the OLD 64 MiB / 50,000 settings peaked at ~147 MiB and also survived. This is a LOWER BOUND for production: the honest round-10 extrapolation was ~253 MB (~98% of 259 MiB), and the round-11 sixteenth measured 118.51 MB peak against a 27.57 MB base (90.93 MB structures), extrapolating to ~181 MB (~70%). Issue #51's trace remains the only production measurement (~252 MB peak on the old 64 MiB budget). The `maxDocs` review that used to sit in this item is done: `search.maxDocs` is now capped from the same pool (see above).
- Practice: `hudu_search` reports progress while it WAITS on a body-index build (#52). With a `_meta.progressToken` on the call, a stdio call that will wait (an explicit `tier: "index"`, or `refresh: true`) sends `notifications/progress` after 2 s and then at most every 7 s (the cadence is held below #52's 10 s bound, since `setInterval` never fires early), carrying elapsed whole seconds only - the walk's page count is not observable through the SDK, so no `total` and no percentage is sent. The wait, the ticks and the cancellation are transport-independent: `http` with `HUDU_SEARCH_TIER_POLICY=index` waits too. A cancelled request (`ctx.mcpReq.signal`) stops waiting and answers the honest degraded result (`meta.degraded.reason: "body-not-indexed"` with `meta.cancelled: { during: "index-build", waited }`; `meta.reasons` stays empty because no bound bit) instead of throwing; a rejected or throwing notification never fails the call. The cancelled answer's advice is transport-aware: under `stdio` it still offers `tier:"vendor"`, under `http` it says to retry because the body index keeps building in the background (no tier field is served there). Its `meta.index` omits the SDK's optional `builtAt` / `ageMs` entirely - no generation was scored, so neither is published - while `docs` stays the required empty record, meaning "no generation recorded", never "zero documents". Only the waiting paths tick - `auto` answers at once and `vendor` never touches the index. The raw invoke path (`hudu_read` of `operations.searchKnowledge`) gets the same ticks and the same cancelled answer, and a request already cancelled when the call arrives starts no walk at all (its answer reports index state `cold`, meaning no generation was observed by that call — a warm stdio index is possible and the answer does not claim otherwise).
- Practice: the served `tools/list` surface is 27,470 B (write profile, 19 tools) / 22,742 B (read-only, 17 tools) in the default configuration, instead of 39,444 / 33,899 (#52), and `hudu_search` alone is 2,626 B instead of 5,121. The largest figures across the supported tier policies are 27,511 / 22,783 / 2,667 B (stdio with `HUDU_SEARCH_TIER_POLICY=vendor`). Each binding ceiling now keeps at least 200 B free (217 B read-only, 233 B `hudu_search` in that configuration; the contract's split is 23,000 B read-only / 28,000 B write-enabled), and the gate asserts that margin explicitly so the next edit fails with a plain message instead of a one-byte miss. This round also moved the last low-value clauses to the on-demand surfaces: `hudu_search`'s resource default (the enum lists it) and its `min_score`/`topic` explanations (help topic `query`), the `asset_layouts` page detail (its operation contract), and the `hudu_list` "prefer this over" hint; `hudu_resolve_any`'s `resources` field gained back its enumerated default and the pre-request refusal rule. Every tool's description is now server-owned compact prose (`src/tools/tool-prose.ts`): what the tool does and what happens when a bound bites, once; the repeated paragraphs (bounds, credential refusal, article format, filter lists) moved to the surfaces that exist for them (`hudu_describe_operation`, `hudu_list_operations`, `hudu_search` mode:"help"). Machine-enforced semantics (modes, refusal codes, limits, tier defaults per transport) are unchanged. The ONE served-schema difference under `http` is that `tier`/`refresh` are omitted and the input object is loose (`additionalProperties: {}`), so a client-sent value still reaches the handler and is reported as an override (`meta.policyOverride`, named in the text) instead of being rejected at parse time as under `stdio`. The heap-derived index budget and document cap are new on BOTH transports and replace the SDK's 64 MiB / 50,000 defaults. `test/tools/surface-size.test.ts` now measures `{default, auto, index, vendor} x {stdio, http}` and fails if a write profile exceeds 28,000 B, a read-only profile 23,000 B, or `hudu_search` 2,900 B in any of them, or if a read-only or `hudu_search` measurement leaves less than 200 B of headroom.

- Docs: the `hudu_search` input object is deliberately LOOSE over `http` only. `tier` and `refresh` are not served there, and the looseness is what lets a caller that still sends one reach the policy path and be told so (`meta.policyOverride` names the stripped fields and the applied tier). Tightening the http object to `.strict()` would reject the field before the handler could report the override and break that documented path; `stdio` serves both fields and stays STRICT, so an unknown argument there is refused rather than silently ignored. A code comment in `src/tools/search.ts` says so.
- Docs: `refresh` is stated honestly in the stdio field description and in help mode: it rebuilds THIS SERVER'S local body index, changes nothing in Hudu, can take minutes and is stdio-only. `hudu_search` keeps `readOnlyHint: true` because the hint describes the target system, which a rebuild never writes.
- Docs: the Mermaid form written by the Hudu UI editor is now verified. It stores `<pre class="language-mermaid" data-id="…"><code class="language-mermaid">…</code></pre>`, the same shape the SDK writes plus editor `data-id` attributes; a Markdown round trip keeps the diagram text and drops the `data-id` attributes. Replaces the earlier "unverified" caveat.

## 0.5.1

**Upgrading from 0.5.0:** no configuration or client changes needed; behaviour only. A record read (get, getSection, fetch_many, article context) after a `hudu_write` / `hudu_delete` in the same server process now returns the written data instead of the cached pre-write record. A write from another process or deployment can still be served stale for up to the cache TTL (caches are per process). The `hudu_search` body index is a separate store that a write does not refresh: after a write, pass `refresh: true` or wait for the index TTL (SDK default 10 min) before relying on a body search to find new text.

- Fix: record reads (get, getSection, fetch_many, article context) after a write are fresh in the same process: the server now clears the read client's cache after every write or delete attempt (node-hudu 0.19.0 `clearCache()`); previously a read after a write could return the pre-write record for up to the cache TTL (5 min for articles). A dry run and a policy refusal do not clear. The `hudu_search` body index is not refreshed by a write (`refresh: true`, or the 10 min index TTL) (#45, refs #25).
- Dependency: node-hudu 0.18.0 -> 0.19.0 (exact pin). Plan hash unchanged (`9d110798...`); operation set unchanged (236).
- Docs: correction to the 0.3.0 line. `articles.resolve`, `articles.getContext` and `hudu_get_article_context` return an article summary with no body by default, so they set no `markdown_lossy` / `markdown_lossy_codes`; only `opts.expand: true` returns a Markdown body that can carry the signal. README and architecture note updated.
- Docs: Mermaid stored form. Observed live, a ```mermaid fence is stored as `<pre class="language-mermaid"><code class="language-mermaid">...</code></pre>` and round-trips losslessly through `articles.get` and `patchSection`; the read path accepts both that and the bare `<pre>` form. A save made in the Hudu UI editor is not yet verified.
- Docs: README notes that `HUDU_READ_ONLY=true` makes `hudu_write` / `hudu_delete` a JSON-RPC `-32602` "tool not found", and that `asset_passwords.deleteShare` of a missing share returns 404 `NOT_FOUND` every time; SCOPING notes the live stdio `tools/list` sizes (39,436 / 33,891 B); the per-user-identity decision record gains the 2026-10-25 sandbox data points.

## 0.5.0

**Upgrading from 0.4.0:** clients now see `markdown_lossy` / `markdown_lossy_codes` on `articles.getSection`, with a section-specific note (the signal describes the whole article, so the loss may be in another section). Whole-article read text is unchanged. `hudu_list` compact rows are unchanged. node-hudu 0.17.0 -> 0.18.0, plan hash re-stamped to `9d110798...`, operation set unchanged (236).

- `articles.getSection` lifts the SDK's whole-body `content_loss` into `markdown_lossy` / `markdown_lossy_codes` like the other article reads; `content_loss` is never passed through. This supersedes the 0.4.0 note that section reads carry no signal (#42, #39).
- `COMPACT_FIELDS` is built from the SDK's `SUMMARY_FIELDS` plus explicit extras (`created_at`, `url`), with a test that derives from the SDK and a literal pin of the final lists, so SDK drift fails CI. Served rows are byte-identical (#42, #39).
- Dependency: node-hudu 0.17.0 -> 0.18.0 (exact pin). Plan hash re-stamped to `9d110798...`; operation set unchanged (236).

## 0.4.0

**Upgrading from 0.3.0:** `hudu_list` now returns compact summary rows by default. Callers that read custom `fields`, article `content` or layout `fields` from list rows must pass `expand: true`. Everything else is additive or a fix.

- Docs: `articles.getSection` carries no `markdown_lossy` signal (node-hudu drops `content_loss` inside `readSection`); the README now says so and a test pins it. Read the whole article with `articles.get` to learn whether a body is lossy.
- Behaviour change: `hudu_list` serves compact summary rows by default (the node-hudu `*Summary` field sets, plus `url` / `created_at` / `updated_at`) instead of full records, cutting a default page from ~49-88k to under 20k characters. `expand: true` returns the full records as before. Envelope, `page_size` default 25 and `asset_layouts` paging (no `page_size`) are unchanged. Callers that read custom `fields`, article `content` or layout `fields` from list rows must pass `expand: true` (issue #22).
- Fix: the 401 shape annotation is bound to the call (AsyncLocalStorage) instead of module-level state written per request, so under http a 401 never carries another concurrent request's credential anomalies (#16).
- Fix: a 401 is annotated only with the anomalies of the credential actually presented on that call (the request key wins over the server-held `HUDU_API_KEY`; the env key's anomalies join only when it is the one dialed), and `hudu_search`'s fully-refused branch now carries the same annotation as every other tool (#16).
- Fix: `hudu_search` and `hudu_read` `operations.searchKnowledge` / `operations.searchAcrossResources` now refuse a malformed `x-hudu-api-key` (`CREDENTIAL_MALFORMED`) and an origin outside the allow-list (the `AUTH_ERROR` envelope other tools return) before any request, instead of returning a successful 0-hit result (#32).
- Fix: the same search paths now refuse every other refusing client state (key with no origin, invalid base URL, keyless request) with the `AUTH_ERROR` envelope, and `hudu_fetch_many` / `hudu_read` `operations.fetchMany` return that top-level refusal for a whole-batch credential or origin refusal instead of `ok: 0, failed: 1` with per-item errors; a genuine per-item vendor failure still lands on its row. A keyless `hudu_search` is no longer a soft 0-hit result (#35).
- Dependency: node-hudu 0.16.0 -> 0.17.0. Plan hash re-stamped to `1ad5e23b...`; operation set unchanged (236).
- Markdown article reads take their loss signal from the SDK: node-hudu now attaches `content_loss` to the record on a Markdown read, so the server no longer forces HTML and converts and diffs the body itself. `markdown_lossy` / `markdown_lossy_codes` are unchanged; the per-record `content_loss` is lifted into them and not passed through.
- Behaviour change: inline `<svg>` and `<iframe>` now survive Markdown reads and writes (they were flagged lossy and writes over them were refused). A body that converts to nothing reads as an empty body flagged `ROUNDTRIP_BODY_EMPTY` instead of failing.
- Docs: decision record for per-user identity (`docs/decisions/per-user-identity.md`): do not build the Hudu account link now; Entra sign-in plus server-side per-user policy and audit instead.

## 0.3.0

**Upgrading from 0.2.3: breaking changes.** (1) Article bodies through `hudu_read` / `hudu_write` / `hudu_delete` are Markdown by default. (2) `HUDU_CACHE_PRESET`, `HUDU_COOLDOWN`, `HUDU_TIMEOUT_MS` and `HUDU_SEARCH_MAX_INDEX_PAGES` are removed and a set one now fails boot. (3) `hudu_list_companies` / `_articles` / `_assets` / `_asset_layouts` are replaced by `hudu_list(resource)`. (4) Served tool definitions drop `_meta`. (5) The repository uses pnpm. The SDK is pinned exactly to node-hudu 0.16.0 (plan hash `fba0aa46...`); 0.15.0 was never published. `HUDU_READ_ONLY` is NOT removed: `true` is a hard override (see below). **UPGRADE HAZARD:** on 0.2.3 an UNSET `HUDU_READ_ONLY` meant read-only. Now only `HUDU_WRITE_POLICY` decides when it is unset, so these two configs, with `HUDU_READ_ONLY` unset, now give the model `hudu_write` / `hudu_delete`: (a) `HUDU_WRITE_POLICY=all`; (b) `HUDU_WRITE_POLICY=allow_list` with a non-empty `HUDU_WRITE_ALLOW`. Set `HUDU_READ_ONLY=true` to keep them read-only. The server logs a warning at boot in exactly this case.


- Behaviour change: `hudu_read` / `hudu_write` / `hudu_delete` serve and accept article bodies as Markdown (node-hudu `contentFormat: 'markdown'`). Bodies that open with block HTML are still sent as HTML.
- Tooling: the repository moves from npm to pnpm (`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `packageManager`); the Dockerfile and CI use pnpm, and the runtime image carries no package manager. Contributors run `pnpm install`.
- The MCP handshake reports the package version (it was hardcoded 0.1.0).
- CLI: `--version` and `--help` work without configuration. The package no longer ships source maps or `.d.ts` files. The SDK's tracker references ("issues #70/#72") are stripped from served tool descriptions.
- CI: adds `pnpm audit --prod` and a container job (build, no package manager, fail-fast boot, non-default port, origin guard).
- Dependency: node-hudu 0.13.2 to 0.14.0 (Hudu Markdown dialect, `articles.getSection`, `articles.patchSection`); catalog plan hash and reachable-operation counts updated for the two new operations.
- Dependency: node-hudu 0.14.0 -> 0.16.0 (0.15.0 was never published). New discoverable operations: `articles.pin`, `articles.unpin`, `asset_passwords.listShares` / `getShare` / `createShare` / `deleteShare`; no served tool added. `asset_layouts.create` / `update` now send the body nested under `asset_layout` (SDK fix: fields were silently dropped). Plan hash re-stamped to `fba0aa46...`.
- `hudu_resolve_any` returns `unauthorized` (resources the credential may not read) beside the permitted hits; it errors only when every requested resource refuses. The dispatcher path returns it too.
- `hudu_get_company_context` accepts `opts.skip` and returns `skipped`.
- Share operations: refused under the default `HUDU_SECRET_READS=deny`; `createShare` is never runnable (the SDK needs `reveal`, this server never grants it) and is listed unreachable.
- Fix: the `hudu_search` default-tier sentence rewrite matched stale SDK text, so `auto` and narrowed deployments advertised a false `index` default; it now fails loudly if the anchor drifts.
- Discovery no longer names tools this server does not serve (`hudu_get_asset_password`, `hudu_get_website`).
- Served surface: `$schema` and safe-integer `maximum` stripped, SDK dispatcher field text served verbatim, shorter article-format note and `hudu_search` `query` text; an intermediate 46.3 / 40.8 KB. A size-gate test ratchets both.
- Mermaid is stored in the bare editor-native `<pre class="language-mermaid">` form (SDK 0.16.0); round-trip test added.
- Breaking: the four `hudu_list_companies` / `hudu_list_articles` / `hudu_list_assets` / `hudu_list_asset_layouts` tools are replaced by one `hudu_list` with a `resource` argument. Filters move inside `filters`; an unaccepted filter is refused, `asset_layouts` refuses `page_size`. A call to an old name answers with a pointer to `hudu_list`. Same bounds and pagination as before. Resync tool catalogs.
- Breaking (metadata): served tool definitions no longer carry `_meta` (`backingOperation`, `sensitive`, `requiresApproval`, ...).
- Served surface after these: 19 tools / 39.5 KB write-enabled, 17 tools / 33.9 KB read-only (`tools/list`), down from 22 / 50.1 KB and 20 / 43.7 KB on node-hudu 0.16.0.
- Markdown article reads (`hudu_read` `articles.get` / `getContext` / `resolve`, `hudu_get_article_context`) that lose content the dialect cannot express (e.g. an inline `<svg>`) now set `markdown_lossy: true` and `markdown_lossy_codes` and add one sentence to the result text; a lossless read is byte-identical to before. Detection uses the SDK's `diffArticleRoundTrip` (content-impact findings only).
- `allow_list` registers `hudu_write` only when the list holds a write-effect operation and `hudu_delete` only when it holds a destructive-effect one (previously both). `all` registers both; `deny` and `HUDU_READ_ONLY=true` neither. The boot log states which were registered.
- `HUDU_WRITE_POLICY` (`deny` default | `allow_list` | `all`) is the write switch; `deny` registers no `hudu_write` / `hudu_delete` tool. Allowing a write also allows the writes it delegates to (`articles.patchSection` -> `articles.update`). `HUDU_READ_ONLY=true` stays a HARD OVERRIDE: no write or delete tool and every mutation refused, whatever `HUDU_WRITE_POLICY` / `HUDU_WRITE_ALLOW` say; unset or `false` leaves `HUDU_WRITE_POLICY` in charge. The effective policy is logged once at boot.
- Behaviour note: on 0.2.3 an UNSET `HUDU_READ_ONLY` defaulted to true (read-only). It is now unset = `HUDU_WRITE_POLICY` decides, so a deployment that sets `HUDU_WRITE_POLICY=allow_list` or `all` without `HUDU_READ_ONLY=true` gets the write tools. Set `HUDU_READ_ONLY=true` to keep a deployment read-only regardless.
- Breaking: `HUDU_CACHE_PRESET`, `HUDU_COOLDOWN`, `HUDU_TIMEOUT_MS` and `HUDU_SEARCH_MAX_INDEX_PAGES` are removed; the SDK client now uses the fixed agent profile, recommended cache, a 30 s timeout and an armed cooldown. A set one fails boot.
- `hudu_get_article_context` returns Markdown; `hudu_read`, `hudu_write`, `hudu_list` and `hudu_fetch_many` descriptions state which paths speak Markdown and which carry stored HTML.
- Tests: Markdown read and write loss-guard coverage through the dispatchers.
