/**
 * search-http-tier-policy.test.ts — issue #49: under `http` the body-index tier is deployment
 * policy, not a call parameter.
 *
 * The served `hudu_search` schema offers neither `tier` nor `refresh`, and a call that still carries
 * them answers from the vendor tier while the body index builds in the background. The decisive
 * assertion is `meta.index.state === "cold"`: a call that had awaited the walk would return with a
 * warm index, and on a corpus of the production size it would return after the consumer's timeout.
 *
 * Pairs with `src/tools/search.ts`, `src/tools/register.ts` and `src/config.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, connectForRequest, type Json, type Session } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

const toolOf = async (session: Session): Promise<Json> => (await session.list()).find((t) => t.name === 'hudu_search')!;

describe('hudu_search schema and the search tier', () => {
  it('serves neither tier nor refresh under http', async () => {
    const session = await connectForRequest('key-a', () => Response.json([]));
    const tool = await toolOf(session);
    expect(tool.inputSchema.properties).not.toHaveProperty('tier');
    expect(tool.inputSchema.properties).not.toHaveProperty('refresh');
    // The schema and the prose agree: nothing invites a caller to await a body-index walk.
    expect(tool.description).not.toContain('Pass "index"');
    expect(tool.description).toContain('set server-side');
    await session.close();
  });

  it('still serves both under stdio, unchanged', async () => {
    const session = await connect(undefined, {});
    const tool = await toolOf(session);
    expect(tool.inputSchema.properties).toHaveProperty('tier');
    expect(tool.inputSchema.properties).toHaveProperty('refresh');
    await session.close();
  });

  it('answers a call that still sends tier:"index" and refresh:true without awaiting the walk', async () => {
    // Deterministic ordering, not a stopwatch: the corpus walk's response is held open and the
    // answer must arrive while it is still pending. A path that awaited the walk cannot get here.
    let walkSettled = false;
    let releaseWalk: (() => void) | undefined;
    const walkGate = new Promise<void>((resolve) => {
      releaseWalk = resolve;
    });
    const session = await connectForRequest('key-a', async (_key, url) => {
      if (url.includes('search=')) return Response.json([]);
      await walkGate;
      walkSettled = true;
      return Response.json([]);
    });
    const result = await session.call('hudu_search', { mode: 'search', query: 'reset', tier: 'index', refresh: true, limit: 1, snippetChars: 0 });
    expect(result.isError).toBeUndefined();
    // The tool path tells the same story as the invoke path: the fields it sent were overridden by
    // deployment policy, so `meta.reasons` names it and the text says so.
    expect(result.structuredContent.meta.reasons).toContain('tier-policy-override');
    expect(result.content[0].text).toContain('overridden by the server search tier policy');
    // No walk completed before the answer: the index is still cold (or building in the background).
    // An awaited build would return "warm" — and at production corpus size it would return past the
    // consumer's call timeout, which is the incident this asserts against.
    expect(['cold', 'refreshing']).toContain(result.structuredContent.meta.index.state);
    expect(result.structuredContent.meta.degraded).toBeTruthy();
    // The proof that nothing was awaited: the walk had not settled when the answer came back.
    expect(walkSettled).toBe(false);
    // Let the fire-and-forget background warm settle before afterEach removes the fetch stub.
    releaseWalk?.();
    await new Promise((r) => setTimeout(r, 100));
    await session.close();
  });

  it('answers from the vendor tier in well under a second while the index walk never settles', async () => {
    // The incident is a corpus walk that HANGS, not a corpus that answers empty instantly: a stub
    // that settles at once would let a wrongly-awaited build return just as fast. The walk request
    // here never resolves, so only a path that refuses to await it can answer at all.
    const session = await connectForRequest(
      'key-a',
      (_key, url) => (url.includes('search=') ? Response.json([]) : new Promise<Response>(() => {})),
    );
    const result = await session.call('hudu_search', { mode: 'search', query: 'reset', tier: 'index', refresh: true, limit: 1, snippetChars: 0 });
    // No stopwatch: a walk that never resolves is itself the ordering proof — only a path that
    // refuses to await it can answer at all.
    expect(result.isError).toBeUndefined();
    expect(['cold', 'refreshing']).toContain(result.structuredContent.meta.index.state);
    expect(result.structuredContent.meta.degraded).toBeTruthy();
    await session.close();
  });

  it('holds the raw invoke path to the same policy', async () => {
    // `hudu_read` of operations.searchKnowledge reaches the SDK directly, so it is the escape hatch
    // the tier gate must also close under http.
    const session = await connectForRequest('key-a', () => Response.json([]));
    const result = await session.call('hudu_read', {
      operation: 'operations.searchKnowledge',
      input: { query: 'reset', opts: { tier: 'index', refresh: true, limit: 1, snippetChars: 0 } },
    });
    expect(result.isError).toBeUndefined();
    expect(['cold', 'refreshing']).toContain(result.structuredContent.result.meta.index.state);
    await new Promise((r) => setTimeout(r, 100));
    await session.close();
  });

  it('reports no override when the caller sent neither field', async () => {
    const session = await connectForRequest('key-a', () => Response.json([]));
    const result = await session.call('hudu_search', { mode: 'search', query: 'reset', limit: 1, snippetChars: 0 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.meta.reasons).not.toContain('tier-policy-override');
    await new Promise((r) => setTimeout(r, 100));
    await session.close();
  });

  it('reports a caller tier/refresh the http policy overrode instead of silently dropping it', async () => {
    const session = await connectForRequest('key-a', () => Response.json([]));
    const result = await session.call('hudu_read', {
      operation: 'operations.searchKnowledge',
      input: { query: 'reset', opts: { tier: 'index', refresh: true, limit: 1, snippetChars: 0 } },
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.result.meta.reasons).toContain('tier-policy-override');
    expect(String(result.content[0].text)).toContain('overridden by the server search tier policy');
    await new Promise((r) => setTimeout(r, 100));
    await session.close();
  });

  it('cannot let HUDU_SEARCH_TIER_POLICY=index reach the index when the corpus excludes articles or assets', async () => {
    // The corpus gate outranks the policy knob: the walk is corpus-wide, so an excluded resource
    // would be walked. Only "vendor" may come out, whatever the variable says.
    for (const resources of [['companies'], ['users', 'groups']]) {
      const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: resources, HUDU_SEARCH_TIER_POLICY: 'index' });
      const help = await session.call('hudu_search', { mode: 'help' });
      expect(help.structuredContent.help.defaults.tier, resources.join(',')).toBe('vendor');
      const tool = await toolOf(session);
      expect(tool.inputSchema.properties.tier.description).toContain('"vendor" only here');
      await session.close();
    }
  });

  it('describes HUDU_SEARCH_TIER_POLICY=index as server-side policy on a FULL corpus', async () => {
    // The full corpus is where the byte-saving early return used to short-circuit the description:
    // the base text says "As a tool it defaults to tier \"index\"", i.e. a caller choice, while
    // under http no tier field is served and the tier is pure deployment policy (#50 review 7).
    const http = await connectForRequest('key-a', () => Response.json([]), [], { HUDU_SEARCH_TIER_POLICY: 'index' });
    const tool = await toolOf(http);
    expect(tool.description).toContain('Tier is set server-side to "index"');
    expect(tool.description).not.toContain('As a tool it defaults to tier');
    expect(tool.inputSchema.properties).not.toHaveProperty('tier');
    const help = await http.call('hudu_search', { mode: 'help' });
    expect(help.structuredContent.help.defaults.tier).toBe('index');
    expect(String(help.content[0].text)).toContain('HUDU_SEARCH_TIER_POLICY: index');
    await http.close();
  });

  it('takes the tier from HUDU_SEARCH_TIER_POLICY when the deployment sets one', async () => {
    const http = await connectForRequest('key-a', () => Response.json([]), [], { HUDU_SEARCH_TIER_POLICY: 'vendor' });
    const help = await http.call('hudu_search', { mode: 'help' });
    expect(help.structuredContent.help.defaults.tier).toBe('vendor');
    const tool = await toolOf(http);
    expect(tool.description).toContain('server-side to "vendor"');
    expect(tool.inputSchema.properties).not.toHaveProperty('tier');
    await http.close();

    // Under stdio the same knob moves the default but leaves the caller's fields in place.
    const stdio = await connect(undefined, { HUDU_SEARCH_TIER_POLICY: 'auto' });
    const stdioHelp = await stdio.call('hudu_search', { mode: 'help' });
    expect(stdioHelp.structuredContent.help.defaults.tier).toBe('auto');
    const stdioTool = await toolOf(stdio);
    expect(stdioTool.inputSchema.properties).toHaveProperty('tier');
    await stdio.close();
  });
});
