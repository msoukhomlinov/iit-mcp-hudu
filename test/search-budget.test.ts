/** The heap-derived body-index text budget (#51): a small container must not trade its heap for a full index. */
import { describe, expect, it } from 'vitest';
import { indexTextBudgetBytes } from '../src/search-budget.js';

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
