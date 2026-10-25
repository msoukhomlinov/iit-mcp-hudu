/**
 * search-budget.ts — the body index's text budget, sized to the process's own heap ceiling.
 */

const MIB = 1024 * 1024;

/** 8 MiB: below this the index would answer from almost nothing, so a tiny heap keeps a floor. */
export const MIN_INDEX_TEXT_BYTES = 8 * MIB;
/** 64 MiB: the SDK's own default text bound, and the most a single scope should ever hold. */
export const MAX_INDEX_TEXT_BYTES = 64 * MIB;

/**
 * How many scoped clients share the pooled text budget (the cache cap in `tools/server.ts`).
 *
 * The budget below is per PROCESS, and every scoped client materialises its own index, so the pool
 * must be divided by this number rather than handed to each client whole.
 */
export const SCOPED_INDEX_BUDGET_DIVISOR = 8;

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
 * {@link SCOPED_INDEX_BUDGET_DIVISOR} scoped clients stay warm and each owns a body index, so each is
 * handed only {@link scopedIndexTextBudgetBytes} (a whole-MiB share). The trade: several credentials
 * build shallower indexes (a scope that hits its share reports index state "partial"); needing depth
 * means raising the container memory or serving over stdio, where one credential owns the whole pool.
 */
export function indexTextBudgetBytes(heapLimitBytes: number): number {
  const sixteenthInMib = Math.floor(heapLimitBytes / 16 / MIB) * MIB;
  return Math.min(MAX_INDEX_TEXT_BYTES, Math.max(MIN_INDEX_TEXT_BYTES, sixteenthInMib));
}

/**
 * The text budget for ONE scoped client: the process pool divided by the scoped-client cap.
 *
 * A whole-MiB share with a 1 MiB floor, never above the pool itself (a pool smaller than the cap
 * would otherwise be oversubscribed). Small pools get a share below the single-client
 * {@link MIN_INDEX_TEXT_BYTES} on purpose — eight clients cannot each hold 8 MiB out of 16 MiB.
 */
export function scopedIndexTextBudgetBytes(heapLimitBytes: number): number {
  const total = indexTextBudgetBytes(heapLimitBytes);
  const share = Math.floor(total / SCOPED_INDEX_BUDGET_DIVISOR / MIB) * MIB;
  return Math.min(total, Math.max(MIB, share));
}

/** 1,500: a doc cap below this would truncate a small tenant's whole corpus, so a tiny budget keeps a floor. */
export const MIN_INDEX_MAX_DOCS = 1500;
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
 * text budget, clamped to 1,500-50,000.
 *
 * ESTIMATE, and it bounds growth rather than proving a peak: the pairing says "this index may hold X
 * MiB of text and Y documents", not "the process cannot exceed its heap". The SDK upserts every
 * walked document and applies the cap only AFTER the walk, so this bounds what the index RETAINS,
 * not the walk's peak (the heap ceiling and the text budget's eviction bound that). A capped index
 * reports index state "partial", as it already does when the text budget bites. Resulting numbers:
 * a 512 MiB container (MEASURED ~50.6% container-to-heap ratio: ~259 MB) gets a 16 MiB pool and 2 MiB
 * per scoped client, so 2,048 documents per scoped client (16,384 for the stdio pool); a 1 GiB
 * container's ~816 MB V8 ceiling — an ASSUMED ~80% ratio, not a measurement — gets a 51 MiB pool and
 * 6 MiB per client, so 6,144 documents (50,000 for the stdio pool), while a 1024 MB ceiling is what
 * reaches the 64 MiB cap and 8,192. All ~3,300 articles of the production tenant fit at the 1 GiB
 * figure. WHICH documents a small heap's
 * cap truncates first is INFERRED, not measured: title-only assets are expected to go first because
 * they cost a record without carrying text, but at 512 MiB the 2,048-document cap already sits below
 * the ~3,300 articles, so articles could be truncated first. The order is not measured.
 *
 * Named for its scoped use because that is where it matters: the pool is divided per client, and the
 * cap travels the same `search` object as `maxIndexTextBytes`.
 */
export function scopedIndexMaxDocs(textBudgetBytes: number): number {
  const docs = Math.floor(textBudgetBytes / INDEX_DOC_BYTES);
  return Math.min(MAX_INDEX_MAX_DOCS, Math.max(MIN_INDEX_MAX_DOCS, docs));
}
