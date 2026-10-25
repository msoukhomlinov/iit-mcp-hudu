/**
 * search-prose.test.ts — the `hudu_search` help text and advertised description rewritten by the
 * deployment search policy. Pairs with `src/tools/search-prose.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, connectForRequest } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

describe('hudu_search help prose', () => {
  it('does not state a default the narrowed policy refuses', async () => {
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['articles'] });
    const result = await session.call('hudu_search', { mode: 'help' });
    const text: string = result.structuredContent.help.text;
    // The SDK's limits section hard-codes both defaults; on a narrowed deployment it must not.
    expect(text).not.toContain('default ["articles","assets"].');
    expect(text).toContain('default ["articles"].');
    expect(text).not.toContain('tool default "index"');
    expect(text).toContain('tool default "vendor"');
    await session.close();
  });

  it('leaves the SDK prose untouched when the policy changes no default', async () => {
    const session = await connect();
    const result = await session.call('hudu_search', { mode: 'help' });
    const text: string = result.structuredContent.help.text;
    expect(text).toContain('default ["articles","assets"].');
    expect(text).toContain('tool default "index" (complete answer); "auto" = the SDK default.');
    await session.close();
  });

  it('drops every excluded resource and tier from the full help text', async () => {
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['companies'] });
    const result = await session.call('hudu_search', { mode: 'help', topic: 'all' });
    const text: string = result.structuredContent.help.text;
    // `modes`/`degradation` describe an article-body index and `followup` names the credential
    // resources; a companies-only deployment has neither.
    expect(text).not.toContain('article bodies');
    expect(text).not.toContain('article BODIES');
    expect(text).not.toContain('asset_passwords');
    expect(text).not.toContain('password_folders');
    expect(text).not.toContain('tool default "index"');
    expect(text).toContain('companies');
    await session.close();
  });

  it('policy-adjusts the structured modes summaries, not just the text', async () => {
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['companies'] });
    const result = await session.call('hudu_search', { mode: 'help' });
    const modes = result.structuredContent.help.modes as Array<{ mode: string; summary: string }>;
    const search = modes.find((m) => m.mode === 'search')!;
    // `help.modes[0].summary` repeats the SDK `modes` sentence verbatim, so it needs the same rewrite.
    expect(search.summary).not.toContain('article bodies');
    expect(search.summary).toContain('companies');
    expect(modes.find((m) => m.mode === 'help')!.summary).toContain('how to use this tool: defaults, limits');
    await session.close();
  });

  it('keeps the body-index prose while articles and assets remain searchable', async () => {
    // Both defaults change (asset_passwords/password_folders are gone) but the body index still runs,
    // so the article-body and "index" sentences stay verbatim.
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['articles', 'assets'] });
    const result = await session.call('hudu_search', { mode: 'help', topic: 'all' });
    const text: string = result.structuredContent.help.text;
    expect(text).toContain('article bodies');
    expect(text).toContain('article BODIES');
    expect(text).toContain('tool default "index" (complete answer); "auto" = the SDK default.');
    expect(text).not.toContain('asset_passwords');
    expect(text).not.toContain('password_folders');
    await session.close();
  });

  it('carries the block-HTML passthrough rule on the on-demand help surface', async () => {
    // The compact tool descriptions no longer carry it (PR #52), so help is where a caller learns
    // that a body opening with block HTML is sent as HTML rather than parsed as Markdown.
    const session = await connect();
    const result = await session.call('hudu_search', { mode: 'help' });
    const text: string = result.structuredContent.help.text;
    expect(text).toContain('ARTICLE FORMAT');
    expect(text).toContain('is sent as HTML instead of being parsed as Markdown');
    expect(text).toContain('articles.get');
    await session.close();
  });

  it('names only the credential resources that remain searchable', async () => {
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['articles', 'assets', 'asset_passwords'] });
    const result = await session.call('hudu_search', { mode: 'help', topic: 'followup' });
    const text: string = result.structuredContent.help.text;
    expect(text).toContain('asset_passwords hits are redacted');
    expect(text).not.toContain('password_folders');
    await session.close();
  });

  it('leaves the structured modes and followup verbatim when the policy changes nothing', async () => {
    const session = await connect();
    const result = await session.call('hudu_search', { mode: 'help' });
    const modes = result.structuredContent.help.modes as Array<{ mode: string; summary: string }>;
    expect(modes.find((m) => m.mode === 'search')!.summary).toContain('article bodies');
    expect(result.structuredContent.help.text).toContain('asset_passwords / password_folders hits are redacted');
    await session.close();
  });

  it('does not promise snippets when every searchable resource redacts them', async () => {
    // A credential-only scope (valid, though narrow) returns no snippets at all, so "snippet-bearing"
    // would advertise evidence the deployment can never return.
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['asset_passwords', 'password_folders'] });
    const result = await session.call('hudu_search', { mode: 'help' });
    const text: string = result.structuredContent.help.text;
    expect(text).not.toContain('snippet-bearing');
    expect(text).toContain('snippets suppressed');
    const modes = result.structuredContent.help.modes as Array<{ mode: string; summary: string }>;
    expect(modes.find((m) => m.mode === 'search')!.summary).not.toContain('snippet-bearing');
    await session.close();
  });

  it('stops promising a dropped count in the query-section prose', async () => {
    // The SDK's query section promised "min_score ... reports how many it dropped": the engine's
    // minScore paths are a plain `continue` with no counter, so the promise is false on every
    // deployment, full set included - the correction lands even where the policy changes nothing.
    const session = await connect();
    const result = await session.call('hudu_search', { mode: 'help', topic: 'query' });
    const text: string = result.structuredContent.help.text;
    expect(text).not.toContain('reports how many it dropped');
    expect(text).not.toContain('never looks like absence');
    expect(text).toContain('reports NO count of them');
    expect(text).toContain('meta.scanned');
    // scanned > 0 with returned 0 is the floor OR the company_id/updated_since/scope filters - the
    // prose must not name the floor as the only cause.
    expect(text).not.toContain('none passed the floor');
    expect(text).toContain('company_id');
    expect(text).toContain('updated_since');
    await session.close();
  });
});

describe('hudu_search advertised description', () => {
  it('stops advertising resources and an index default the narrowed policy refuses', async () => {
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['companies'] });
    const tool = (await session.list()).find((t) => t.name === 'hudu_search');
    expect(tool!.description).not.toContain('article TITLE and BODY');
    expect(tool!.description).toContain('companies');
    expect(tool!.description).not.toContain('defaults to tier "index"');
    expect(tool!.description).toContain('defaults to tier "vendor"');
    expect(tool!.inputSchema.properties.query.description).not.toContain('article BODY is searched');
    await session.close();
  });

  it('keeps the SDK description verbatim when the policy changes nothing', async () => {
    const session = await connect();
    const tool = (await session.list()).find((t) => t.name === 'hudu_search');
    expect(tool!.description).toContain('article TITLE and BODY');
    expect(tool!.description).toContain('defaults to tier "index"');
    expect(tool!.inputSchema.properties.query.description).toContain('article BODY is searched');
    await session.close();
  });

  it('keeps the query field short and sends per-resource matching rules to help topic query', async () => {
    const session = await connect();
    const query = (await session.list()).find((t) => t.name === 'hudu_search')!.inputSchema.properties.query.description;
    expect(query).toContain('topic="query" (mode="help")');
    expect(query).not.toContain('reordering words');
    expect(query).not.toContain('meta.matching');
    expect(query.length).toBeLessThan(500);
    await session.close();
  });

  it('compares membership, not length, so a duplicate cannot mask an omitted resource', async () => {
    // Eight raw entries with a duplicate and no password_folders: length matches the SDK set, but
    // the effective set does not. The description must not advertise the omitted resource.
    const session = await connect(undefined, {
      HUDU_SEARCH_RESOURCES: ['articles', 'articles', 'assets', 'companies', 'users', 'groups', 'websites', 'asset_passwords'],
    });
    const tool = (await session.list()).find((t) => t.name === 'hudu_search');
    expect(tool!.description).not.toContain('article TITLE and BODY');
    expect(tool!.description).not.toContain('password_folders');
    expect(tool!.inputSchema.properties.resources.items.enum).not.toContain('password_folders');
    await session.close();
  });
});

describe('HUDU_SEARCH_TIER_POLICY=vendor under stdio', () => {
  it('describes the vendor tier in the description, the tier field and the help text', async () => {
    const session = await connect(undefined, { HUDU_SEARCH_TIER_POLICY: 'vendor' });
    const tool = (await session.list()).find((t) => t.name === 'hudu_search')!;
    expect(tool.description).toContain('defaults to tier "vendor"');
    expect(tool.description).toContain('HUDU_SEARCH_TIER_POLICY');
    expect(tool.description).not.toContain('defaults to tier "index"');
    // Under stdio the caller keeps the field, so the field description must name the vendor default.
    const tier = tool.inputSchema.properties.tier;
    expect(tier.description).toContain('Defaults to "vendor"');
    expect(tier.description).not.toContain('Defaults to "index"');
    const help = await session.call('hudu_search', { mode: 'help' });
    const text: string = help.structuredContent.help.text;
    expect(text).toContain('tool default "vendor"');
    expect(text).not.toContain('tool default "index"');
    expect(help.structuredContent.help.defaults.tier).toBe('vendor');
    await session.close();
  });

  it('describes "auto" when the policy sets it', async () => {
    const session = await connect(undefined, { HUDU_SEARCH_TIER_POLICY: 'auto' });
    const tool = (await session.list()).find((t) => t.name === 'hudu_search')!;
    expect(tool.description).toContain('defaults to tier "auto"');
    expect(tool.inputSchema.properties.tier.description).toContain('Defaults to "auto"');
    const help = await session.call('hudu_search', { mode: 'help' });
    expect(help.structuredContent.help.text).toContain('tool default "auto"');
    expect(help.structuredContent.help.defaults.tier).toBe('auto');
    await session.close();
  });

  it('keeps the "index" prose when the policy sets it', async () => {
    const session = await connect(undefined, { HUDU_SEARCH_TIER_POLICY: 'index' });
    const tool = (await session.list()).find((t) => t.name === 'hudu_search')!;
    expect(tool.description).toContain('defaults to tier "index"');
    expect(tool.inputSchema.properties.tier.description).toContain('Defaults to "index"');
    const help = await session.call('hudu_search', { mode: 'help' });
    expect(help.structuredContent.help.text).toContain('tool default "index" (complete answer); "auto" = the SDK default.');
    expect(help.structuredContent.help.defaults.tier).toBe('index');
    await session.close();
  });
});

describe('http with an excluded corpus', () => {
  it('names the served tier policy instead of refused fields the schema never offers', async () => {
    // No tier field is served over http, so a corpus refusal that names "index", "auto" and refresh
    // would describe a schema this caller never sees — and claim refusals that cannot happen.
    const session = await connectForRequest('key-a', () => Response.json([]), [], { HUDU_SEARCH_RESOURCES: ['companies'] });
    const tool = (await session.list()).find((t) => t.name === 'hudu_search')!;
    expect(tool.inputSchema.properties).not.toHaveProperty('tier');
    expect(tool.description).toContain('set server-side');
    expect(tool.description).not.toContain('refuses "index", "auto" and refresh');
    const help = await session.call('hudu_search', { mode: 'help' });
    const text: string = help.structuredContent.help.text;
    expect(text).toContain("this deployment's policy");
    expect(text).not.toContain('"auto" and refresh are refused');
    expect(help.structuredContent.help.defaults.tier).toBe('vendor');
    await session.close();
  });
});
