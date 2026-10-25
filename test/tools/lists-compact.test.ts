/**
 * lists-compact.test.ts — `hudu_list` serves compact summary rows by default and full records on
 * `expand: true` (issue #22). Hudu is stubbed at `globalThis.fetch` by the shared session harness.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPACT_FIELDS } from '../../src/tools/lists.js';
import { connect } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

const bigAsset = (i: number) => ({
  id: i, name: `Asset ${i}`, company_id: 1, company_name: 'Acme', asset_layout_id: 2, primary_serial: `S${i}`, asset_type: 'Server',
  archived: false, url: `/a/${i}`, updated_at: '2026-01-01', slug: `a-${i}`, primary_mail: 'x@y', object_type: 'Asset', created_at: '2025-01-01',
  fields: Array.from({ length: 30 }, (_, f) => ({ label: `Field ${f}`, value: 'v'.repeat(120) })),
});
const assets = (n: number) => () => Response.json({ assets: Array.from({ length: n }, (_, i) => bigAsset(i + 1)) });

describe('hudu_list compact rows', () => {
  it('a default assets page of 25 rows is under 20,000 chars and drops custom fields', async () => {
    const session = await connect(assets(25));
    const result = await session.call('hudu_list', { resource: 'assets' });
    expect(result.structuredContent.rows).toHaveLength(25);
    expect(JSON.stringify(result.structuredContent).length).toBeLessThan(20_000);
    expect(result.structuredContent.rows[0]).not.toHaveProperty('fields');
    expect(result.structuredContent.rows[0]).toMatchObject({ id: 1, name: 'Asset 1', company_id: 1, primary_serial: 'S1' });
    await session.close();
  });

  it('expand: true returns the full records the old default returned', async () => {
    const session = await connect(assets(3));
    const full = await session.call('hudu_list', { resource: 'assets', expand: true });
    expect(full.structuredContent.rows[0]).toMatchObject({ ...bigAsset(1), fields: expect.any(Array), url: 'https://hudu.invalid/a/1' });
    await session.close();
  });

  it('asset_layouts compacts rows; expand returns the full row; no page_size involved', async () => {
    const row = { id: 1, name: 'L', slug: 'l', active: true, icon: 'i', color: 'c', fields: [{ label: 'x' }], include_files: true };
    const session = await connect(() => Response.json({ asset_layouts: [row] }));
    const compact = await session.call('hudu_list', { resource: 'asset_layouts' });
    expect(compact.structuredContent.rows[0]).toEqual({ id: 1, name: 'L', slug: 'l', active: true, icon: 'i', color: 'c' });
    const full = await session.call('hudu_list', { resource: 'asset_layouts', expand: true });
    expect(full.structuredContent.rows[0]).toMatchObject(row);
    await session.close();
  });
});

// Pinned explicitly: the SDK exports no runtime projection, so a node-hudu bump that changes a
// `*Summary` shape must be reviewed here by hand.
describe('COMPACT_FIELDS', () => {
  it('pins the compact field list per resource', () => {
    expect(COMPACT_FIELDS).toEqual({
      companies: ['id', 'name', 'nickname', 'slug', 'website', 'phone_number', 'city', 'state', 'id_number', 'archived', 'url', 'created_at', 'updated_at'],
      articles: ['id', 'name', 'slug', 'company_id', 'folder_id', 'draft', 'enable_sharing', 'url', 'created_at', 'updated_at'],
      assets: ['id', 'name', 'company_id', 'company_name', 'asset_layout_id', 'primary_serial', 'asset_type', 'archived', 'url', 'created_at', 'updated_at'],
      asset_layouts: ['id', 'name', 'slug', 'active', 'icon', 'color', 'url', 'created_at', 'updated_at'],
    });
  });
});
