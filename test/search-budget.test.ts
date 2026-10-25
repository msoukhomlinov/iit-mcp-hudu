/** The heap-derived body-index text budget (#51): a small container must not trade its heap for a full index. */
import { describe, expect, it } from 'vitest';
import { SCOPED_INDEX_BUDGET_DIVISOR, indexTextBudgetBytes, scopedIndexTextBudgetBytes } from '../src/search-budget.js';

const MiB = 1024 * 1024;

describe('indexTextBudgetBytes', () => {
  it('takes a tenth of the heap when that sits inside the 8-64 MiB band', () => {
    expect(indexTextBudgetBytes(128 * MiB)).toBe(12 * MiB);
  });

  it('sizes a 512 MiB container (a ~259 MB heap ceiling) to 25 MiB', () => {
    expect(indexTextBudgetBytes(259 * MiB)).toBe(25 * MiB);
  });

  it('clamps a large heap ceiling to 64 MiB, the SDK default', () => {
    expect(indexTextBudgetBytes(816 * MiB)).toBe(64 * MiB);
  });

  it('floors a small heap ceiling at 8 MiB', () => {
    expect(indexTextBudgetBytes(64 * MiB)).toBe(8 * MiB);
  });

  it('always returns an integer byte count', () => {
    expect(Number.isInteger(indexTextBudgetBytes(1000))).toBe(true);
    expect(indexTextBudgetBytes(1000)).toBe(8 * MiB);
  });
});

describe('scopedIndexTextBudgetBytes', () => {
  it('never hands one client more than its share of the process pool', () => {
    for (const heapMiB of [140, 259, 512, 816, 4096]) {
      const total = indexTextBudgetBytes(heapMiB * MiB);
      expect(scopedIndexTextBudgetBytes(heapMiB * MiB), `${heapMiB} MiB`).toBeLessThanOrEqual(total / SCOPED_INDEX_BUDGET_DIVISOR);
    }
  });

  it('keeps the whole cache inside the process pool', () => {
    for (const heapMiB of [140, 259, 512, 816, 4096]) {
      const heap = heapMiB * MiB;
      const perClient = scopedIndexTextBudgetBytes(heap);
      expect(perClient * SCOPED_INDEX_BUDGET_DIVISOR, `${heapMiB} MiB`).toBeLessThanOrEqual(indexTextBudgetBytes(heap));
    }
  });

  it('is a whole MiB, at least one, and never above the pool', () => {
    for (const heapMiB of [1, 64, 128, 259, 816, 4096]) {
      const heap = heapMiB * MiB;
      const share = scopedIndexTextBudgetBytes(heap);
      expect(Number.isInteger(share / MiB), `${heapMiB} MiB`).toBe(true);
      expect(share).toBeGreaterThanOrEqual(MiB);
      expect(share).toBeLessThanOrEqual(indexTextBudgetBytes(heap));
    }
  });

  it('sizes the two measured heaps to 3 MiB and 8 MiB per client', () => {
    // 259 MiB -> a 25 MiB pool; 816 MiB -> the 64 MiB clamp. Eight clients either way.
    expect(scopedIndexTextBudgetBytes(259 * MiB)).toBe(3 * MiB);
    expect(scopedIndexTextBudgetBytes(816 * MiB)).toBe(8 * MiB);
  });

  it('divides by the same cap the client cache enforces', async () => {
    const { MAX_SCOPED_CLIENTS } = await import('../src/tools/server.js');
    expect(SCOPED_INDEX_BUDGET_DIVISOR).toBe(MAX_SCOPED_CLIENTS);
  });
});
