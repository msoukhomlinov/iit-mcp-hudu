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
 * that peaked at ~252 MB heap with the SDK-default 64 MiB text budget and crashed. That 64 MiB
 * profile is the only measurement: the peak under THIS budget (about 25 MiB on a 512 MiB heap) has
 * not been measured, so it stays an open follow-up. On the estimate a 10% share keeps a small
 * container under its ceiling, and the SDK reports `index-partial` honestly when the budget bites,
 * so a short index degrades the answer instead of crashing the process.
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
