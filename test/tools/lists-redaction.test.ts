import { afterEach, describe, expect, it, vi } from 'vitest';
const REDACTED_FIELD_VALUE = '[REDACTED]';
import { connect } from '../helpers/mcp-session.js';
afterEach(() => vi.unstubAllGlobals());

/** Distinctive enough that a leak into any response or log is unmistakable. */
const SECRET_PROBE = 'hudu-list-assets-secret-probe';

const ASSET_LAYOUT = {
  id: 7,
  name: 'Server',
  fields: [
    { id: 70, label: 'Admin PW', field_type: 'Password' },
    { id: 72, label: 'Hostname', field_type: 'Text' },
  ],
};

/** The API model's asset row: `fields[]` entries carry `{ id, label, value, position }`, no type. */
const ASSET_WITH_FIELDS = {
  id: 5,
  company_id: 1,
  asset_layout_id: 7,
  name: 'srv-01',
  fields: [
    { id: 500, label: 'Admin PW', value: SECRET_PROBE, position: 1 },
    { id: 502, label: 'Hostname', value: 'srv-01.example', position: 2 },
  ],
};

/** Stand-in Hudu: one account-wide asset with confidential fields, plus its layout. */
function assetsWithSecret(layoutStatus = 200) {
  return (url: string): Response => {
    const path = new URL(url).pathname.replace('/api/v1/', '');
    if (path === 'asset_layouts/7') {
      return layoutStatus === 200
        ? Response.json({ asset_layout: ASSET_LAYOUT })
        : Response.json({ error: 'nope' }, { status: layoutStatus });
    }
    if (path === 'assets') return Response.json({ assets: [ASSET_WITH_FIELDS] });
    return Response.json({ [path.split('/').pop()!]: [] });
  };
}

describe('hudu_list_assets secret-read policy', () => {
  it('redacts Password/ConfidentialText field values under HUDU_SECRET_READS=deny', async () => {
    const session = await connect(assetsWithSecret());
    const result = await session.call('hudu_list_assets', { page_size: 3 });

    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(SECRET_PROBE);
    const fields = result.structuredContent.rows[0].fields;
    expect(fields.map((f: { value: string }) => f.value)).toEqual([REDACTED_FIELD_VALUE, REDACTED_FIELD_VALUE]);
    // SDK masking requires no extra layout request.
    expect(session.urls.filter((u) => u.includes('/asset_layouts/')).length).toBe(0);
    await session.close();
  });

  it('fails closed when the layout cannot be read', async () => {
    const session = await connect(assetsWithSecret(500));
    const result = await session.call('hudu_list_assets', { page_size: 3 });

    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(SECRET_PROBE);
    expect(result.structuredContent.rows[0].fields[0].value).toBe(REDACTED_FIELD_VALUE);
    await session.close();
  });

  it('keeps SDK masking under HUDU_SECRET_READS=allow', async () => {
    const session = await connect(assetsWithSecret(), { HUDU_SECRET_READS: 'allow' });
    const result = await session.call('hudu_list_assets', { page_size: 3 });

    expect(result.structuredContent.rows[0].fields[0].value).toBe(REDACTED_FIELD_VALUE);
    await session.close();
  });
});

const SECRET_PAGE_1 = 'hudu-list-assets-page1-secret';
const SECRET_PAGE_2 = 'hudu-list-assets-page2-secret';

const LAYOUT_A = { id: 7, name: 'Server', fields: [{ id: 70, label: 'Admin PW', field_type: 'Password' }] };
const LAYOUT_B = { id: 8, name: 'Application', fields: [{ id: 80, label: 'License Key', field_type: 'ConfidentialText' }] };

/** One full asset row on a chosen layout, carrying a confidential value the layout declares. */
function assetRow(id: number, layoutId: number, label: string, value: string) {
  return { id, company_id: 1, asset_layout_id: layoutId, name: `asset-${id}`, fields: [{ id: id * 100, label, value, position: 1 }] };
}

/**
 * Stand-in Hudu (honouring `page` / `page_size`) whose account-wide list spans two layouts: page-1 assets (ids 1-2) use layout 7,
 * page-2 assets (ids 3-4) use layout 8. Records every layout GET so the test can prove which pages'
 * layouts the handler spent a request on.
 */
function assetsAcrossLayouts() {
  const assets = [
    assetRow(1, 7, 'Admin PW', SECRET_PAGE_1),
    assetRow(2, 7, 'Admin PW', SECRET_PAGE_1),
    assetRow(3, 8, 'License Key', SECRET_PAGE_2),
    assetRow(4, 8, 'License Key', SECRET_PAGE_2),
  ];
  return (url: string): Response => {
    const path = new URL(url).pathname.replace('/api/v1/', '');
    if (path === 'asset_layouts/7') return Response.json({ asset_layout: LAYOUT_A });
    if (path === 'asset_layouts/8') return Response.json({ asset_layout: LAYOUT_B });
    if (path === 'assets') {
      const q = new URL(url).searchParams;
      const page = Number(q.get('page') ?? 1);
      const size = Number(q.get('page_size') ?? assets.length);
      return Response.json({ assets: assets.slice((page - 1) * size, page * size) });
    }
    return Response.json({ [path.split('/').pop()!]: [] });
  };
}

describe('hudu_list_assets redacts the bounded page, not the whole response', () => {
  it('reads only the requested page\u2019s layouts when the account-wide response spans layouts', async () => {
    const session = await connect(assetsAcrossLayouts());
    const result = await session.call('hudu_list_assets', { page: 2, page_size: 2 });

    expect(result.isError).toBeUndefined();
    // Page 2 is assets 3-4, not a repeat of page 1.
    expect(result.structuredContent.rows.map((r: { id: number }) => r.id)).toEqual([3, 4]);
    // A full vendor page cannot prove the last page, so has_more stays true.
    expect(result.structuredContent.has_more).toBe(true);
    // The page-2 values are present and redacted.
    expect(JSON.stringify(result)).not.toContain(SECRET_PAGE_2);
    expect(result.structuredContent.rows[0].fields[0].value).toBe(REDACTED_FIELD_VALUE);
    // No layout fan-out: unclassified values are masked by the SDK.
    expect(session.urls.filter((u) => u.includes('/asset_layouts/8')).length).toBe(0);
    expect(session.urls.some((u) => u.includes('/asset_layouts/7'))).toBe(false);
    await session.close();
  });
});