/**
 * dispatch-progress.test.ts — the raw invoke path (`hudu_read` of `operations.searchKnowledge`) can
 * wait on the same corpus-wide body-index walk `hudu_search` does, so it gets the same progress
 * ticks and the same honest cancelled answer. Pairs with `src/tools/dispatch.ts`.
 *
 * Driven through the registered handler with a stubbed fetch that never settles: a walk that
 * answered instantly would settle before anything could be observed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HuduClient } from 'node-hudu';
import { config, type Json } from '../helpers/mcp-session.js';
import { createLogger } from '../../src/logger.js';
import { registerDispatchTools } from '../../src/tools/dispatch.js';

afterEach(() => vi.unstubAllGlobals());

type Handler = (args: Json, req: unknown) => Promise<Json>;

/** The read dispatcher over a client whose every request hangs. */
function hangingReadHandler(): { handler: Handler; fetches: () => number } {
  let called = 0;
  vi.stubGlobal('fetch', () => {
    called += 1;
    return new Promise<Response>(() => {});
  });
  let handler!: Handler;
  const server = { registerTool: (name: string, _c: unknown, cb: Handler) => { if (name === 'hudu_read') handler = cb; } };
  const hudu = new HuduClient({ baseUrl: 'https://hudu.invalid', apiKey: 'valid-key-000', mode: 'read', retry: false } as never);
  registerDispatchTools(server as never, {
    hudu,
    config: { ...config, HUDU_WRITE_POLICY: 'deny' },
    log: createLogger('error', () => {}),
    searchableResources: ['articles', 'assets'],
    defaultSearchScope: ['articles', 'assets'],
    indexSearchable: true,
    toolDefaultTier: 'index',
    searchTierIsPolicy: false,
  } as never);
  return { handler, fetches: () => called };
}

const request = (signal: AbortSignal, notify: (n: Json) => Promise<void>, token?: string) => ({
  mcpReq: { _meta: token === undefined ? {} : { progressToken: token }, signal, notify },
});

const ARGS = { operation: 'operations.searchKnowledge', input: { query: 'reset the vpn', opts: { tier: 'index', limit: 2 } } };

describe('hudu_read of operations.searchKnowledge while the index build waits', () => {
  it('ticks at 2s and answers a cancellation with the degraded search result', async () => {
    vi.useFakeTimers();
    try {
      const { handler } = hangingReadHandler();
      const controller = new AbortController();
      const received: Json[] = [];
      const call = handler(ARGS, request(controller.signal, async (n) => { received.push(n); }, 'tok-invoke'));
      await vi.advanceTimersByTimeAsync(1_999);
      expect(received).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(received).toHaveLength(1);
      expect(received[0]!.params!.progressToken).toBe('tok-invoke');
      controller.abort();
      const result = await call;
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent.operation).toBe('operations.searchKnowledge');
      expect(result.structuredContent.result.meta.reasons).toEqual([]);
      expect(result.structuredContent.result.meta.cancelled).toEqual({ during: 'index-build', waited: true });
      expect(result.structuredContent.result.meta.complete).toBe(false);
      expect(result.structuredContent.result.meta.index.state).toBe('refreshing');
      expect(result.structuredContent.result.hits).toEqual([]);
      expect(String(result.content[0].text)).toContain('DEGRADED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts no walk when the request is already cancelled', async () => {
    const { handler, fetches } = hangingReadHandler();
    const controller = new AbortController();
    controller.abort();
    const result = await handler(ARGS, request(controller.signal, async () => {}, 'tok-gone'));
    expect(fetches()).toBe(0);
    expect(result.structuredContent.result.meta.reasons).toEqual([]);
    expect(result.structuredContent.result.meta.cancelled).toEqual({ during: 'index-build', waited: false });
    // Nothing was joined, so this call observed no generation: the state is "cold", which does not
    // claim the process has no warm stdio index.
    expect(result.structuredContent.result.meta.index.state).toBe('cold');
    expect(result.structuredContent.result.meta.timings.localMs).toBe(0);
  });

});
