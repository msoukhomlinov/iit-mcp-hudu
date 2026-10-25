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
 * A tenth of the heap, rounded down to whole MiB and clamped to 8-64 MiB. ESTIMATE, not a proof
 * that a build cannot exhaust the heap: the ~4x structure-to-text ratio and the ~90 MB baseline
 * heap come from issue #51's crash trace, which measured the OLD behaviour — a 512 MiB container
 * that peaked at ~252 MB heap and crashed.
 *
 * What the 4x is a ratio OF: structures per byte of text ACTUALLY HELD, not per byte of budget.
 * That index held ~41 MB of text out of its 64 MiB budget, and the measured peak reconciles as
 * ~90 MB baseline + 4 x 41 MB = ~254 MB. Read against the budget instead of the held text it
 * would predict 90 + 4 x 64 = ~346 MB, which the trace never saw — hence "held", not "budget".
 * The peak under THIS budget (about 25 MiB of text on a 512 MiB heap, so ~190 MB on the same
 * arithmetic) has not been measured, so it stays an open follow-up. On the estimate a 10% share
 * keeps a small container under its ceiling, and the SDK reports `index-partial` honestly when the
 * budget bites, so a short index degrades the answer instead of crashing the process.
 *
 * This is the pooled budget for the whole process, not for one client: a deployment serving several
 * credentials keeps up to {@link SCOPED_INDEX_BUDGET_DIVISOR} scoped clients warm, and each one owns
 * its own body index, so each is handed only {@link scopedIndexTextBudgetBytes}. The trade is
 * plain: a deployment holding several credentials builds shallower indexes (a scope that hits its
 * share reports `index-partial`), while a deployment that needs depth should raise the container
 * memory or serve over stdio, where one long-lived credential owns the whole pool.
 */
export function indexTextBudgetBytes(heapLimitBytes: number): number {
  const tenthInMib = Math.floor(heapLimitBytes / 10 / MIB) * MIB;
  return Math.min(MAX_INDEX_TEXT_BYTES, Math.max(MIN_INDEX_TEXT_BYTES, tenthInMib));
}

/**
 * The text budget for ONE scoped client: the process pool divided by the scoped-client cap.
 *
 * A whole-MiB share with a 1 MiB floor, never above the pool itself (a pool smaller than the cap
 * would otherwise be oversubscribed). Small pools get a share below the single-client
 * {@link MIN_INDEX_TEXT_BYTES} on purpose — eight clients cannot each hold 8 MiB out of 25 MiB.
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
 * MiB of text and Y documents", not "the process cannot exceed its heap". A document past the cap is
 * simply not indexed — the index reports `index-partial` / truncated, as it already does when the
 * text budget bites. Resulting numbers: a 512 MiB container gets a 25 MiB pool and 3 MiB per scoped
 * client, so 3,072 documents per scoped client (25,600 for the stdio pool); a 1 GiB heap ceiling
 * reaches the 64 MiB cap and 8 MiB per client, so 8,192 documents (50,000 for the stdio pool). All
 * ~3,300 articles of the production tenant fit at the 1 GiB figure. WHICH documents a small heap's
 * cap truncates first is INFERRED, not measured: title-only assets are expected to go first because
 * they cost a record without carrying text, but at 512 MiB the 3,072-document cap already sits below
 * the ~3,300 articles, so articles could be truncated first. The order is not measured.
 *
 * Named for its scoped use because that is where it matters: the pool is divided per client, and the
 * cap travels the same `search` object as `maxIndexTextBytes`.
 */
export function scopedIndexMaxDocs(textBudgetBytes: number): number {
  const docs = Math.floor(textBudgetBytes / INDEX_DOC_BYTES);
  return Math.min(MAX_INDEX_MAX_DOCS, Math.max(MIN_INDEX_MAX_DOCS, docs));
}
