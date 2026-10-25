/** Pins the fixed SDK client options (formerly env knobs): removing one would leave every other test green. */
import { describe, expect, it, vi } from 'vitest';

const captured: Record<string, unknown>[] = [];

vi.mock('node-hudu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node-hudu')>();
  class SpyClient extends actual.HuduClient {
    constructor(options: Record<string, unknown>) {
      captured.push(options);
      super(options as never);
    }
  }
  return { ...actual, HuduClient: SpyClient };
});

const { connect, connectForRequest } = await import('../helpers/mcp-session.js');
const { MAX_SCOPED_INDEX_CACHES, indexTextBudgetBytes, scopedIndexMaxDocs, scopedIndexTextBudgetBytes } = await import('../../src/search-budget.js');
const { getHeapStatistics } = await import('node:v8');

describe('fixed SDK client options', () => {
  it('every client is built with the agent profile, recommended cache, 429 cooldown and a 30 s deadline', async () => {
    const session = await connect();
    await session.close();
    expect(captured.length).toBeGreaterThan(0);
    for (const options of captured) {
      expect(options).toMatchObject({ profile: 'agent', cache: 'recommended', timeoutMs: 30000, cooldown: { enabled: true } });
      // The body-index text budget follows the process heap (#51), so every client carries one.
      const search = options.search as { maxIndexTextBytes?: number; maxDocs?: number } | undefined;
      expect(search?.maxIndexTextBytes).toBeGreaterThanOrEqual(8 * 1024 * 1024);
      expect(search?.maxIndexTextBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
      // The doc cap travels the same object, so the text budget is not the only bound (#52).
      expect(search?.maxDocs).toBeGreaterThanOrEqual(1500);
      expect(search?.maxDocs).toBeLessThanOrEqual(50_000);
      expect(search?.maxDocs).toBe(scopedIndexMaxDocs(search!.maxIndexTextBytes!));
    }
  });
});

describe('HUDU_SEARCH_INDEX_TTL', () => {
  it('reaches the SDK client as search.indexTtlMs, and stays unset when the env is unset', async () => {
    captured.length = 0;
    const session = await connect(undefined, { HUDU_SEARCH_INDEX_TTL: 45_000 });
    await session.close();
    expect(captured.length).toBeGreaterThan(0);
    for (const options of captured) {
      expect((options.search as { indexTtlMs?: number }).indexTtlMs).toBe(45_000);
    }
    captured.length = 0;
    const defaults = await connect();
    await defaults.close();
    for (const options of captured) {
      // Absent, not undefined-with-a-value: the SDK's own 10 minute default must win.
      expect(options.search as Record<string, unknown>).not.toHaveProperty('indexTtlMs');
    }
  });
});

describe('body-index text budget is pooled per process', () => {
  it('gives the parent the pool and every scoped client its share', async () => {
    captured.length = 0;
    // One http request builds the placeholder clients and, on its first tool call, one scoped client.
    const session = await connectForRequest('key-a', () => Response.json([]));
    await session.call('hudu_search', { mode: 'search', query: 'reset', limit: 1, snippetChars: 0 });
    await session.close();
    const heap = getHeapStatistics().heap_size_limit;
    const pool = indexTextBudgetBytes(heap);
    // This fixture enables writes (HUDU_WRITE_POLICY: "all"), so the factory builds three per-mode
    // caches and the share is the pool divided by clients x caches.
    const share = scopedIndexTextBudgetBytes(heap, MAX_SCOPED_INDEX_CACHES);
    const budgets = captured.map((options) => (options.search as { maxIndexTextBytes: number }).maxIndexTextBytes);
    expect(budgets).toContain(pool);
    const scoped = budgets.filter((b) => b === share);
    expect(scoped.length).toBeGreaterThan(0);
    // All the clients the three caches materialised together hold no more text than the pool.
    expect(scoped.length * share).toBeLessThanOrEqual(pool);
    expect(budgets.every((b) => b <= pool)).toBe(true);
  });

  it('divides by one cache when writes are denied, so the share is the one-cache share', async () => {
    captured.length = 0;
    const session = await connectForRequest('key-a', () => Response.json([]), [], { HUDU_WRITE_POLICY: 'deny' });
    await session.call('hudu_search', { mode: 'search', query: 'reset', limit: 1, snippetChars: 0 });
    await session.close();
    const heap = getHeapStatistics().heap_size_limit;
    const budgets = captured.map((options) => (options.search as { maxIndexTextBytes: number }).maxIndexTextBytes);
    const oneCache = scopedIndexTextBudgetBytes(heap, 1);
    const threeCaches = scopedIndexTextBudgetBytes(heap, MAX_SCOPED_INDEX_CACHES);
    expect(oneCache).not.toBe(threeCaches);
    expect(budgets).toContain(oneCache);
    expect(budgets).not.toContain(threeCaches);
  });

  it('pairs every text budget with its doc cap, so search.maxDocs reaches the client', async () => {
    captured.length = 0;
    const session = await connectForRequest('key-a', () => Response.json([]));
    await session.call('hudu_search', { mode: 'search', query: 'reset', limit: 1, snippetChars: 0 });
    await session.close();
    const searches = captured.map((options) => options.search as { maxIndexTextBytes: number; maxDocs: number });
    const pool = indexTextBudgetBytes(getHeapStatistics().heap_size_limit);
    const share = scopedIndexTextBudgetBytes(getHeapStatistics().heap_size_limit, MAX_SCOPED_INDEX_CACHES);
    // The stdio/http parent (the pool) and each scoped client (a share) both carry a derived cap.
    expect(searches.some((s) => s.maxIndexTextBytes === pool && s.maxDocs === scopedIndexMaxDocs(pool))).toBe(true);
    expect(searches.some((s) => s.maxIndexTextBytes === share && s.maxDocs === scopedIndexMaxDocs(share))).toBe(true);
    // A doc cap is attached to every client, and none ever exceeds the SDK's own default.
    expect(searches.every((s) => s.maxDocs === scopedIndexMaxDocs(s.maxIndexTextBytes))).toBe(true);
    expect(searches.every((s) => s.maxDocs <= 50_000)).toBe(true);
  });
});
