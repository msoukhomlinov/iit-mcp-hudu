/**
 * search-budget.ts — the body index's text budget, sized to the process's own heap ceiling.
 */

const MIB = 1024 * 1024;

/** 8 MiB: below this the index would answer from almost nothing, so a tiny heap keeps a floor. */
export const MIN_INDEX_TEXT_BYTES = 8 * MIB;
/** 64 MiB: the SDK's own default text bound, and the most a single scope should ever hold. */
export const MAX_INDEX_TEXT_BYTES = 64 * MIB;

/**
 * How many scoped clients ONE per-mode cache keeps warm (the cache capacity in `tools/server.ts`).
 *
 * The budget below is per PROCESS, and every scoped client materialises its own index, so the pool
 * must be divided rather than handed to each client whole — by this number, by the number of
 * per-mode caches the factory builds (`read`, plus `write` and `delete` when writes are enabled),
 * and by one eviction transient per cache.
 *
 * TWO, not eight, because a division by eight made the index shallower than the corpus it exists to
 * search: on the production tenant at 1 GiB each scope got 6 MiB of text and 6,144 documents, and
 * because the SDK's document cap keeps the freshest `updated_at` GLOBALLY (it has no per-resource
 * cap), 4,666 newer assets displaced 1,726 of the 3,204 articles, leaving 1,036 article bodies
 * indexed (MEASURED on the live server, 2026-10-26).
 *
 * RESULTING DEPTH: a read-only deployment (one cache, `HUDU_WRITE_POLICY=deny`) gives each scope
 * 17 MiB and 17,408 documents at a ~816 MB ceiling; that is INFERRED to cover the tenant's ~19 MB of
 * article bodies almost entirely (about 2,800 of 3,204) and to keep all 3,204 articles, because the
 * measured run retained articles at roughly a quarter of the freshest-document density. A
 * write-enabled deployment has three caches, so the same pool is divided by nine and each scope gets
 * 5.67 MiB and 5,802 documents.
 *
 * SIZED FOR, NOT ENFORCED: the share is the pool divided by `(capacity + 1) x caches`, where the +1
 * leaves one eviction of margin per cache — the scope the LRU just dropped, which an in-flight
 * request keeps alive until it finishes (`ScopedClientCache.for()`). That makes the steady-state
 * bound `capacity x caches x share <= pool` hold, with one eviction per cache on top. It cannot
 * enforce a peak: k distinct credentials arriving at once can each evict a different scope, and the
 * SDK has no way to revoke a live index, so up to `capacity + k` scopes per cache can be alive at
 * once. The pool is a sizing target, as it has been since #51, not a hard cap.
 *
 * This also CORRECTS a pre-existing oversubscription: with eight shares, three caches could hold
 * 3 x 8 x 6 = 144 MiB of text against a 51 MiB pool. The trade is still breadth for depth: an
 * evicted scope rebuilds on demand (answers stay non-blocking and fall back to the vendor tier
 * meanwhile), and a deployment needing both breadth and depth needs a larger heap.
 */
export const SCOPED_INDEX_BUDGET_DIVISOR = 2;

/**
 * One eviction of margin per cache: a scope evicted by the LRU stays reachable while an in-flight
 * request that resolved it finishes, so the cache can briefly hold capacity + 1 shares. Concurrent
 * evictions (k distinct credentials at once) can exceed this; see the divisor note.
 */
export const SCOPED_INDEX_EVICTION_TRANSIENT = 1;

/**
 * The total extracted text the PROCESS's body indexes may hold, from the V8 heap ceiling in bytes.
 *
 * A SIXTEENTH of the heap, rounded down to whole MiB and clamped to 8-64 MiB. ESTIMATE, not a proof
 * that a build cannot exhaust the heap; 16 because a measured end-to-end run showed a tenth leaves
 * no usable margin.
 *
 * RATIO AND BASELINE: ~4x structure-to-text, per byte of text ACTUALLY HELD (not per byte of budget),
 * and a ~90 MB production baseline — both from issue #51's crash trace, the only PRODUCTION
 * measurement (~252 MB peak on the old 64 MiB budget). That index held ~41 MB of its 64 MiB budget,
 * and 90 + 4 x 41 = ~254 MB reconciles with the measured peak; read against the budget the same
 * ratio would predict ~346 MB, which the trace never saw.
 *
 * MEASURED on the real server under a 259 MiB V8 ceiling. At a tenth (25 MiB pool, 25,600 docs):
 * 187.96 MB peak against a 24.6 MB base, so structures cost ~163 MB; against production's ~90 MB
 * baseline that extrapolates to ~253 MB, ~98% of 259 MiB, no usable margin. At a sixteenth (16 MiB
 * pool, 16,384 docs) the same probe peaked at 118.51 MB against a 27.57 MB base (~90.93 MB of
 * structures). PRODUCTION EXTRAPOLATION: ~180.93 MB, ~70% of 259 MiB and ~26 MB below the 207 MB
 * (80%) target. MEASURED PROBE PEAK: 118.51 MB, ~45.8% of 259 MiB. A standalone walk peaked at ~136
 * MiB with the tenth's pool and ~147 MiB with the OLD 64 MiB / 50,000 settings; both survived.
 * CAVEATS: the stub corpus is SYNTHETIC (smaller bodies and baseline than production), bodiesEvicted
 * was 0 so no run exercised text eviction, the stub was recreated per run so the before/after delta
 * also reflects stub differences, and the production figure is an EXTRAPOLATION from one synthetic
 * walk.
 *
 * POOL FRACTION: the budget is per PROCESS, not per client. Up to
 * {@link SCOPED_INDEX_BUDGET_DIVISOR} scoped clients stay warm in each per-mode cache and each owns a
 * body index, so each is handed only {@link scopedIndexTextBudgetBytes} (the pool divided by the
 * per-cache client count and again by the number of caches). The trade: several credentials build shallower indexes (a scope
 * that hits its share reports index state "partial"); needing depth means raising the container
 * memory or serving over stdio, where one credential owns the whole pool.
 *
 * MEASURED on the production tenant (2026-10-26), with the former division by eight: a scope retained
 * 4,666 assets and 1,478 of 3,204 articles, indexed 1,036 article bodies, and had evicted 317 bodies
 * by the text budget and truncated 3 (the counts do not decompose the 1,478: some retained articles
 * carry no body text). The SDK's document cap keeps the freshest documents across ALL resources,
 * which is the shallowness this divisor fixes.
 */
export function indexTextBudgetBytes(heapLimitBytes: number): number {
  const sixteenthInMib = Math.floor(heapLimitBytes / 16 / MIB) * MIB;
  return Math.min(MAX_INDEX_TEXT_BYTES, Math.max(MIN_INDEX_TEXT_BYTES, sixteenthInMib));
}

/**
 * The text budget for ONE scoped client: the process pool divided by the clients the design expects
 * it to fund — (cache capacity + one eviction of margin) x per-mode caches.
 *
 * `caches` is the number of scoped-client caches the process creates: 1 under
 * `HUDU_WRITE_POLICY=deny` (read only), 3 otherwise (read, write, delete). It is required, not
 * defaulted: a default of 1 would size every client for a read-only process and oversubscribe a
 * write-enabled one threefold.
 *
 * The share is an exact byte quotient, so `clients x share` never exceeds the pool and no pool space
 * is lost to rounding (whole-MiB rounding discarded up to a third of a small pool: 7 of 16 MiB in
 * the 512 MiB write-enabled profile). Small pools get a share below the single-client
 * {@link MIN_INDEX_TEXT_BYTES} on purpose — the clients cannot each hold the single-client floor out
 * of an 8 MiB pool — and the SDK accepts any positive bound (a probe with 932,067 bytes built and
 * answered `warm`).
 */
export function scopedIndexTextBudgetBytes(heapLimitBytes: number, caches: number): number {
  const total = indexTextBudgetBytes(heapLimitBytes);
  const clients = (SCOPED_INDEX_BUDGET_DIVISOR + SCOPED_INDEX_EVICTION_TRANSIENT) * Math.max(1, caches);
  return Math.max(1, Math.floor(total / clients));
}

/** 1: the cap follows the share's KiB count, so it never exceeds the text budget it is paired with. */
export const MIN_INDEX_MAX_DOCS = 1;
/** 50,000: the SDK's own default doc count, and the most one index should ever hold. */
export const MAX_INDEX_MAX_DOCS = 50_000;
/** ~1 KB of record + postings per indexed document, on top of the ~4x text ratio. ESTIMATE. */
const INDEX_DOC_BYTES = 1024;

/*
 * `search.fullRefreshEvery` — the SDK's own full re-walk cadence (default 6 builds) — is NOT wired
 * here, deliberately. The heap goal is met by bounding index SIZE (`maxIndexTextBytes` and
 * `maxDocs`); the cadence decides how OFTEN a full walk runs, not how large the index may grow, so
 * leaving it at the SDK default changes no bound this module exists for. Wiring it would need either
 * a new env knob (out of scope) or a second heap-derived formula with no measurement behind it.
 * Deliberate follow-up: a deployment that needs a different cadence sets it through the SDK.
 */

/**
 * The document cap for ONE body index, derived from the SAME heap-derived text budget it is paired with.
 *
 * The text budget alone does not bound the index: `maxDocs` defaults to 50,000 in the SDK, a walk can
 * reach 250 pages x 100 rows x 2 body resources, and a document whose text the budget evicted keeps
 * its record and postings, so the record overhead grows even when no text is added. This caps the
 * count from the same pool: ~1 KB of record + postings per document, i.e. one document per KiB of
 * text budget, capped at 50,000 and never below one document.
 *
 * ESTIMATE, and it bounds growth rather than proving a peak: the pairing says "this index may hold X
 * MiB of text and Y documents", not "the process cannot exceed its heap". The SDK upserts every
 * walked document and applies the cap only AFTER the walk, so this bounds what the index RETAINS,
 * not the walk's peak (the heap ceiling and the text budget's eviction bound that). A capped index
 * reports index state "partial", as it already does when the text budget bites. Resulting numbers,
 * read-only profile / write-enabled profile (one cache / three caches):
 * a 512 MiB container (MEASURED ~50.6% container-to-heap ratio: ~259 MB) gets a 16 MiB pool, so
 * 5.33 MiB / 5,461 documents per scoped client read-only, 1.78 MiB / 1,820 with writes (16,384 for
 * the stdio pool); a 1 GiB container's ~816 MB V8 ceiling — an ASSUMED ~80% ratio, not a measurement —
 * gets a 51 MiB pool, so 17 MiB / 17,408 read-only, 5.67 MiB / 5,802 with writes (50,000 for the
 * stdio pool); a 1024 MB ceiling reaches the 64 MiB cap, so 21.33 MiB / 21,845 read-only, 7.11 MiB /
 * 7,281 with writes.
 *
 * WHICH documents the cap truncates is the SDK's choice, not this module's: it keeps the freshest
 * `updated_at` across ALL resources, so assets can outrank older articles. MEASURED on the production
 * tenant at the former division by eight (6,144 documents): 4,666 assets and 1,478 of the 3,204
 * articles were retained; 1,036 article bodies were indexed, 317 had been evicted by the text budget
 * and 3 truncated (the counts do not decompose the 1,478 — some retained articles carry no body
 * text). At the 1 GiB read-only figures above (17 MiB and 17,408 documents) the measured article
 * density (1,478 of the freshest 6,144) implies all 3,204 articles now fall inside the cap, so the
 * article loss is expected to disappear (INFERRED, not measured at this division); at 512 MiB
 * (5,461 documents) 3,204 articles would leave only 2,257 slots for assets, so the loss remains. The
 * order is the SDK's.
 *
 * Named for its scoped use because that is where it matters: the pool is divided per client, and the
 * cap travels the same `search` object as `maxIndexTextBytes`.
 */
export function scopedIndexMaxDocs(textBudgetBytes: number): number {
  const docs = Math.floor(textBudgetBytes / INDEX_DOC_BYTES);
  return Math.min(MAX_INDEX_MAX_DOCS, Math.max(MIN_INDEX_MAX_DOCS, docs));
}
