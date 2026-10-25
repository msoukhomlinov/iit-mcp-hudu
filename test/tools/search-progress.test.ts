/**
 * search-progress.test.ts — `hudu_search` progress and cancellation while it AWAITS a body-index
 * build (issue #52). Pairs with the waiting path in `src/tools/search.ts`.
 *
 * The handler is driven directly with a fake `ctx`, because both the tick cadence and the abort
 * race need a build that is still running when the assertion is made — a stubbed Hudu answering
 * instantly would settle the walk before anything could be observed.
 */
import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { createLogger } from '../../src/logger.js';
import { PROGRESS_TICK_MS, registerSearchTool } from '../../src/tools/search.js';
import type { ToolContext } from '../../src/tools/context.js';
import { connect } from '../helpers/mcp-session.js';

type Handler = (args: Record<string, unknown>, req: unknown) => Promise<any>;
type Notify = { method: string; params?: Record<string, unknown> };

const config = { MCP_TRANSPORT: 'stdio' } as ToolContext['config'];

/** A search that settles when the test says so — the only way to observe a wait. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const RESULT = {
  hits: [],
  meta: { complete: true, reasons: [], degraded: null, failed: [], errors: [], index: { state: 'warm' }, scanned: 0, returned: 0 },
};

/** Register `hudu_search` on a fake server and hand back its handler. */
function harness(options: { searchKnowledge: ToolContext['ops']['searchKnowledge'] }, overrides: Partial<ToolContext> = {}) {
  let handler!: Handler;
  const server = {
    registerTool: (_name: string, _spec: unknown, h: Handler) => {
      handler = h;
    },
  } as unknown as McpServer;
  const ctx = {
    hudu: {} as ToolContext['hudu'],
    huduOrigin: 'https://hudu.invalid',
    config,
    log: createLogger('error', () => {}),
    ops: { searchKnowledge: options.searchKnowledge } as unknown as ToolContext['ops'],
    searchableResources: ['articles', 'assets'],
    defaultSearchScope: ['articles', 'assets'],
    indexSearchable: true,
    toolDefaultTier: 'index',
    searchTierIsPolicy: false,
    ...overrides,
  } as ToolContext;
  registerSearchTool(server, ctx);
  return handler;
}

function request(signal: AbortSignal, notify: (n: Notify) => Promise<void>, token?: string | number) {
  return { mcpReq: { _meta: token === undefined ? {} : { progressToken: token }, signal, notify } };
}

describe('hudu_search progress while awaiting the body index', () => {
  it('ticks first at 2s and then every 7s (at most 10s apart) when the caller sent a progress token', async () => {
    vi.useFakeTimers();
    try {
      const build = deferred<typeof RESULT>();
      const handler = harness({ searchKnowledge: () => build.promise as never });
      const received: Notify[] = [];
      const call = handler({ mode: 'search', query: 'reset', tier: 'index' }, request(new AbortController().signal, async (n) => received.push(n), 'tok-1'));
      // A fast build must not pay for a notification a caller never needed.
      await vi.advanceTimersByTimeAsync(1_999);
      expect(received).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(received).toHaveLength(1);
      expect(received[0]!.params!.progress).toBe(2);
      await vi.advanceTimersByTimeAsync(7_000);
      expect(received).toHaveLength(2);
      expect(received[1]!.params!.progress).toBe(9);
      // #52's bound is "at intervals of at most 10 s". `setInterval` never fires EARLY, so the
      // cadence constant itself must sit below the bound; the behavioural advance above proves the
      // 2 s first tick and the 7 s interval, and this pins the constant the scheduler uses.
      expect(PROGRESS_TICK_MS).toBeLessThanOrEqual(10_000);
      build.resolve(RESULT);
      await call;
      const params = received[0]!.params!;
      expect(received[0]!.method).toBe('notifications/progress');
      expect(params.progressToken).toBe('tok-1');
      expect(String(params.message)).toBe('body index build: 2s elapsed');
      // Time is the only measure: no invented total, no percentage.
      expect(params).not.toHaveProperty('total');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a synchronously throwing notify escape the timer', async () => {
    vi.useFakeTimers();
    try {
      const build = deferred<typeof RESULT>();
      const handler = harness({ searchKnowledge: () => build.promise as never });
      const call = handler(
        { mode: 'search', query: 'reset', tier: 'index' },
        request(new AbortController().signal, () => {
          throw new Error('stream already closed');
        }, 'tok-sync'),
      );
      // If the throw escaped the timer callback, this advance would reject.
      await vi.advanceTimersByTimeAsync(2_000);
      build.resolve(RESULT);
      await expect(call).resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends nothing when the caller sent no progress token', async () => {
    const build = deferred<typeof RESULT>();
    const handler = harness({ searchKnowledge: () => build.promise as never });
    const received: Notify[] = [];
    const call = handler({ mode: 'search', query: 'reset', tier: 'index' }, request(new AbortController().signal, async (n) => received.push(n)));
    build.resolve(RESULT);
    await call;
    expect(received).toEqual([]);
  });

  it('sends nothing on a path that never waits (tier vendor, and auto), even while the work is held open', async () => {
    // The work is held OPEN deliberately: a stub that resolves at once would pass even if the path
    // went through `awaitWithProgress`, because the first tick is 2 s away. A tier that never waits
    // must be silent with the promise still pending past one full cadence.
    vi.useFakeTimers();
    try {
      for (const tier of ['vendor', 'auto']) {
        const build = deferred<typeof RESULT>();
        const handler = harness({ searchKnowledge: () => build.promise as never });
        const received: Notify[] = [];
        const call = handler({ mode: 'search', query: 'reset', tier }, request(new AbortController().signal, async (n) => received.push(n), 'tok-2'));
        await vi.advanceTimersByTimeAsync(2_000);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(received, tier).toEqual([]);
        build.resolve(RESULT);
        await call;
        expect(received, tier).toEqual([]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('ticks for a forced rebuild (refresh:true) with a non-waiting tier', async () => {
    // `searchWaits` is `tier === "index" || refresh === true`: a rebuild can outlast a call timeout
    // just as a cold build can, so it must carry the same progress.
    vi.useFakeTimers();
    try {
      const build = deferred<typeof RESULT>();
      const handler = harness({ searchKnowledge: () => build.promise as never });
      const received: Notify[] = [];
      const call = handler({ mode: 'search', query: 'reset', tier: 'vendor', refresh: true }, request(new AbortController().signal, async (n) => received.push(n), 'tok-refresh'));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(received).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(7_000);
      expect(received).toHaveLength(2);
      build.resolve(RESULT);
      await call;
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the tick timer when the wait settles: no notification after the answer', async () => {
    vi.useFakeTimers();
    try {
      const build = deferred<typeof RESULT>();
      const handler = harness({ searchKnowledge: () => build.promise as never });
      const received: Notify[] = [];
      const call = handler({ mode: 'search', query: 'reset', tier: 'index' }, request(new AbortController().signal, async (n) => received.push(n), 'tok-settle'));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(received).toHaveLength(1);
      build.resolve(RESULT);
      await call;
      // Two cadences past a settled wait: a leaked interval would notify here.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(received).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers a cancelled wait with a degraded result, not a throw', async () => {
    // The SDK walk is not abortable, so the handler stops AWAITING and reports the honest state.
    const build = deferred<typeof RESULT>();
    const handler = harness({ searchKnowledge: () => build.promise as never });
    const controller = new AbortController();
    const call = handler({ mode: 'search', query: 'reset', tier: 'index' }, request(controller.signal, async () => {}, 'tok-3'));
    controller.abort();
    const result = await call;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.meta.degraded.reason).toBe('body-not-indexed');
    expect(result.structuredContent.meta.reasons).toEqual([]);
    expect(result.structuredContent.meta.cancelled).toEqual({ during: 'index-build', waited: true });
    expect(result.structuredContent.meta.complete).toBe(false);
    expect(result.structuredContent.hits).toEqual([]);
    expect(result.content[0].text).toContain('DEGRADED');
    build.resolve(RESULT);
  });

  it('answers the cancelled wait with a complete KnowledgeSearchMeta', async () => {
    // A cancelled answer is a real search answer. SEARCH_OUTPUT types `meta` as unknown, so this
    // asserts each published field directly rather than trusting a schema parse.
    const build = deferred<typeof RESULT>();
    const handler = harness({ searchKnowledge: () => build.promise as never });
    const controller = new AbortController();
    const call = handler({ mode: 'search', query: 'reset the vpn', tier: 'index', limit: 3 }, request(controller.signal, async () => {}, 'tok-5'));
    controller.abort();
    const result = await call;
    build.resolve(RESULT);
    const { meta } = result.structuredContent;
    expect(meta.query).toBe('reset the vpn');
    expect(meta.terms).toEqual(['reset', 'the', 'vpn']);
    expect(meta.resources).toEqual(['articles', 'assets']);
    expect(meta.limit).toBe(3);
    expect(meta.complete).toBe(false);
    expect(meta.reasons).toEqual([]);
    expect(meta.cancelled).toEqual({ during: 'index-build', waited: true });
    expect(meta.scanned).toBe(0);
    expect(meta.returned).toBe(0);
    expect(meta.degraded.reason).toBe('body-not-indexed');
    expect(meta.degraded.advice).toContain('not scored');
    // The SDK's closed union: no invented degraded reason value.
    expect(['no-index', 'vendor-only', 'body-not-indexed']).toContain(meta.degraded.reason);
    expect(meta.errors).toEqual([]);
    expect(meta.failed).toEqual([]);
    // Honest timings, not a zeroed network. `vendorMs` is 0 because no vendor-tier scoring ran; the
    // wait this call spent is `localMs`, the SDK's documented local time (which includes the index
    // wait); and a request count is NOT TRACKED for a cancelled wait, so it is not asserted as a
    // real count of zero — the answer text says so instead.
    expect(meta.timings.vendorMs).toBe(0);
    expect(meta.timings.localMs).toEqual(expect.any(Number));
    expect(meta.degraded.advice).toContain('NOT TRACKED');
    // Whoever stops awaiting the walk, the walk this call started keeps issuing Hudu requests. This
    // answer may say no ANSWER was scored and nothing was returned; it may not claim Hudu was left
    // untouched — these two assertions are what fail if that falsehood comes back.
    const text = result.content[0].text as string;
    expect(text).toContain('no answer was scored and nothing was returned');
    expect(text).toContain('continues in the background, still issuing Hudu requests');
    expect(text).not.toMatch(/nothing in Hudu was searched/i);
    expect(text).not.toMatch(/nothing was scored or requested/i);
    expect(text).not.toMatch(/nothing (was|has been) (requested|searched)/i);
    expect(meta.scoreScope).toBe('per-resource');
    expect(meta.bytes).toBe(2); // the serialised empty hits array
    // The index is exactly the SDK's KnowledgeIndexMeta: no generation was scored, so nothing
    // about one is claimed, and no status()-only field rides along.
    expect(meta.index.state).toBe('refreshing');
    expect(meta.index.staleness).toBe('unknown');
    expect(meta.index.docs).toEqual({});
    // The SDK declares builtAt/ageMs optional: no generation was scored, so they are OMITTED
    // rather than published as nulls that would describe a generation.
    expect(meta.index).not.toHaveProperty('builtAt');
    expect(meta.index).not.toHaveProperty('ageMs');
    expect(meta.index.indexChangedSinceScore).toBe(false);
    expect(meta.index.lastFullAt).toBeNull();
    expect(meta.index.lastCompleteFullAt).toBeNull();
    expect(meta.index.fullWalkDue).toBe(false);
    expect(Object.keys(meta.index).sort()).toEqual([
      'docs',
      'fullWalkDue',
      'indexChangedSinceScore',
      'lastCompleteFullAt',
      'lastFullAt',
      'staleness',
      'state',
    ]);
    expect(meta.index).not.toHaveProperty('watermarks');
    expect(meta.index).not.toHaveProperty('requestsLastBuild');
    expect(meta.index).not.toHaveProperty('lastBuildError');
    expect(meta.indexAge).toBeNull();
  });

  it('reports a cold index, not a refreshing one, when the request was already cancelled at entry', async () => {
    // Nothing was awaited, so claiming a build in flight would be false: the state is simply cold.
    // The abort check also precedes the work, so no build was started for a caller already gone.
    const build = deferred<typeof RESULT>();
    let started = 0;
    const handler = harness({
      searchKnowledge: () => {
        started += 1;
        return build.promise as never;
      },
    });
    const controller = new AbortController();
    controller.abort();
    const result = await handler({ mode: 'search', query: 'reset', tier: 'index' }, request(controller.signal, async () => {}, 'tok-6'));
    expect(started).toBe(0);
    expect(result.structuredContent.meta.index.state).toBe('cold');
    expect(result.structuredContent.meta.reasons).toEqual([]);
    expect(result.structuredContent.meta.cancelled).toEqual({ during: 'index-build', waited: false });
    expect(result.structuredContent.meta.timings.localMs).toBe(0);
    build.resolve(RESULT);
  });

  it('advises tier:"vendor" on a cancelled stdio wait, a field stdio actually serves', async () => {
    const build = deferred<typeof RESULT>();
    const handler = harness({ searchKnowledge: () => build.promise as never });
    const controller = new AbortController();
    const call = handler({ mode: 'search', query: 'reset', tier: 'index' }, request(controller.signal, async () => {}));
    controller.abort();
    const result = await call;
    build.resolve(RESULT);
    expect(JSON.parse(String(result.content[0].text)).text).toContain('tier:"vendor"');
    expect(result.structuredContent.meta.degraded.advice).toContain('tier:"vendor"');
  });

  it('advises a retry, not tier:"vendor", on a cancelled http wait', async () => {
    // Under `http` no tier field is served, and the policy path is exactly where cancellation fires:
    // the honest advice is that the background build continues, so a later search is body-backed.
    const build = deferred<typeof RESULT>();
    const handler = harness(
      { searchKnowledge: () => build.promise as never },
      { config: { MCP_TRANSPORT: 'http' } as ToolContext['config'], searchTierIsPolicy: true, toolDefaultTier: 'index' },
    );
    const controller = new AbortController();
    const call = handler({ mode: 'search', query: 'reset' }, request(controller.signal, async () => {}));
    controller.abort();
    const result = await call;
    build.resolve(RESULT);
    const answered = JSON.parse(String(result.content[0].text)).text as string;
    expect(answered).not.toContain('tier:"vendor"');
    expect(answered).toContain('body index keeps building in the background');
    expect(result.structuredContent.meta.degraded.advice).not.toContain('tier:"vendor"');
    expect(result.structuredContent.meta.degraded.advice).toContain('body index keeps building in the background');
  });

  it('waits, ticks and cancels on the http policy path when HUDU_SEARCH_TIER_POLICY is index', async () => {
    // The one http configuration that still blocks: the wait condition is transport-independent, so
    // it must get progress and cancellation like the stdio tier:"index" path.
    vi.useFakeTimers();
    try {
      const build = deferred<typeof RESULT>();
      const handler = harness(
        { searchKnowledge: () => build.promise as never },
        { config: { MCP_TRANSPORT: 'http' } as ToolContext['config'], searchTierIsPolicy: true, toolDefaultTier: 'index' },
      );
      const received: Notify[] = [];
      const controller = new AbortController();
      const call = handler({ mode: 'search', query: 'reset' }, request(controller.signal, async (n) => received.push(n), 'tok-http'));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(received).toHaveLength(1);
      controller.abort();
      const result = await call;
      expect(result.structuredContent.meta.reasons).toEqual([]);
      expect(result.structuredContent.meta.cancelled).toEqual({ during: 'index-build', waited: true });
      build.resolve(RESULT);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the answer when the client refuses the notification', async () => {
    vi.useFakeTimers();
    try {
      const build = deferred<typeof RESULT>();
      const handler = harness({ searchKnowledge: () => build.promise as never });
      const call = handler(
        { mode: 'search', query: 'reset', tier: 'index' },
        request(new AbortController().signal, async () => {
          throw new Error('client closed its stream');
        }, 'tok-4'),
      );
      await vi.advanceTimersByTimeAsync(2_000);
      build.resolve(RESULT);
      const result = await call;
      expect(result.structuredContent.meta.complete).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries the token across the real stdio transport', async () => {
    // The build must outlive the 2s first tick for a notification to cross the wire at all. Waiting
    // on the condition (the first progress notification on the wire) instead of a fixed sleep keeps
    // the test off a millisecond margin; the bound is generous and only fires on a real failure.
    let first = true;
    type LiveSession = Awaited<ReturnType<typeof connect>>;
    const seen: { session?: LiveSession } = {};
    const slow = (async () => {
      if (first) {
        first = false;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && !seen.session?.notifications().some((n) => n.method === 'notifications/progress')) {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      return Response.json([]);
    }) as unknown as (url: string) => Response;
    const session = await connect(slow);
    seen.session = session;
    const result = await session.call('hudu_search', { mode: 'search', query: 'reset', tier: 'index', limit: 1, snippetChars: 0 }, { progressToken: 'wire-1' });
    expect(result.isError).toBeUndefined();
    const ticks = session.notifications().filter((n) => n.method === 'notifications/progress');
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks[0].params.progressToken).toBe('wire-1');
    await session.close();
  });
});

describe('hudu_search refresh is stated honestly', () => {
  it('describes refresh as a local rebuild that touches nothing in Hudu', async () => {
    const session = await connect();
    const tool = (await session.list()).find((t) => t.name === 'hudu_search');
    const refresh: string = tool!.inputSchema.properties.refresh.description;
    expect(refresh).toContain('local');
    expect(refresh).toContain('no Hudu change');
    // The field is served only under stdio, so the description does not repeat that transport fact.
    // A rebuild is still a read of the tenant: the hint describes the target system.
    expect(tool!.annotations.readOnlyHint).toBe(true);
    const help = await session.call('hudu_search', { mode: 'help' });
    expect(String(help.structuredContent.help.text)).toContain('local body index');
    await session.close();
  });
});
