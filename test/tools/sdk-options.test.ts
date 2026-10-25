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
const { MAX_SCOPED_CLIENTS } = await import('../../src/tools/server.js');
const { indexTextBudgetBytes, scopedIndexTextBudgetBytes } = await import('../../src/search-budget.js');
const { getHeapStatistics } = await import('node:v8');

describe('fixed SDK client options', () => {
  it('every client is built with the agent profile, recommended cache, 429 cooldown and a 30 s deadline', async () => {
    const session = await connect();
    await session.close();
    expect(captured.length).toBeGreaterThan(0);
    for (const options of captured) {
      expect(options).toMatchObject({ profile: 'agent', cache: 'recommended', timeoutMs: 30000, cooldown: { enabled: true } });
      // The body-index text budget follows the process heap (#51), so every client carries one.
      const search = options.search as { maxIndexTextBytes?: number } | undefined;
      expect(search?.maxIndexTextBytes).toBeGreaterThanOrEqual(8 * 1024 * 1024);
      expect(search?.maxIndexTextBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
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
    const share = scopedIndexTextBudgetBytes(heap);
    const budgets = captured.map((options) => (options.search as { maxIndexTextBytes: number }).maxIndexTextBytes);
    expect(budgets).toContain(pool);
    const scoped = budgets.filter((b) => b === share);
    expect(scoped.length).toBeGreaterThan(0);
    // The cache cannot hold more than the pool, however many scopes are warm.
    expect(scoped.length * MAX_SCOPED_CLIENTS).toBeLessThanOrEqual(pool);
    expect(budgets.every((b) => b <= pool)).toBe(true);
  });
});
