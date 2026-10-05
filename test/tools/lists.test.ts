/**
 * lists.test.ts — the dedicated bounded list reads: fixed backing operation, one bounded page,
 * no operation redirect, and the read-edge resource policy. Pairs with `src/tools/lists.ts`.
 *
 * Hudu is stubbed at `globalThis.fetch` by the shared session harness, so every assertion is made
 * against the URL the SDK actually requested and the structured result that crossed the wire.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

/** A Hudu-shaped companies page: `{ companies: [...] }`. */
function companiesPage(n: number): Response {
  return Response.json({ companies: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Company ${i + 1}` })) });
}

/** A Hudu-shaped articles page: `{ articles: [...] }`. */
function articlesPage(n: number): Response {
  return Response.json({ articles: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Article ${i + 1}` })) });
}

/** A Hudu-shaped assets page (account-wide `GET /assets`): `{ assets: [...] }`. */
function assetsPage(n: number): Response {
  return Response.json({ assets: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Asset ${i + 1}`, company_id: 1 })) });
}

/** A Hudu-shaped asset-layouts page: `{ asset_layouts: [...] }`. */
function assetLayoutsPage(n: number): Response {
  return Response.json({
    asset_layouts: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Layout ${i + 1}`, slug: `layout-${i + 1}`, active: true })),
  });
}

describe('hudu_list_companies', () => {
  it('lists one bounded page from the fixed companies.list operation, with filters in the query', async () => {
    const session = await connect(() => companiesPage(3));
    const result = await session.call('hudu_list_companies', { page: 2, page_size: 3, search: 'acme', city: 'Sydney' });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.count).toBe(3);
    expect(result.structuredContent.rows).toHaveLength(3);
    expect(result.structuredContent.page).toBe(2);
    expect(result.structuredContent.page_size).toBe(3);
    // A full page means the SDK cannot prove there is no next page, so it says so.
    expect(result.structuredContent.has_more).toBe(true);

    // Exactly one request, and it is the list endpoint — never a second page, never another method.
    expect(session.urls).toHaveLength(1);
    const url = session.urls[0]!;
    expect(url).toContain('/companies');
    expect(url).toContain('page=2');
    expect(url).toContain('page_size=3');
    expect(url).toContain('search=acme');
    expect(url).toContain('city=Sydney');
    await session.close();
  });

  it('reports has_more=false when the answered page is not full', async () => {
    const session = await connect(() => companiesPage(2));
    const result = await session.call('hudu_list_companies', { page_size: 3 });
    expect(result.structuredContent.count).toBe(2);
    expect(result.structuredContent.has_more).toBe(false);
    await session.close();
  });

  it('returns an empty bounded page when nothing matches, without following has_more', async () => {
    const session = await connect(() => companiesPage(0));
    const result = await session.call('hudu_list_companies', {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.rows).toEqual([]);
    expect(result.structuredContent.has_more).toBe(false);
    expect(session.urls).toHaveLength(1);
    await session.close();
  });
});

describe('hudu_list_articles', () => {
  it('lists one bounded page from the fixed articles.list operation, with filters in the query', async () => {
    const session = await connect(() => articlesPage(2));
    const result = await session.call('hudu_list_articles', { page_size: 2, company_id: 7 });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.count).toBe(2);
    expect(result.structuredContent.has_more).toBe(true);
    expect(session.urls).toHaveLength(1);
    const url = session.urls[0]!;
    expect(url).toContain('/articles');
    expect(url).toContain('page_size=2');
    expect(url).toContain('company_id=7');
    expect(url).not.toContain('/companies');
    await session.close();
  });
});

describe('hudu_list_assets', () => {
  it('lists one bounded page from the fixed assets.listAcrossCompanies operation, with filters in the query', async () => {
    // The operation is page-paginated (node-hudu 0.9.2): the vendor answers the requested page, so
    // the stub returns one full page and the handler passes it through without re-windowing.
    const session = await connect(() => assetsPage(3));
    const result = await session.call('hudu_list_assets', { page: 2, page_size: 3, company_id: 5, primary_serial: 'SER-1', archived: false });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.count).toBe(3);
    expect(result.structuredContent.rows).toHaveLength(3);
    expect(result.structuredContent.page).toBe(2);
    expect(result.structuredContent.page_size).toBe(3);
    // A full page means the SDK cannot prove there is no next page, so it says so.
    expect(result.structuredContent.has_more).toBe(true);

    // Exactly one request, and it is the account-wide list endpoint — never a second page, never
    // a per-company or record path.
    expect(session.urls).toHaveLength(1);
    const url = session.urls[0]!;
    expect(url).toContain('/assets?');
    expect(url).not.toContain('/companies/');
    expect(url).toContain('page=2');
    expect(url).toContain('page_size=3');
    expect(url).toContain('company_id=5');
    expect(url).toContain('primary_serial=SER-1');
    expect(url).toContain('archived=false');
    await session.close();
  });

  it('reports has_more=false when the answered page is not full', async () => {
    const session = await connect(() => assetsPage(2));
    const result = await session.call('hudu_list_assets', { page_size: 3 });
    expect(result.structuredContent.count).toBe(2);
    expect(result.structuredContent.has_more).toBe(false);
    await session.close();
  });

  it('returns an empty bounded page when nothing matches, without following has_more', async () => {
    const session = await connect(() => assetsPage(0));
    const result = await session.call('hudu_list_assets', {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.rows).toEqual([]);
    expect(result.structuredContent.has_more).toBe(false);
    expect(session.urls).toHaveLength(1);
    await session.close();
  });

  it('walks pages by sending page to the vendor, never windowing the answer client-side', async () => {
    // A vendor that honours page/page_size over a 7-row inventory: page 3 of size 3 is row 7 only.
    const session = await connect((url) => {
      const q = new URL(url).searchParams;
      const page = Number(q.get('page'));
      const size = Number(q.get('page_size'));
      const ids = Array.from({ length: 7 }, (_, i) => i + 1).slice((page - 1) * size, page * size);
      return Response.json({ assets: ids.map((id) => ({ id, name: `Asset ${id}`, company_id: 1 })) });
    });
    const result = await session.call('hudu_list_assets', { page: 3, page_size: 3 });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.rows.map((r: { id: number }) => r.id)).toEqual([7]);
    expect(result.structuredContent.count).toBe(1);
    expect(result.structuredContent.has_more).toBe(false);
    expect(JSON.stringify(result.content[0].text)).not.toContain('client-side window');
    expect(session.urls).toHaveLength(1);
    expect(session.urls[0]).toContain('page=3');
    await session.close();
  });

  it('never returns more than page_size rows even when the remote ignores page_size', async () => {
    const session = await connect(() => assetsPage(100));
    const result = await session.call('hudu_list_assets', { page_size: 4 });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.rows).toHaveLength(4);
    expect(result.structuredContent.count).toBe(4);
    expect(result.structuredContent.has_more).toBe(true);
    expect(JSON.stringify(result.content[0].text)).toContain('truncated to the advertised bound');
    expect(session.urls).toHaveLength(1);
    await session.close();
  });
});

describe('hudu_list_asset_layouts', () => {
  it('lists one bounded page from the fixed asset_layouts.list operation, with filters in the query', async () => {
    // The vendor endpoint honours `page` but NOT `page_size`, so the SDK drops `page_size` from the
    // request and pages at the vendor's own size. The stub returns the vendor page regardless.
    const session = await connect(() => assetLayoutsPage(2));
    const result = await session.call('hudu_list_asset_layouts', { page: 2, name: 'Server', active: true });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.count).toBe(2);
    expect(result.structuredContent.rows).toHaveLength(2);
    expect(result.structuredContent.page).toBe(2);
    expect(result.structuredContent.page_size).toBe(2);

    // Exactly one request, and it is the fixed list endpoint — never a second page, never a record
    // path. The tool exposes no `page_size` at all: the vendor ignores it, and truncating here would
    // make the skipped rows unreachable as `page` advances.
    expect(session.urls).toHaveLength(1);
    const url = session.urls[0]!;
    expect(url).toContain('/asset_layouts?');
    expect(url).toContain('page=2');
    expect(url).toContain('name=Server');
    expect(url).toContain('active=true');
    expect(url).not.toContain('page_size');
    await session.close();
  });

  it('returns the vendor page whole so page N is the vendor’s Nth page, never a skipped window', async () => {
    // A vendor page larger than the other tools' default bound — and larger than the registry's
    // 100-row maximum — is returned intact: no client-side truncation, so walking `page` stays
    // contiguous and no row is silently withheld.
    const session = await connect(() => assetLayoutsPage(150));
    const result = await session.call('hudu_list_asset_layouts', {});

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.rows).toHaveLength(150);
    expect(result.structuredContent.count).toBe(150);
    expect(result.structuredContent.page_size).toBe(150);
    // Conservative: the SDK cannot prove the last page from one request.
    expect(result.structuredContent.has_more).toBe(true);
    expect(session.urls).toHaveLength(1);
    await session.close();
  });

  it('walks pages without gaps: page N is the vendor’s Nth page', async () => {
    // The vendor pages at its own size (3 here) and ignores page_size. With no caller bound, pages
    // 1..3 return rows 1-3, 4-6, 7 — contiguous, unlike a truncated client-side window.
    const session = await connect((url) => {
      const p = Number(new URL(url).searchParams.get('page') ?? '1');
      const all = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `Layout ${i + 1}` }));
      return Response.json({ asset_layouts: all.slice((p - 1) * 3, (p - 1) * 3 + 3) });
    });
    const ids = async (page: number) =>
      (await session.call('hudu_list_asset_layouts', { page })).structuredContent.rows.map((r: { id: number }) => r.id);
    expect(await ids(1)).toEqual([1, 2, 3]);
    expect(await ids(2)).toEqual([4, 5, 6]);
    expect(await ids(3)).toEqual([7]);
    await session.close();
  });

  it('returns an empty bounded page when nothing matches, without following has_more', async () => {
    const session = await connect(() => assetLayoutsPage(0));
    const result = await session.call('hudu_list_asset_layouts', {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.rows).toEqual([]);
    expect(result.structuredContent.has_more).toBe(false);
    expect(session.urls).toHaveLength(1);
    await session.close();
  });
});

describe('dispatch cannot be redirected', () => {
  it('ignores an operation selector and nested invoke input on the companies tool', async () => {
    const session = await connect(() => companiesPage(1));
    const result = await session.call('hudu_list_companies', {
      page_size: 1,
      operation: 'companies.delete',
      input: { id: 1 },
      confirm: 'companies.delete',
    });

    // The call succeeds as a plain list: the extra keys never reach the SDK call.
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.count).toBe(1);
    expect(session.urls).toHaveLength(1);
    const url = session.urls[0]!;
    expect(url).toContain('/companies?');
    // No record path (a delete/update) and no trace of the injected operation key.
    expect(/\/companies\/\d+/.test(url)).toBe(false);
    expect(url).not.toContain('delete');
    expect(url).not.toContain('operation');
    await session.close();
  });

  it('ignores an operation selector and nested invoke input on the assets tool', async () => {
    const session = await connect(() => assetsPage(1));
    const result = await session.call('hudu_list_assets', {
      page_size: 1,
      operation: 'assets.delete',
      input: { companyId: 1, id: 1 },
      confirm: 'assets.delete',
    });

    // The call succeeds as a plain list: the extra keys never reach the SDK call.
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.count).toBe(1);
    expect(session.urls).toHaveLength(1);
    const url = session.urls[0]!;
    expect(url).toContain('/assets?');
    // No record path (a delete/update) and no trace of the injected operation key.
    expect(/\/assets\/\d+/.test(url)).toBe(false);
    expect(url).not.toContain('delete');
    expect(url).not.toContain('operation');
    await session.close();
  });

  it('ignores an operation selector and nested invoke input on the asset layouts tool', async () => {
    const session = await connect(() => assetLayoutsPage(1));
    const result = await session.call('hudu_list_asset_layouts', {
      page_size: 1,
      operation: 'asset_layouts.update',
      input: { id: 1, data: { name: 'pwned' } },
      confirm: 'asset_layouts.update',
    });

    // The call succeeds as a plain list: the extra keys never reach the SDK call.
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.count).toBe(1);
    expect(session.urls).toHaveLength(1);
    const url = session.urls[0]!;
    expect(url).toContain('/asset_layouts?');
    // No record path (an update) and no trace of the injected operation key.
    expect(/\/asset_layouts\/\d+/.test(url)).toBe(false);
    expect(url).not.toContain('update');
    expect(url).not.toContain('operation');
    await session.close();
  });

  it('advertises a fixed schema: no operation/input fields and a page_size hard cap of 100', async () => {
    const session = await connect();
    const tools = await session.list();
    for (const name of ['hudu_list_companies', 'hudu_list_articles', 'hudu_list_assets']) {
      const tool = tools.find((t) => t.name === name)!;
      const props = tool.inputSchema.properties;
      expect(props.operation, name).toBeUndefined();
      expect(props.input, name).toBeUndefined();
      expect(props.opts, name).toBeUndefined();
      expect(props.page_size.maximum, name).toBe(100);
      expect(props.page_size.default, name).toBe(25);
      expect(props.page.minimum, name).toBe(1);
      expect(props.page.default, name).toBe(1);
    }
    const layouts = tools.find((t) => t.name === 'hudu_list_asset_layouts')!;
    const layoutProps = layouts.inputSchema.properties;
    expect(layoutProps.operation).toBeUndefined();
    expect(layoutProps.input).toBeUndefined();
    expect(layoutProps.opts).toBeUndefined();
    expect(layoutProps.page.minimum).toBe(1);
    expect(layoutProps.page.default).toBe(1);
    // `asset_layouts` declares no vendor text filter, so the tool must not advertise `search`; the
    // vendor ignores `page_size`, so advertising it would let a caller skip rows.
    expect(layoutProps.search).toBeUndefined();
    expect(layoutProps.page_size).toBeUndefined();
    expect(layoutProps.active).toBeDefined();
    // Clients can key an ungated link off this metadata: fixed backing op, no approval.
    expect(layouts._meta?.backingOperation).toBe('asset_layouts.list');
    expect(layouts._meta?.requiresApproval).toBe(false);
    await session.close();
  });
});

describe('read-edge resource policy', () => {
  it('refuses a resource excluded by HUDU_SEARCH_RESOURCES before any request', async () => {
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['articles'] });
    const result = await session.call('hudu_list_companies', {});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('CONFIG_ERROR');
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('serves the resource the deployment did keep', async () => {
    const session = await connect(() => articlesPage(1), { HUDU_SEARCH_RESOURCES: ['articles'] });
    const result = await session.call('hudu_list_articles', { page_size: 1 });
    expect(result.isError).toBeUndefined();
    expect(session.urls[0]).toContain('/articles');
    await session.close();
  });

  it('refuses the assets resource when HUDU_SEARCH_RESOURCES excludes it, before any request', async () => {
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['articles'] });
    const result = await session.call('hudu_list_assets', {});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('CONFIG_ERROR');
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('serves asset layouts even when HUDU_SEARCH_RESOURCES excludes every searchable resource', async () => {
    // `asset_layouts` is not searchable, so HUDU_SEARCH_RESOURCES can never name it and must not
    // gate it: the resource is already reachable through the ungated `hudu_get_asset_layout`.
    const session = await connect(() => assetLayoutsPage(1), { HUDU_SEARCH_RESOURCES: ['articles'] });
    const result = await session.call('hudu_list_asset_layouts', {});
    expect(result.isError).toBeUndefined();
    expect(session.urls[0]).toContain('/asset_layouts');
    await session.close();
  });
});

