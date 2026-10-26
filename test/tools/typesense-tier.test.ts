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
import { createClient } from 'node-hudu';
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
    // node-hudu 0.20.0 never sets the field; an unknown value is not vocabulary this server invents.
    expect(bodySourceNote({})).toBe('');
    expect(bodySourceNote({ bodySource: 'elsewhere' })).toBe('');
    expect(bodySourceNote(undefined)).toBe('');
  });
});

describe('hudu_get_api_info — the Typesense probe', () => {
  it('reports configured, reachable, collections and probeMs when the tier is on', async () => {
    const session = await stdioSession(TYPESENSE);
    vi.stubGlobal('fetch', async () => Response.json({ version: 'as-test', date: '2026-01-01' }));
    const result = await session.call('hudu_get_api_info', {});
    expect(result.isError).toBeUndefined();
    const typesense = result.structuredContent.typesense;
    // 0.20.0 has no probe in its capability registry, so the build-time question fails first and the
    // report says which question failed — it does not pretend the endpoint was unreachable.
    expect(typesense).toMatchObject({
      configured: true,
      reachable: false,
      collections: ['articles', 'assets'],
      error: { code: 'NOT_IMPLEMENTED', message: 'this SDK version has no operations.probeBodySearch' },
    });
    expect(typeof typesense.probeMs).toBe('number');
    // The output schema is deliberately open (`z.unknown()`), so the SHAPE is asserted here instead:
    // exactly these keys, and `error` only when the probe could not answer.
    expect(Object.keys(typesense).sort()).toEqual(['collections', 'configured', 'error', 'probeMs', 'reachable']);
    // The probe must never fail the read, and it carries no key and no endpoint.
    expect(JSON.stringify(result.structuredContent)).not.toContain(TYPESENSE.HUDU_TYPESENSE_API_KEY);
    expect(JSON.stringify(result.structuredContent)).not.toContain('typesense.example.com');
    await session.close();
  });

  it('dials nothing and reports configured:false when the tier is unconfigured', async () => {
    const report = await probeTypesense({ operations: {} } as never, loadConfig({ HUDU_BASE_URL: 'https://hudu.example.com', HUDU_API_KEY: 'k-123' }));
    expect(report).toEqual({ configured: false, reachable: false, collections: [], probeMs: 0 });
  });

  // TODO(node-hudu@0.21.0), a checklist item on #56: activates with the bump, and until it runs the
  // bump must not land. It asserts the DEFAULT read policy PERMITS the operation (membership, not
  // "does not throw") and that the permitted call returns the typed result with no error.
  it.skip('the default read policy permits probeBodySearch, and the call returns its typed result', async () => {
    const client = createClient({ baseUrl: 'https://hudu.example.com', apiKey: 'k-123' }) as unknown as {
      operations: Record<string, unknown>;
    };
    expect('probeBodySearch' in client.operations).toBe(true);
    // The SDK dials its own Typesense endpoint; a search-only `per_page=0` answer is all it needs.
    vi.stubGlobal('fetch', async () => Response.json({ found: 3, hits: [], out_of: 3, page: 1, request_params: {} }));
    const report = await probeTypesense(
      client as never,
      loadConfig({ HUDU_BASE_URL: 'https://hudu.example.com', HUDU_API_KEY: 'k-123', ...TYPESENSE }),
    );
    expect(report).toEqual({
      configured: true,
      reachable: true,
      collections: ['articles', 'assets'],
      probeMs: expect.any(Number),
    });
    expect(report.error).toBeUndefined();
    expect(Object.keys(report).sort()).toEqual(['collections', 'configured', 'probeMs', 'reachable']);
  });

  it('adds no field at all when the tier is unconfigured', async () => {
    const session = await stdioSession({});
    vi.stubGlobal('fetch', async () => Response.json({ version: 'as-test', date: '2026-01-01' }));
    const result = await session.call('hudu_get_api_info', {});
    expect(result.structuredContent).not.toHaveProperty('typesense');
    await session.close();
  });
});

describe('hudu_get_api_info — the query-error clause', () => {
  it('says a typesense-query-error is a COLLECTION NAME problem, not an outage', async () => {
    const session = await stdioSession(TYPESENSE);
    const description = String((await session.list()).find((x) => x.name === 'hudu_get_api_info')!.description);
    expect(description).toContain('typesense-query-error');
    expect(description).toContain('COLLECTION NAME is wrong');
    expect(description).toContain('not that Typesense is down');
    // Unconfigured deployments never see the field, so they never see the clause either.
    const unset = await stdioSession({});
    expect(String((await unset.list()).find((x) => x.name === 'hudu_get_api_info')!.description)).not.toContain('typesense');
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
