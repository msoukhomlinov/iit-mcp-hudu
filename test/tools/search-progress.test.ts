/**
 * search-progress.test.ts — `hudu_search` progress and cancellation while it AWAITS a body-index
 * build (issue #52). Pairs with the waiting path in `src/tools/search.ts`.
 *
 * The handler is driven directly with a fake `ctx`, because both the tick cadence and the abort
 * race need a build that is still running when the assertion is made — a stubbed Hudu answering
 * instantly would settle the walk before anything could be observed.
 */
import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { createLogger } from '../../src/logger.js';
import { registerSearchTool } from '../../src/tools/search.js';
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
function harness(options: { searchKnowledge: ToolContext['ops']['searchKnowledge'] }) {
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
  } as ToolContext;
  registerSearchTool(server, ctx);
  return handler;
}

function request(signal: AbortSignal, notify: (n: Notify) => Promise<void>, token?: string | number) {
  return { mcpReq: { _meta: token === undefined ? {} : { progressToken: token }, signal, notify } };
}

describe('hudu_search progress while awaiting the body index', () => {
  it('ticks at once when the caller sent a progress token and the call waits', async () => {
    const build = deferred<typeof RESULT>();
    const handler = harness({ searchKnowledge: () => build.promise as never });
    const received: Notify[] = [];
    const call = handler({ mode: 'search', query: 'reset', tier: 'index' }, request(new AbortController().signal, async (n) => received.push(n), 'tok-1'));
    // The first tick is immediate: a caller must not stare at silence for the first 10s.
    expect(received).toHaveLength(1);
    build.resolve(RESULT);
    await call;
    const params = received[0]!.params!;
    expect(received[0]!.method).toBe('notifications/progress');
    expect(params.progressToken).toBe('tok-1');
    expect(params.progress).toBe(0);
    expect(String(params.message)).toContain('body index build');
    // Time is the only measure: no invented total, no percentage.
    expect(params).not.toHaveProperty('total');
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

  it('sends nothing on a path that never waits (tier vendor, and auto)', async () => {
    for (const tier of ['vendor', 'auto']) {
      const handler = harness({ searchKnowledge: async () => RESULT as never });
      const received: Notify[] = [];
      await handler({ mode: 'search', query: 'reset', tier }, request(new AbortController().signal, async (n) => received.push(n), 'tok-2'));
      expect(received, tier).toEqual([]);
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
    expect(result.structuredContent.meta.degraded.reason).toBe('index-build-cancelled');
    expect(result.structuredContent.meta.complete).toBe(false);
    expect(result.structuredContent.hits).toEqual([]);
    expect(result.content[0].text).toContain('DEGRADED');
    build.resolve(RESULT);
  });

  it('keeps the answer when the client refuses the notification', async () => {
    const handler = harness({ searchKnowledge: async () => RESULT as never });
    const result = await handler(
      { mode: 'search', query: 'reset', tier: 'index' },
      request(new AbortController().signal, async () => {
        throw new Error('client closed its stream');
      }, 'tok-4'),
    );
    expect(result.structuredContent.meta.complete).toBe(true);
  });

  it('carries the token across the real stdio transport', async () => {
    const session = await connect(() => Response.json([]));
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
    expect(refresh).toContain('nothing in Hudu changes');
    expect(refresh).toContain('stdio only');
    // A rebuild is still a read of the tenant: the hint describes the target system.
    expect(tool!.annotations.readOnlyHint).toBe(true);
    const help = await session.call('hudu_search', { mode: 'help' });
    expect(String(help.structuredContent.help.text)).toContain('local body index');
    await session.close();
  });
});
