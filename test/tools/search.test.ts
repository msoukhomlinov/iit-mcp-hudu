/**
 * search.test.ts — `hudu_search`: resource policy and the thrown-auth-failure path. Pairs with
 * `src/tools/search.ts`; the help/description prose cases live in `search-prose.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_HELP } from 'node-hudu/mcp';
import { connect, connectForRequest } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

describe('hudu_search resource policy', () => {
  it('advertises exactly the resources the deployment declared, not the whole SDK set', async () => {
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['articles', 'assets', 'companies'] });
    const tool = (await session.list()).find((t) => t.name === 'hudu_search');
    expect(tool!.inputSchema.properties.resources.items.enum).toEqual(['articles', 'assets', 'companies']);
    await session.close();
  });

  it('refuses a resource the deployment excluded, before any request', async () => {
    // The credential cannot read asset_passwords, so the deployment removed it. A model asking for
    // it must be refused without a Hudu request — the alternative is the leaked auth error.
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['articles', 'assets'] });
    const result = await session.call('hudu_search', { mode: 'search', query: 'reset', resources: ['asset_passwords'] });
    expect(result.isError).toBe(true);
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('reports the effective set and names what policy excluded', async () => {
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['articles', 'assets'] });
    const result = await session.call('hudu_search', { mode: 'resources' });
    expect(result.structuredContent.resources.count).toBe(2);
    expect(result.structuredContent.resources.excludedByPolicy).toContain('asset_passwords');
    await session.close();
  });

  it('answers a fully-refused search scope with the clean UNAUTHORIZED 401, not a sanitized 0-match', async () => {
    // Hudu answers 401 "Bad credentials" for a key it refuses. When the scope the
    // caller asked for is refused in full, the call is a credential failure — the same clean
    // UNAUTHORIZED 401 every other tool answers — never a 0-match success or a scope leak.
    const session = await connect((url) =>
      url.includes('/asset_passwords')
        ? new Response(JSON.stringify({ error: 'Bad credentials' }), { status: 401, headers: { 'content-type': 'application/json' } })
        : Response.json([]),
    );
    const result = await session.call('hudu_search', {
      mode: 'search',
      query: 'reset',
      resources: ['asset_passwords'],
      tier: 'vendor',
      limit: 1,
      snippetChars: 0,
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ error: true, code: 'UNAUTHORIZED', httpStatus: 401, message: 'Bad credentials' });
    await session.close();
  });

  it('keeps a per-resource auth failure sanitized when another resource answered', async () => {
    // The corner that stays: the key WORKS for the rest of the scope, so the call is a
    // real partial answer and the refused resource is collapsed to UNAVAILABLE — the upstream
    // detail (which names the missing scope) never reaches the model.
    const session = await connect((url) =>
      url.includes('/asset_passwords')
        ? new Response(JSON.stringify({ error: 'Bad credentials' }), { status: 401, headers: { 'content-type': 'application/json' } })
        : Response.json([]),
    );
    const result = await session.call('hudu_search', {
      mode: 'search',
      query: 'reset',
      resources: ['articles', 'asset_passwords'],
      tier: 'vendor',
      limit: 1,
      snippetChars: 0,
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('Bad credentials');
    expect(JSON.stringify(result)).not.toContain('UNAUTHORIZED');
    expect(result.structuredContent.meta.failed).toEqual([
      { resource: 'asset_passwords', code: 'UNAVAILABLE', message: 'Resource unavailable to this deployment; it returned no results.' },
    ]);
    await session.close();
  });

  it('does not query an excluded resource when the caller omits resources', async () => {
    // The SDK default scope is articles+assets. A deployment that dropped assets must not have the
    // omitted-argument path quietly reach for it — that is the same guaranteed-empty search.
    const session = await connect(() => Response.json([]), { HUDU_SEARCH_RESOURCES: ['articles'] });
    const result = await session.call('hudu_search', { mode: 'search', query: 'reset', limit: 1, snippetChars: 0 });
    expect(result.isError).toBeUndefined();
    expect(session.urls.some((u) => u.includes('/articles'))).toBe(true);
    expect(session.urls.some((u) => u.includes('/assets'))).toBe(false);
    await session.close();
  });

  it('refuses an explicit index tier when the corpus is not fully permitted', async () => {
    // The index walk is corpus-wide, so it would touch the excluded resource. Refuse rather than
    // silently downgrade (the tool never silently ignores a field).
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['articles'] });
    for (const args of [
      { mode: 'search', query: 'reset', resources: ['articles'], tier: 'index' },
      // "auto" starts a background warm on a cold index, and refresh forces a full rebuild.
      { mode: 'search', query: 'reset', resources: ['articles'], tier: 'auto' },
      { mode: 'search', query: 'reset', resources: ['articles'], refresh: true },
    ]) {
      const result = await session.call('hudu_search', args as Record<string, unknown>);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(JSON.parse(result.content[0].text).code).toBe('CONFIG_ERROR');
    }
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('reports policy-adjusted defaults in help', async () => {
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['companies'] });
    // `topic: "limits"` is a section name; the default "core" composite is broken independently
    // (tracked separately) and is not what this assertion is about.
    const result = await session.call('hudu_search', { mode: 'help', topic: 'limits' });
    expect(result.structuredContent.help.defaults).toEqual({
      mode: 'search',
      tier: 'vendor',
      limit: 8,
      snippetChars: 200,
      resources: ['companies'],
    });
    await session.close();
  });
});

describe('hudu_search credential refusal', () => {
  const hudu401 = () =>
    new Response(JSON.stringify({ error: 'Bad credentials' }), { status: 401, headers: { 'content-type': 'application/json' } });
  const ENVELOPE = { error: true, code: 'UNAUTHORIZED', httpStatus: 401, message: 'Bad credentials' };

  it('answers a key Hudu refuses at the default tier with the clean UNAUTHORIZED 401', async () => {
    // Step 2 of the issue: the engine isolates per-resource failures, so a refused key used to
    // arrive as a fully successful "0 matches DEGRADED" answer. It is now the same clean 401
    // every other tool answers.
    const session = await connectForRequest('bad-key-000', () => hudu401());
    const result = await session.call('hudu_search', { mode: 'search', query: 'reset', limit: 1, snippetChars: 0 });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual(ENVELOPE);
    await session.close();
  });

  it('answers a refused key the same way at the vendor tier', async () => {
    const session = await connectForRequest('bad-key-000', () => hudu401());
    const result = await session.call('hudu_search', { mode: 'search', query: 'reset', tier: 'vendor', limit: 1, snippetChars: 0 });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual(ENVELOPE);
    await session.close();
  });

  it('answers a refused key at the index tier with UNAUTHORIZED, not UNAVAILABLE', async () => {
    // Step 3 of the issue: the index walk 401s before any per-resource `meta.failed` exists, so
    // the refusal arrives as a THROWN UnauthorizedError. It used to be laundered into a
    // "backend unavailable" UNAVAILABLE — the backend is fine, the credential is the problem.
    const session = await connectForRequest('bad-key-000', () => hudu401());
    const result = await session.call('hudu_search', { mode: 'search', query: 'reset', tier: 'index', limit: 1, snippetChars: 0 });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual(ENVELOPE);
    await session.close();
  });

  it('answers a refused key thrown by the index walk in stdio mode the same way', async () => {
    // The stdio harness: one server-held credential, default tier "index", so a refused key
    // throws out of the walk rather than degrading the vendor tier.
    const session = await connect(() => hudu401());
    const result = await session.call('hudu_search', { mode: 'search', query: 'reset', limit: 1, snippetChars: 0 });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual(ENVELOPE);
    await session.close();
  });

  it('still answers a valid key with the honest 0-match degraded result', async () => {
    // Regression guard: a key that Hudu accepts and a corpus with no match must keep the honest
    // empty-but-degraded answer — the fix must not turn a real 0-match into a credential error.
    const session = await connectForRequest('valid-key-000', () => Response.json([]));
    const result = await session.call('hudu_search', { mode: 'search', query: 'reset', limit: 1, snippetChars: 0 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.hits).toEqual([]);
    expect(result.structuredContent.meta.failed).toEqual([]);
    expect(result.structuredContent.meta.degraded).toMatchObject({ reason: 'body-not-indexed' });
    expect(result.content[0]!.text).toContain('Found 0 ranked match(es)');
    await session.close();
  });

  it('fails a key-less search closed before any request, unchanged by the fix', async () => {
    // The keyless fail-closed path is fenced: no request is ever issued for the credential-less
    // parent. The search keeps its current shape (a per-resource AUTH_ERROR note in meta, no
    // upstream 401 occurred) — pinning it here so the fix cannot drift it.
    const session = await connectForRequest(undefined, () => {
      throw new Error('no Hudu request may be issued without a key');
    });
    const result = await session.call('hudu_search', { mode: 'search', query: 'reset', limit: 1, snippetChars: 0 });
    expect(session.urls).toEqual([]);
    const failed = result.structuredContent.meta.failed as Array<{ resource: string; code: string }>;
    // The vendor fan-out always records both scope resources; the background index entry joins
    // when its walk has rejected by the time the answer is built.
    expect(failed.map((f) => f.resource)).toEqual(expect.arrayContaining(['articles', 'assets']));
    for (const entry of failed) expect(entry.code).toBe('AUTH_ERROR');
    await session.close();
  });
});

describe('hudu_search help', () => {
  it('serves the default "core" topic, the "all" composite and every section', async () => {
    // "core" is SEARCH_HELP.default but it is a composite, not a section name, so validating the
    // topic against SEARCH_HELP.sections rejected the tool's own documented default.
    const session = await connect();
    const defaulted = await session.call('hudu_search', { mode: 'help' });
    expect(defaulted.isError).toBeUndefined();
    expect(defaulted.structuredContent.topic).toBe('core');
    expect(defaulted.structuredContent.help.sections).toEqual(['modes', 'limits', 'degradation', 'results', 'followup']);

    const all = await session.call('hudu_search', { mode: 'help', topic: 'all' });
    expect(all.isError).toBeUndefined();
    expect(all.structuredContent.help.sections).toEqual(['modes', 'limits', 'degradation', 'results', 'followup', 'query', 'scoring']);

    // "modes" is a section the topic enum omitted.
    const modes = await session.call('hudu_search', { mode: 'help', topic: 'modes' });
    expect(modes.isError).toBeUndefined();
    expect(modes.structuredContent.help.sections).toEqual(['modes']);
    await session.close();
  });

  it('carries the full section prose in the text channel, not a one-line stub', async () => {
    // The LLM client reads the text channel first, and before the fix it held only
    // `hudu_search help (<topics>).` while the prose sat in structuredContent.help.text.
    // Assert against the SDK catalog exactly as the server does (SEARCH_HELP.text), not a copy.
    const sectionTexts = SEARCH_HELP.text as Record<string, string>;
    const session = await connect();
    for (const topic of SEARCH_HELP.sections) {
      const result = await session.call('hudu_search', { mode: 'help', topic });
      expect(result.isError, topic).toBeUndefined();
      const inner = JSON.parse(result.content[0]!.text);
      expect(inner.trust, topic).toBe('untrusted_data');
      expect(inner.text, topic).toBe(result.structuredContent.help.text);
      expect(inner.text, topic).not.toBe(`hudu_search help (${topic}).`);
      // A distinctive phrase of the section's real prose: its own SDK header line.
      expect(inner.text, topic).toContain(sectionTexts[topic]!.split('\n')[0]);
      expect(inner.text.length, topic).toBeGreaterThan(100);
    }
    await session.close();
  });

  it('joins every section into the "all" composite text channel', async () => {
    const sectionTexts = SEARCH_HELP.text as Record<string, string>;
    const session = await connect();
    const all = await session.call('hudu_search', { mode: 'help', topic: 'all' });
    expect(all.isError).toBeUndefined();
    expect(all.structuredContent.help.sections).toEqual(SEARCH_HELP.sections);
    const inner = JSON.parse(all.content[0]!.text);
    expect(inner.text).toBe(all.structuredContent.help.text);
    for (const section of SEARCH_HELP.sections) {
      expect(inner.text, section).toContain(sectionTexts[section]!.split('\n')[0]);
    }
    await session.close();
  });

  it('refuses an unknown topic by naming the valid ones', async () => {
    // The zod topic enum (HELP_TOPICS in schemas.ts) rejects before the handler's CONFIG_ERROR
    // recheck can fire, so the refusal is a validation error that still names every valid topic.
    const session = await connect();
    const result = await session.call('hudu_search', { mode: 'help', topic: 'bogus' });
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toContain('expected one of');
    for (const topic of [...SEARCH_HELP.sections, 'core', 'all']) {
      expect(text).toContain(`"${topic}"`);
    }
    await session.close();
  });
});

describe('hudu_search min_score threshold-empty', () => {
  // The live defect (night-1 case N1-10, .run-squad/night-1/cases/diag_min100.json): "Workstation"
  // (2 real hits) + min_score:100 answered 0 hits, complete:true, reasons:[] with NO dropped count
  // anywhere - byte-indistinguishable from a query that matches nothing. The stub serves the index
  // walk (list pages) and the vendor search so the index is warm, exactly as in the live diag; the
  // search stub is query-aware so a genuinely absent query stays absent.
  const workstation = (id: number, name: string): Record<string, unknown> => ({
    id,
    name,
    slug: `ws-${id}`,
    company_id: 20,
    content: `# ${name} Workstation maintenance notes.`,
  });
  const HITS = [workstation(19, 'AUPOST-WS012 Workstation Summary'), workstation(18, 'AUPOST-WS013 Workstation Summary')];
  const hudu = (url: string): Response => {
    const u = new URL(url);
    if (u.pathname.includes('/articles')) {
      const searching = u.searchParams.has('search');
      const page = Number(u.searchParams.get('page') ?? '1');
      if (!searching) return page === 1 ? Response.json({ articles: HITS }) : Response.json({ articles: [] });
      return (u.searchParams.get('search') ?? '').toLowerCase().includes('workstation')
        ? Response.json({ articles: HITS })
        : Response.json({ articles: [] });
    }
    return Response.json({ assets: [] });
  };

  it('answers the floor-emptied search with the honest threshold-empty, pinned to the live shape', async () => {
    const session = await connect(hudu);
    const result = await session.call('hudu_search', {
      mode: 'search',
      query: 'Workstation',
      min_score: 100,
      limit: 8,
      snippetChars: 0,
    });
    expect(result.isError).toBeUndefined();
    const meta = result.structuredContent.meta as Record<string, unknown>;
    expect(result.structuredContent.hits).toEqual([]);
    expect(meta.complete).toBe(true);
    expect(meta.reasons).toEqual([]);
    expect(meta.degraded).toBeNull();
    // The defect pinned: NO dropped count anywhere in the answer - the engine's minScore paths are
    // a plain `continue` with no counter (node-hudu engine.ts), and no meta field carries one.
    expect(JSON.stringify(result)).not.toMatch(/"dropped/);
    expect(meta).not.toHaveProperty('droppedByMinScore');
    expect(meta).not.toHaveProperty('droppedBelowThreshold');
    // ...and the honest signal IS there (the live shape): 4 candidates were scored, 0 returned.
    expect(meta.scanned).toBe(4);
    expect(meta.returned).toBe(0);
    expect(JSON.parse(result.content[0]!.text).text).toBe('Found 0 ranked match(es).');
    await session.close();
  });

  it('scores the same candidates without the floor, so the floor - not absence - is the cause', async () => {
    const session = await connect(hudu);
    const floored = await session.call('hudu_search', {
      mode: 'search', query: 'Workstation', min_score: 100, limit: 8, snippetChars: 0,
    });
    const unfloored = await session.call('hudu_search', {
      mode: 'search', query: 'Workstation', limit: 8, snippetChars: 0,
    });
    expect(unfloored.structuredContent.hits.length).toBe(2);
    const fm = floored.structuredContent.meta as Record<string, unknown>;
    const um = unfloored.structuredContent.meta as Record<string, unknown>;
    expect(um.returned).toBe(2);
    // The same 4 candidates were scored in both calls; only the floor changed the outcome.
    expect(fm.scanned).toBe(um.scanned);
    await session.close();
  });

  it('keeps the absence-empty distinct: a query that matches nothing scores 0 candidates', async () => {
    const session = await connect(hudu);
    const absent = await session.call('hudu_search', {
      mode: 'search', query: 'Microsoft', limit: 8, snippetChars: 0,
    });
    expect(absent.structuredContent.hits).toEqual([]);
    const meta = absent.structuredContent.meta as Record<string, unknown>;
    // The live contrast shape (N1-10.json): scanned 0, returned 0 - threshold-empty is scanned > 0.
    expect(meta.scanned).toBe(0);
    expect(meta.returned).toBe(0);
    expect(meta.complete).toBe(true);
    expect(meta.reasons).toEqual([]);
    await session.close();
  });

  it('stops promising a dropped count in the schema and documents the honest signal', async () => {
    const session = await connect(hudu);
    const tool = (await session.list()).find((t) => t.name === 'hudu_search')!;
    const minScore: string = tool.inputSchema.properties.min_score.description;
    expect(minScore).not.toContain('dropped hits are counted');
    expect(minScore).not.toContain('never looks like absence');
    expect(minScore).toContain('meta.scanned');
    expect(minScore).toContain('meta.returned');
    // The floor is NOT the only cause of a threshold-empty: scanned - returned also counts the hits
    // the company_id, updated_since and scope filters exclude.
    expect(minScore).not.toContain('none passed the floor');
    expect(minScore).toContain('company_id');
    expect(minScore).toContain('updated_since');
    await session.close();
  });
});
