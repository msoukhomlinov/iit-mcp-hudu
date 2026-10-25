/** The heap-derived body-index text budget (#51): a small container must not trade its heap for a full index. */
import { describe, expect, it } from 'vitest';
import {
  MAX_INDEX_MAX_DOCS,
  MIN_INDEX_MAX_DOCS,
  SCOPED_INDEX_BUDGET_DIVISOR,
  SCOPED_INDEX_EVICTION_TRANSIENT,
  indexTextBudgetBytes,
  scopedIndexMaxDocs,
  scopedIndexTextBudgetBytes,
} from '../src/search-budget.js';

const MiB = 1024 * 1024;

describe('indexTextBudgetBytes', () => {
  it('takes a sixteenth of the heap when that sits inside the 8-64 MiB band', () => {
    expect(indexTextBudgetBytes(128 * MiB)).toBe(8 * MiB);
  });

  it('sizes a 512 MiB container (a ~259 MB heap ceiling) to 16 MiB', () => {
    expect(indexTextBudgetBytes(259 * MiB)).toBe(16 * MiB);
  });

  it('sizes an 816 MiB heap ceiling to 51 MiB and clamps 1 GiB to 64 MiB', () => {
    expect(indexTextBudgetBytes(816 * MiB)).toBe(51 * MiB);
    expect(indexTextBudgetBytes(1024 * MiB)).toBe(64 * MiB);
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
  // The two factors the pool is divided by are spelled out here, NOT imported from the
  // implementation: three per-mode caches (read, write, delete) and, per cache, the client capacity
  // plus one eviction transient.
  const CACHES_WRITES = 3;
  const clientsFor = (caches: number) => (SCOPED_INDEX_BUDGET_DIVISOR + SCOPED_INDEX_EVICTION_TRANSIENT) * caches;

  it('never hands one client more than its share of the process pool', () => {
    for (const caches of [1, CACHES_WRITES]) {
      for (const heapMiB of [140, 259, 512, 816, 4096]) {
        const heap = heapMiB * MiB;
        const total = indexTextBudgetBytes(heap);
        expect(scopedIndexTextBudgetBytes(heap, caches), `${heapMiB} MiB x${caches}`).toBeLessThanOrEqual(total / clientsFor(caches));
      }
    }
  });

  it('keeps every counted client inside the process pool, even at the smallest heap', () => {
    for (const caches of [1, CACHES_WRITES]) {
      for (const heapMiB of [1, 64, 140, 259, 512, 816, 4096]) {
        const heap = heapMiB * MiB;
        const perClient = scopedIndexTextBudgetBytes(heap, caches);
        expect(perClient * clientsFor(caches), `${heapMiB} MiB x${caches}`).toBeLessThanOrEqual(indexTextBudgetBytes(heap));
      }
    }
  });

  it('is a whole MiB only when the pool can fund one for every counted client', () => {
    for (const caches of [1, CACHES_WRITES]) {
      for (const heapMiB of [1, 64, 128, 259, 816, 4096]) {
        const heap = heapMiB * MiB;
        const total = indexTextBudgetBytes(heap);
        const share = scopedIndexTextBudgetBytes(heap, caches);
        expect(Number.isInteger(share), `${heapMiB} MiB x${caches}`).toBe(true);
        expect(share, `${heapMiB} MiB x${caches}`).toBeGreaterThanOrEqual(1);
        expect(share).toBeLessThanOrEqual(total);
        if (total >= clientsFor(caches) * MiB) expect(share % MiB, `${heapMiB} MiB x${caches}`).toBe(0);
      }
    }
  });

  it('cannot oversubscribe the smallest pool with whole-MiB rounding', () => {
    // 140 MiB of heap floors to an 8 MiB pool: nine counted clients get an exact byte share, not
    // nine 1 MiB floors (9 MiB > 8 MiB).
    const heap = 140 * MiB;
    expect(indexTextBudgetBytes(heap)).toBe(8 * MiB);
    const share = scopedIndexTextBudgetBytes(heap, CACHES_WRITES);
    expect(share).toBeLessThan(MiB);
    expect(share * clientsFor(CACHES_WRITES)).toBeLessThanOrEqual(indexTextBudgetBytes(heap));
  });

  it('sizes the measured heaps per profile: one cache (read-only), three (writes enabled)', () => {
    // 259 MiB -> a 16 MiB pool; 816 MiB -> a 51 MiB pool. Three clients per cache: capacity plus
    // the eviction transient.
    expect(scopedIndexTextBudgetBytes(259 * MiB, 1)).toBe(5 * MiB);
    expect(scopedIndexTextBudgetBytes(816 * MiB, 1)).toBe(17 * MiB);
    // Three per-mode caches divide the same pool by nine.
    expect(scopedIndexTextBudgetBytes(259 * MiB, CACHES_WRITES)).toBe(1 * MiB);
    expect(scopedIndexTextBudgetBytes(816 * MiB, CACHES_WRITES)).toBe(5 * MiB);
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
    // 512 MiB container: a 16 MiB pool, 5 MiB per scoped client -> 5,120 docs per client.
    const smallHeap = 259 * MiB;
    expect(scopedIndexTextBudgetBytes(smallHeap)).toBe(5 * MiB);
    expect(scopedIndexMaxDocs(scopedIndexTextBudgetBytes(smallHeap))).toBe(5120);
    expect(scopedIndexMaxDocs(indexTextBudgetBytes(smallHeap))).toBe(16_384);
    // 1 GiB heap ceiling: the 64 MiB clamp, 21 MiB per client -> 21,504 docs per client.
    const largeHeap = 1024 * MiB;
    expect(scopedIndexTextBudgetBytes(largeHeap)).toBe(21 * MiB);
    expect(scopedIndexMaxDocs(scopedIndexTextBudgetBytes(largeHeap))).toBe(21_504);
    // Writes enabled: three per-mode caches (read, write, delete) -> 5 MiB per client at 816 MiB.
    expect(scopedIndexMaxDocs(scopedIndexTextBudgetBytes(816 * MiB, 3))).toBe(5120);
  });

  it('never exceeds the SDK default 50,000 documents and never exceeds its own share', () => {
    for (const bytes of [0, 1, 1024, MiB, 25 * MiB, 64 * MiB, 1024 * MiB, Number.MAX_SAFE_INTEGER]) {
      const docs = scopedIndexMaxDocs(bytes);
      expect(Number.isInteger(docs), `${bytes}`).toBe(true);
      expect(docs, `${bytes}`).toBeLessThanOrEqual(MAX_INDEX_MAX_DOCS);
      expect(docs, `${bytes}`).toBeGreaterThanOrEqual(MIN_INDEX_MAX_DOCS);
    }
    expect(MAX_INDEX_MAX_DOCS).toBe(50_000);
    // One document per KiB: the cap tracks the share, so a 1 MiB share is 1,024 documents, not a
    // 1,500-document floor above it.
    expect(scopedIndexMaxDocs(MiB)).toBe(1024);
  });

  it('grows with the text budget, so the two caps derive from one pool', () => {
    const heap = 259 * MiB;
    const pool = indexTextBudgetBytes(heap);
    const share = scopedIndexTextBudgetBytes(heap);
    expect(scopedIndexMaxDocs(pool)).toBeGreaterThan(scopedIndexMaxDocs(share));
    expect(scopedIndexMaxDocs(share) * SCOPED_INDEX_BUDGET_DIVISOR).toBeLessThanOrEqual(scopedIndexMaxDocs(pool));
  });
});
