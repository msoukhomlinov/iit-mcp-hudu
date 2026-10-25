/**
 * search-budget.ts — the body index's text budget, sized to the process's own heap ceiling.
 */

const MIB = 1024 * 1024;

/** 8 MiB: below this the index would answer from almost nothing, so a tiny heap keeps a floor. */
export const MIN_INDEX_TEXT_BYTES = 8 * MIB;
/** 64 MiB: the SDK's own default text bound, and the most a single scope should ever hold. */
export const MAX_INDEX_TEXT_BYTES = 64 * MIB;

/**
 * The total extracted text a client's body index may hold, from the V8 heap ceiling in bytes.
 *
 * A tenth of the heap, rounded down to whole MiB and clamped to 8-64 MiB. ESTIMATE (not a
 * measurement), inferred from issue #51's crash trace — a 252 MB peak heap at a 64 MiB text budget:
 * the index structures cost roughly 4x the text they hold, and the process carries roughly 90 MB of
 * baseline heap, so a 10% share keeps a small container under its ceiling — and the SDK reports
 * `index-partial` honestly when the budget bites, so a short index degrades the answer instead of
 * crashing the process.
 */
export function indexTextBudgetBytes(heapLimitBytes: number): number {
  const tenthInMib = Math.floor(heapLimitBytes / 10 / MIB) * MIB;
  return Math.min(MAX_INDEX_TEXT_BYTES, Math.max(MIN_INDEX_TEXT_BYTES, tenthInMib));
}
