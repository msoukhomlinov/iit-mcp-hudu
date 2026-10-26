/**
 * typesense-tier.test.ts — the Typesense tier's policy surface (issue #57, DESIGN §4 WP-8..WP-10).
 *
 * Two invariants drive everything here:
 *
 * - With the tier unconfigured, nothing about this server changes: tier defaults, help text, served
 *   schema and doctor report are the pre-Typesense ones.
 * - With it configured, the default is `typesense` under BOTH transports (there is no corpus walk to
 *   wait for), a caller is told which body source answered, and the report/probe carry no key.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TYPESENSE_DEGRADED_REASONS as SDK_DEGRADED_REASONS, createClient, isDisclosureReason } from 'node-hudu';
import { loadConfig } from '../../src/config.js';
import { TYPESENSE_DEGRADED_REASONS } from '../../src/tools/search-prose.js';
import type { McpServer } from '@modelcontextprotocol/server';
import { createLogger } from '../../src/logger.js';
import { registerSearchTool } from '../../src/tools/search.js';
import type { ToolContext } from '../../src/tools/context.js';
import { probeTypesense } from '../../src/tools/typesense-probe.js';
import { runDoctor } from '../../src/doctor.js';
import { bodySourceNote } from '../../src/tools/results.js';
import { connect, connectForRequest, type Session } from '../helpers/mcp-session.js';

/** Obvious fakes only: no real key enters a test. */
const TYPESENSE = {
  HUDU_TYPESENSE_URL: 'https://typesense.example.com',
  HUDU_TYPESENSE_API_KEY: 'test-key-not-real',
} as const;

const CORPUS_EXCLUDED = { HUDU_SEARCH_RESOURCES: ['companies'] };

/** The URL a stubbed `fetch` was handed, for hosts that answer differently. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

/** Hudu-shaped for the Hudu host, Typesense-shaped for the Typesense host — never one stub for both. */
function typesenseOrHudu(input: RequestInfo | URL): Response {
  const url = urlOf(input);
  return url.includes('typesense.example.com')
    ? Response.json({ found: 0, hits: [], out_of: 0, page: 1, request_params: {} })
    : Response.json({ version: 'as-test', date: '2026-01-01' });
}

afterEach(() => vi.unstubAllGlobals());

async function excludedHelp() {
  const session = await stdioSession({ ...TYPESENSE, ...CORPUS_EXCLUDED });
  const result = await session.call('hudu_search', { mode: 'help' });
  await session.close();
  return result;
}

const toolOf = async (session: Session) => (await session.list()).find((t) => t.name === 'hudu_search')!;

async function stdioSession(override: Record<string, unknown>): Promise<Session> {
  return connect(undefined, override as never);
}

async function httpSession(override: Record<string, unknown>): Promise<Session> {
  return connectForRequest('key-a', () => Response.json([]), [], override as never);
}

describe('hudu_search default tier — the full matrix (configured/unset x stdio/http x corpus)', () => {
  it("unconfigured: today's defaults, verbatim", async () => {
    const stdio = await stdioSession({});
    expect((await stdio.call('hudu_search', { mode: 'help' })).structuredContent.help.defaults.tier).toBe('index');
    await stdio.close();

    const http = await httpSession({});
    expect((await http.call('hudu_search', { mode: 'help' })).structuredContent.help.defaults.tier).toBe('auto');
    await http.close();
  });

  it('unconfigured with the corpus excluded: vendor on both transports', async () => {
    const stdio = await stdioSession(CORPUS_EXCLUDED);
    expect((await stdio.call('hudu_search', { mode: 'help' })).structuredContent.help.defaults.tier).toBe('vendor');
    await stdio.close();

    const http = await httpSession(CORPUS_EXCLUDED);
    expect((await http.call('hudu_search', { mode: 'help' })).structuredContent.help.defaults.tier).toBe('vendor');
    await http.close();
  });

  it('configured: typesense on BOTH transports, because there is no cold start', async () => {
    const stdio = await stdioSession(TYPESENSE);
    expect((await stdio.call('hudu_search', { mode: 'help' })).structuredContent.help.defaults.tier).toBe('typesense');
    await stdio.close();

    const http = await httpSession(TYPESENSE);
    expect((await http.call('hudu_search', { mode: 'help' })).structuredContent.help.defaults.tier).toBe('typesense');
    await http.close();
  });

  it('configured with the corpus excluded: the corpus gate still wins, so vendor', async () => {
    const stdio = await stdioSession({ ...TYPESENSE, ...CORPUS_EXCLUDED });
    expect((await stdio.call('hudu_search', { mode: 'help' })).structuredContent.help.defaults.tier).toBe('vendor');
    await stdio.close();

    const http = await httpSession({ ...TYPESENSE, ...CORPUS_EXCLUDED });
    expect((await http.call('hudu_search', { mode: 'help' })).structuredContent.help.defaults.tier).toBe('vendor');
    await http.close();
  });

  it('an explicit policy still wins over the configured default', async () => {
    const stdio = await stdioSession({ ...TYPESENSE, HUDU_SEARCH_TIER_POLICY: 'index' });
    expect((await stdio.call('hudu_search', { mode: 'help' })).structuredContent.help.defaults.tier).toBe('index');
    await stdio.close();
  });
});

describe('hudu_search schema and prose', () => {
  it('serves tier "typesense" under stdio, and still serves no tier at all under http', async () => {
    const stdio = await stdioSession(TYPESENSE);
    const tool = await toolOf(stdio);
    expect(tool.inputSchema.properties.tier.items?.enum ?? tool.inputSchema.properties.tier.enum).toContain('typesense');
    expect(String(tool.inputSchema.properties.tier.description)).toContain('typesense');
    await stdio.close();

    const http = await httpSession(TYPESENSE);
    const httpTool = await toolOf(http);
    expect(httpTool.inputSchema.properties).not.toHaveProperty('tier');
    expect(httpTool.description).toContain('server-side to "typesense"');
    await http.close();
  });

  it('names meta.bodySource and every Typesense degraded reason when configured', async () => {
    const session = await stdioSession(TYPESENSE);
    const raw = (await session.call('hudu_search', { mode: 'help' })).content[0].text;
    const text = JSON.parse(String(raw)).text as string;
    expect(text).toContain('meta.bodySource');
    // ONE literal drives both the prose and this assertion, in the SDK's union order.
    expect(TYPESENSE_DEGRADED_REASONS).toEqual([
      'typesense-unavailable',
      'typesense-unauthorized',
      'typesense-query-error',
      'typesense-hits-stale',
      'typesense-hits-unhydratable',
    ]);

    // Every reason is in the help, in that order, and each carries its operator action...
    let cursor = -1;
    for (const reason of TYPESENSE_DEGRADED_REASONS) {
      const at = text.indexOf(`"${reason}"`);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
    for (const [action, reason] of [
      ['transient', 'typesense-unavailable'],
      ['credential', 'typesense-unauthorized'],
      ['config bug', 'typesense-query-error'],
      ['transient', 'typesense-hits-stale'],
      ['data', 'typesense-hits-unhydratable'],
    ] as const) {
      expect(text).toMatch(new RegExp(`${action}:\\s+"${reason}"`));
    }
    // ...and no reason outside that literal is advertised.
    expect(text.match(/typesense-[a-z-]+"/g)?.sort()).toEqual([...TYPESENSE_DEGRADED_REASONS].map((r) => `${r}"`).sort());
    // The reason strings are the SDK's own, passed through: the help says so, so a rename is visible.
    expect(text).toContain("`reason` is the");
    expect(text).toContain('passed through unchanged');
    // And this server holds NO schema enum of its own to drift: the served output schema does not
    // enumerate a single reason, so the literal above is the only place the list can go stale.
    const searchTool = (await session.list()).find((x) => x.name === 'hudu_search')!;
    expect(JSON.stringify(searchTool.outputSchema)).not.toContain('typesense-');
    expect(JSON.stringify(searchTool.outputSchema)).not.toContain('body-not-indexed');
    // The config bug must not read as an outage, and the data problem must not read as staleness.
    expect(text).toContain('this is not an');
    expect(text).toContain('the data is the cause, not staleness');
    // Staleness explains the 403/404 split truthfully, and the open question stays named as one.
    // The clause is deliberately SHORT: the served surface is measured, so the detail lives in the
    // README and the four facts a caller acts on stay in the help text.
    expect(text).toContain('403 vs 404');
    expect(text).toContain('unverified upstream');
    expect(text).toContain('404 is a silent stale drop');
    expect(text).toContain('403 a surfaced failure');
    expect(text).toContain('complete:false');
    expect(text).toContain('meta.errors');
    // The old claim (a 403 folded into the silent-drop path) must never come back.
    expect(text).not.toContain('both map to the same silent-drop path');
    expect(text).not.toContain('indistinguishable from a discarded one');
    await session.close();
  });

  it('leaves the help text free of Typesense vocabulary when unconfigured', async () => {
    // The unset path must be byte-identical, and a reason code that cannot occur would be a lie.
    const session = await stdioSession({});
    const text = String((await session.call('hudu_search', { mode: 'help' })).content[0].text);
    expect(text).not.toContain('typesense');
    expect(text).not.toContain('meta.bodySource');
    for (const reason of ['unavailable', 'unauthorized', 'query-error', 'hits-stale', 'hits-unhydratable']) {
      expect(text).not.toContain(reason);
    }
    await session.close();
  });

  it('resolves a configured typesense policy to vendor on an excluded corpus, claiming no body source', async () => {
    // The corpus gate beats the policy: the tier is vendor, so the answer must never carry
    // `bodySource: "typesense"` (that would claim a body tier ran) nor advertise one.
    const session = await stdioSession({ ...TYPESENSE, ...CORPUS_EXCLUDED, HUDU_SEARCH_TIER_POLICY: 'typesense' });
    vi.stubGlobal('fetch', async () => Response.json([]));
    const result = await session.call('hudu_search', { mode: 'search', query: 'reset' });
    expect(result.isError).toBeUndefined();
    const bodySource = (result.structuredContent.meta as Record<string, unknown>).bodySource;
    expect(bodySource).not.toBe('typesense');
    expect([undefined, 'none']).toContain(bodySource);
    expect(String(result.content[0].text)).not.toContain('body source: typesense');
    await session.close();
  });

  it('states the corpus resolution where it states the tier policy', async () => {
    const excluded = await stdioSession({ ...TYPESENSE, ...CORPUS_EXCLUDED });
    expect(String((await toolOf(excluded)).description)).toContain('corpus gate resolves it to "vendor"');
    await excluded.close();
    const http = await httpSession({ ...TYPESENSE, ...CORPUS_EXCLUDED });
    const description = String((await toolOf(http)).description);
    expect(description).toContain('no body tier runs');
    expect(description).toContain('corpus gate resolves it to "vendor"');
    await http.close();
    // The on-demand help states it in the same sentence as the tier, too.
    const help = JSON.parse(String((await excludedHelp()).content[0]?.text ?? '{}')).text as string;
    expect(help).toContain('corpus gate resolves it to "vendor" as well');
    // ...and it is absent from the full-corpus help, where no resolution happens.
    const full = await stdioSession(TYPESENSE);
    const fullHelp = JSON.parse(String((await full.call('hudu_search', { mode: 'help' })).content[0]?.text ?? '{}')).text as string;
    expect(fullHelp).not.toContain('corpus gate resolves it');
    await full.close();
  });

  it('refuses tier:"typesense" when the corpus is excluded, naming both body tiers', async () => {
    const session = await stdioSession({ ...TYPESENSE, ...CORPUS_EXCLUDED });
    const result = await session.call('hudu_search', { mode: 'search', query: 'reset', tier: 'typesense' });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text);
    expect(body.code).toBe('CONFIG_ERROR');
    expect(body.message).toContain('Typesense');
    expect(session.urls).toEqual([]);
    await session.close();
  });
});

describe('HUDU_TYPESENSE_VERIFY_HITS', () => {
  it('turns the gate off in the SDK block without touching anything else', async () => {
    const config = loadConfig({
      HUDU_BASE_URL: 'https://hudu.example.com',
      HUDU_API_KEY: 'k-123',
      ...TYPESENSE,
      HUDU_TYPESENSE_VERIFY_HITS: 'false',
    });
    expect(config.HUDU_TYPESENSE_VERIFY_HITS).toBe(false);
  });
});

describe('meta.bodySource in the compact header', () => {
  it('names the source the SDK reported, and adds nothing when it reported none', () => {
    expect(bodySourceNote({ bodySource: 'typesense' })).toBe(' body source: typesense.');
    expect(bodySourceNote({ bodySource: 'index' })).toBe(' body source: index.');
    expect(bodySourceNote({ bodySource: 'none' })).toBe(' body source: none.');
    // An ABSENT or unknown value prints nothing: the note repeats the SDK's word and never invents one.
    expect(bodySourceNote({})).toBe('');
    expect(bodySourceNote({ bodySource: 'elsewhere' })).toBe('');
    expect(bodySourceNote(undefined)).toBe('');
  });
});

describe('hudu_get_api_info — the Typesense probe', () => {
  it('reports configured, reachable, collections and probeMs when the tier is on', async () => {
    const session = await stdioSession(TYPESENSE);
    // Two hosts, two shapes: the Hudu read answers `api_info`, the Typesense search answers the one
    // `q=*&per_page=0` probe request. A single Hudu-shaped stub would make the probe fail the parse
    // and report TYPESENSE_QUERY_ERROR — a stub artefact, not the behaviour under test.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => typesenseOrHudu(input));
    const result = await session.call('hudu_get_api_info', {});
    expect(result.isError).toBeUndefined();
    const typesense = result.structuredContent.typesense;
    expect(typesense).toMatchObject({
      configured: true,
      reachable: true,
      collections: ['articles', 'assets'],
    });
    expect(typesense.error).toBeUndefined();
    expect(typeof typesense.probeMs).toBe('number');
    // The output schema is deliberately open (`z.unknown()`), so the SHAPE is asserted here instead:
    // exactly these keys, and `error` only when the probe could not answer.
    expect(Object.keys(typesense).sort()).toEqual(['collections', 'configured', 'probeMs', 'reachable', 'results']);
    // The probe must never fail the read, and it carries no key and no endpoint.
    expect(JSON.stringify(result.structuredContent)).not.toContain(TYPESENSE.HUDU_TYPESENSE_API_KEY);
    expect(JSON.stringify(result.structuredContent)).not.toContain('typesense.example.com');
    await session.close();
  });

  it('dials nothing and reports configured:false when the tier is unconfigured', async () => {
    const report = await probeTypesense({ operations: {} } as never, loadConfig({ HUDU_BASE_URL: 'https://hudu.example.com', HUDU_API_KEY: 'k-123' }));
    expect(report).toEqual({ configured: false, reachable: false, collections: [], probeMs: 0 });
  });

  // The #56 bump checklist item, live on node-hudu 0.21.0. It asserts the DEFAULT read policy
  // PERMITS the operation — membership on `operations`, not merely "the call does not throw" — and
  // that the permitted call returns the typed result with no error.
  it('the default read policy permits probeBodySearch, and the call returns its typed result', async () => {
    // The probe asks the CLIENT's own `search.typesense` block, so the client must carry the same
    // block the MCP config maps in — a client without it answers configured:false and dials nothing.
    const client = createClient({
      baseUrl: 'https://hudu.example.com',
      apiKey: 'k-123',
      search: { typesense: { url: TYPESENSE.HUDU_TYPESENSE_URL, apiKey: TYPESENSE.HUDU_TYPESENSE_API_KEY } },
    });
    expect('probeBodySearch' in client.operations).toBe(true);
    // The SDK dials its own Typesense endpoint; a search-only `per_page=0` answer is all it needs.
    const wire: { path: string; params: URLSearchParams }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(urlOf(input));
      if (url.host !== 'typesense.example.com') return Response.json({ version: 'as-test', date: '2026-01-01' });
      wire.push({ path: url.pathname, params: url.searchParams });
      return Response.json({ found: 3, hits: [], out_of: 3, page: 1, request_params: {} });
    });
    const report = await probeTypesense(
      client,
      loadConfig({ HUDU_BASE_URL: 'https://hudu.example.com', HUDU_API_KEY: 'k-123', ...TYPESENSE }),
    );
    expect(wire).toHaveLength(2);
    // The contract that keeps a SEARCH-ONLY key sufficient: one document search, both parameters the
    // SDK sends, asserted by name — a `q` that is not `*` or a missing `query_by` is a different request.
    expect(wire[0].path).toBe('/collections/articles/documents/search');
    expect(wire[1].path).toBe('/collections/assets/documents/search');
    expect(wire[0].params.get('q')).toBe('*');
    expect(wire[0].params.get('query_by')).toBe('name');
    expect(wire[0].params.get('per_page')).toBe('0');
    // And no schema listing, asserted on the PATHS rather than on a query string: `/collections` has
    // no query, so a `not.toContain('/collections?')` check could never catch it. The only path that
    // may start `/collections/` is the search endpoint above.
    const listings = wire.filter((r) => r.path === '/collections' || (r.path.startsWith('/collections/') && !r.path.endsWith('/documents/search')));
    expect(listings).toEqual([]);
    expect(report).toEqual({
      configured: true,
      reachable: true,
      collections: ['articles', 'assets'],
      probeMs: expect.any(Number),
      results: [
        { collection: 'articles', reachable: true, found: 3 },
        { collection: 'assets', reachable: true, found: 3 },
      ],
    });
    expect(report.error).toBeUndefined();
    expect(Object.keys(report).sort()).toEqual(['collections', 'configured', 'probeMs', 'reachable', 'results']);
    expect(JSON.stringify(report)).not.toContain(TYPESENSE.HUDU_TYPESENSE_API_KEY);
  });

  it('adds no field at all when the tier is unconfigured', async () => {
    const session = await stdioSession({});
    vi.stubGlobal('fetch', async () => Response.json({ version: 'as-test', date: '2026-01-01' }));
    const result = await session.call('hudu_get_api_info', {});
    expect(result.structuredContent).not.toHaveProperty('typesense');
    await session.close();
  });
});

describe('the query-error clause lives where a caller looks for it', () => {
  it('tells a configured caller that a typesense-query-error is a COLLECTION NAME problem, not an outage', async () => {
    // It moved OUT of `hudu_get_api_info`'s description and into `hudu_search` help: the probe
    // fields are self-describing, and a sentence repeated on every deployment that configures the
    // tier is served bytes the surface budget cannot pay for (surface-size.test.ts measures it).
    const session = await stdioSession(TYPESENSE);
    const help = String((await session.call('hudu_search', { mode: 'help' })).content[0].text);
    expect(help).toContain('typesense-query-error');
    expect(help).toContain('COLLECTION NAME or query is wrong');
    expect(help).toContain('this is not an');
    expect(help).toContain('outage');
    // The tool description itself is the same string either way, and names no Typesense vocabulary.
    const description = String((await session.list()).find((x) => x.name === 'hudu_get_api_info')!.description);
    expect(description).not.toContain('typesense');
    const unset = await stdioSession({});
    expect(String((await unset.list()).find((x) => x.name === 'hudu_get_api_info')!.description)).toBe(description);
    await unset.close();
    await session.close();
  });
});

describe('doctor — the config-shape row', () => {
  const base = { HUDU_BASE_URL: 'https://hudu.example.com', HUDU_API_KEY: 'k-123' };

  it('is a zero-wire shape report, with no key material anywhere in it', () => {
    const report = runDoctor(loadConfig({ ...base, ...TYPESENSE }));
    expect(report.dialed).toBe(0);
    expect(report.typesense).toEqual({ configured: true, keyPresent: true, urlShapeOk: true });
    const json = JSON.stringify(report);
    expect(json).not.toContain(TYPESENSE.HUDU_TYPESENSE_API_KEY);
    expect(json).not.toContain('test-key');
  });

  it('is absent, leaving the report shape unchanged, when the tier is unconfigured', () => {
    const report = runDoctor(loadConfig(base));
    expect(report).not.toHaveProperty('typesense');
    // The keys an operator may already script against stay exactly as they were.
    expect(Object.keys(report)).toEqual(['ok', 'transport', 'dialed', 'credentials', 'bases', 'notes']);
  });

  it('reports a loopback origin (the tunnel mode) as shape-ok', () => {
    const report = runDoctor(loadConfig({ ...base, ...TYPESENSE, HUDU_TYPESENSE_URL: 'http://127.0.0.1:8108' }));
    expect(report.typesense?.urlShapeOk).toBe(true);
  });
});

describe('meta.degraded.reason is passed through, never mapped or renamed', () => {
  /**
   * The pairing between this server and the SDK breaks silently if a reason is renamed here, so the
   * walk is asserted: whatever the SDK returns is what the caller receives, in the data and the text.
   */
  function searchWith(reason: string, advice = 'SDK advice, verbatim.') {
    let handler!: (args: Record<string, unknown>, req: unknown) => Promise<{ content: { text: string }[]; structuredContent: Record<string, any> }>;
    const server = {
      registerTool: (_n: string, _s: unknown, h: typeof handler) => {
        handler = h;
      },
    } as unknown as McpServer;
    const result = {
      hits: [],
      meta: {
        complete: false,
        reasons: [],
        failed: [],
        errors: [],
        index: { state: 'warm' },
        scanned: 0,
        returned: 0,
        degraded: { reason, advice },
      },
    };
    registerSearchTool(server, {
      hudu: {},
      huduOrigin: 'https://hudu.invalid',
      config: { MCP_TRANSPORT: 'stdio' },
      log: createLogger('error', () => {}),
      ops: { searchKnowledge: async () => result },
      searchableResources: ['articles', 'assets'],
      defaultSearchScope: ['articles', 'assets'],
      bodySearchable: true,
      toolDefaultTier: 'typesense',
      typesenseConfigured: true,
      searchTierIsPolicy: false,
    } as unknown as ToolContext);
    return handler({ mode: 'search', query: 'reset' }, { mcpReq: { _meta: {}, signal: new AbortController().signal, notify: async () => {} } });
  }

  it('carries each of the five reasons, and a reason it has never seen, unchanged', async () => {
    for (const reason of [...TYPESENSE_DEGRADED_REASONS, 'typesense-something-new']) {
      const answered = await searchWith(reason);
      expect(answered.structuredContent.meta.degraded.reason).toBe(reason);
      expect(answered.structuredContent.meta.degraded.advice).toBe('SDK advice, verbatim.');
      expect(answered.content[0].text).toContain(`DEGRADED (${reason})`);
    }
  });
});


describe('completeness and the reason union are the SDK\'s, not local restatements', () => {
  it("the five reasons equal the SDK's exported union at runtime, in order", () => {
    // Compared against the INSTALLED package, not a comment: a sixth reason added to node-hudu, or a
    // reorder on either side, fails here instead of in production.
    expect([...TYPESENSE_DEGRADED_REASONS]).toEqual([...SDK_DEGRADED_REASONS]);
    expect(SDK_DEGRADED_REASONS).toHaveLength(5);
  });

  it('every Typesense degraded reason breaks completeness; none is a disclosure count', () => {
    // The predicate the server imports for its own prose. All five are failures, so none is a count.
    for (const reason of TYPESENSE_DEGRADED_REASONS) {
      expect(isDisclosureReason(reason), `${reason} must break completeness`).toBe(false);
    }
  });

  it('the disclosure counts the SDK documents are NOT in this server\'s reason list', () => {
    // Exactly the two the SDK documents as counts; `result-limit` is deliberately NOT one (it omitted
    // hits the caller could have had), which is why it is asserted false below.
    for (const count of ['typesense-candidates-unverified:3', 'typesense-candidates-capped:5']) {
      expect(isDisclosureReason(count)).toBe(true);
      expect(TYPESENSE_DEGRADED_REASONS as readonly string[]).not.toContain(count);
    }
    expect(isDisclosureReason('result-limit')).toBe(false);
  });
});
