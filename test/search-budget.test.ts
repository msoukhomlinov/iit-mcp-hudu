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
  // The counted clients per profile are LITERALS, not a re-evaluation of the implementation's
  // formula: three per mode cache (two clients plus one eviction of margin), so one cache counts
  // three and the write-enabled three caches count nine. The two factors are pinned separately, so
  // changing either fails a test here instead of rescaling both sides of every bound below.
  const CACHES_WRITES = 3;
  const clientsFor = (caches: number) => (caches === 1 ? 3 : 9);

  it('counts two clients plus one eviction of margin, per mode cache', () => {
    expect(SCOPED_INDEX_BUDGET_DIVISOR).toBe(2);
    expect(SCOPED_INDEX_EVICTION_TRANSIENT).toBe(1);
    expect(clientsFor(1)).toBe(3);
    expect(clientsFor(CACHES_WRITES)).toBe(9);
  });

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

  it('leaves no pool space unused to rounding', () => {
    for (const caches of [1, CACHES_WRITES]) {
      for (const heapMiB of [1, 64, 128, 259, 512, 816, 4096]) {
        const heap = heapMiB * MiB;
        const total = indexTextBudgetBytes(heap);
        const share = scopedIndexTextBudgetBytes(heap, caches);
        expect(Number.isInteger(share), `${heapMiB} MiB x${caches}`).toBe(true);
        expect(share, `${heapMiB} MiB x${caches}`).toBeGreaterThanOrEqual(1);
        // Only the remainder below one byte per client may stay unused.
        expect(total - share * clientsFor(caches), `${heapMiB} MiB x${caches}`).toBeLessThan(clientsFor(caches));
      }
    }
  });

  it('shares a pool smaller than one MiB per counted client exactly', () => {
    // 140 MiB of heap floors to an 8 MiB pool: nine counted clients get an exact byte share, not
    // nine 1 MiB floors (9 MiB > 8 MiB).
    const heap = 140 * MiB;
    expect(indexTextBudgetBytes(heap)).toBe(8 * MiB);
    const share = scopedIndexTextBudgetBytes(heap, CACHES_WRITES);
    expect(share).toBeLessThan(MiB);
    expect(share * clientsFor(CACHES_WRITES)).toBeLessThanOrEqual(indexTextBudgetBytes(heap));
  });

  it('sizes the measured heaps per profile: one cache (read-only), three (writes enabled)', () => {
    // 259 MiB -> a 16 MiB pool; 816 MiB -> a 51 MiB pool. Literal byte counts, not a restatement of
    // the formula: 16 MiB / 3 and / 9, 51 MiB / 3 and / 9.
    expect(indexTextBudgetBytes(259 * MiB)).toBe(16_777_216);
    expect(scopedIndexTextBudgetBytes(259 * MiB, 1)).toBe(5_592_405);
    expect(scopedIndexTextBudgetBytes(259 * MiB, CACHES_WRITES)).toBe(1_864_135);
    expect(scopedIndexTextBudgetBytes(816 * MiB, 1)).toBe(17_825_792);
    expect(scopedIndexTextBudgetBytes(816 * MiB, CACHES_WRITES)).toBe(5_941_930);
  });
});

describe('scopedIndexMaxDocs', () => {
  it('gives one document per KiB of text budget', () => {
    expect(scopedIndexMaxDocs(3 * MiB)).toBe(3072);
    expect(scopedIndexMaxDocs(8 * MiB)).toBe(8192);
    expect(scopedIndexMaxDocs(25 * MiB)).toBe(25_600);
  });

  it('sizes the two measured heaps to the documented caps', () => {
    // 512 MiB container: a 16 MiB pool, so 5.33 MiB / 5,461 documents read-only.
    const smallHeap = 259 * MiB;
    expect(scopedIndexTextBudgetBytes(smallHeap, 1)).toBe(5_592_405);
    expect(scopedIndexMaxDocs(scopedIndexTextBudgetBytes(smallHeap, 1))).toBe(5461);
    expect(scopedIndexMaxDocs(indexTextBudgetBytes(smallHeap))).toBe(16_384);
    // 1 GiB heap ceiling: the 64 MiB clamp, so 21.33 MiB / 21,845 documents read-only.
    const largeHeap = 1024 * MiB;
    expect(scopedIndexTextBudgetBytes(largeHeap, 1)).toBe(22_369_621);
    expect(scopedIndexMaxDocs(scopedIndexTextBudgetBytes(largeHeap, 1))).toBe(21_845);
    // Writes enabled: three per-mode caches (read, write, delete) divide the same pool by nine, so
    // the same three heaps give 1,820 / 5,802 / 7,281 documents.
    expect(scopedIndexMaxDocs(scopedIndexTextBudgetBytes(smallHeap, 3))).toBe(1820);
    expect(scopedIndexMaxDocs(scopedIndexTextBudgetBytes(816 * MiB, 3))).toBe(5802);
    expect(scopedIndexMaxDocs(scopedIndexTextBudgetBytes(largeHeap, 3))).toBe(7281);
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
    const share = scopedIndexTextBudgetBytes(heap, 1);
    expect(scopedIndexMaxDocs(pool)).toBeGreaterThan(scopedIndexMaxDocs(share));
    expect(scopedIndexMaxDocs(share) * SCOPED_INDEX_BUDGET_DIVISOR).toBeLessThanOrEqual(scopedIndexMaxDocs(pool));
  });
});
