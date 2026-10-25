/** The heap-derived body-index text budget (#51): a small container must not trade its heap for a full index. */
import { describe, expect, it } from 'vitest';
import {
  MAX_INDEX_MAX_DOCS,
  MIN_INDEX_MAX_DOCS,
  SCOPED_INDEX_BUDGET_DIVISOR,
  indexTextBudgetBytes,
  scopedIndexMaxDocs,
  scopedIndexTextBudgetBytes,
} from '../src/search-budget.js';

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

describe('scopedIndexMaxDocs', () => {
  it('gives one document per KiB of text budget', () => {
    expect(scopedIndexMaxDocs(3 * MiB)).toBe(3072);
    expect(scopedIndexMaxDocs(8 * MiB)).toBe(8192);
    expect(scopedIndexMaxDocs(25 * MiB)).toBe(25_600);
  });

  it('sizes the two measured heaps to the documented caps', () => {
    // 512 MiB container: a 25 MiB pool, 3 MiB per scoped client -> 3,072 docs per client.
    const smallHeap = 259 * MiB;
    expect(scopedIndexTextBudgetBytes(smallHeap)).toBe(3 * MiB);
    expect(scopedIndexMaxDocs(scopedIndexTextBudgetBytes(smallHeap))).toBe(3072);
    expect(scopedIndexMaxDocs(indexTextBudgetBytes(smallHeap))).toBe(25_600);
    // 1 GiB heap ceiling: the 64 MiB clamp, 8 MiB per client -> 8,192 docs per client.
    const largeHeap = 1024 * MiB;
    expect(scopedIndexTextBudgetBytes(largeHeap)).toBe(8 * MiB);
    expect(scopedIndexMaxDocs(scopedIndexTextBudgetBytes(largeHeap))).toBe(8192);
  });

  it('never exceeds the SDK default 50,000 documents, and floors at 1,500', () => {
    for (const bytes of [0, 1, 1024, MiB, 25 * MiB, 64 * MiB, 1024 * MiB, Number.MAX_SAFE_INTEGER]) {
      const docs = scopedIndexMaxDocs(bytes);
      expect(Number.isInteger(docs), `${bytes}`).toBe(true);
      expect(docs, `${bytes}`).toBeLessThanOrEqual(MAX_INDEX_MAX_DOCS);
      expect(docs, `${bytes}`).toBeGreaterThanOrEqual(MIN_INDEX_MAX_DOCS);
    }
    expect(MAX_INDEX_MAX_DOCS).toBe(50_000);
  });

  it('grows with the text budget, so the two caps derive from one pool', () => {
    const heap = 259 * MiB;
    const pool = indexTextBudgetBytes(heap);
    const share = scopedIndexTextBudgetBytes(heap);
    expect(scopedIndexMaxDocs(pool)).toBeGreaterThan(scopedIndexMaxDocs(share));
    expect(scopedIndexMaxDocs(share) * SCOPED_INDEX_BUDGET_DIVISOR).toBeLessThanOrEqual(scopedIndexMaxDocs(pool));
  });
});
