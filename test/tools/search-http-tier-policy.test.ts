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
    expect(tool.description).toContain('sets the search tier server-side');
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
    const session = await connectForRequest('key-a', () => Response.json([]));
    const started = Date.now();
    const result = await session.call('hudu_search', { mode: 'search', query: 'reset', tier: 'index', refresh: true, limit: 1, snippetChars: 0 });
    const elapsed = Date.now() - started;
    expect(result.isError).toBeUndefined();
    // No walk completed before the answer: the index is still cold (or building in the background).
    // An awaited build would return "warm" — and at production corpus size it would return past the
    // consumer's call timeout, which is the incident this asserts against.
    expect(['cold', 'refreshing']).toContain(result.structuredContent.meta.index.state);
    expect(result.structuredContent.meta.degraded).toBeTruthy();
    expect(elapsed).toBeLessThan(2000);
    // Let the fire-and-forget background warm settle before afterEach removes the fetch stub.
    await new Promise((r) => setTimeout(r, 100));
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
