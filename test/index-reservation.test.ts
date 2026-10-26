/** The per-resource document caps reach the SDK and change what survives a build (node-hudu 0.21.0). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HuduClient } from 'node-hudu';
import { indexDocCaps } from '../src/search-budget.js';

const MiB = 1024 * 1024;

const articles = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: 1000 + i,
    name: `Article ${i}`,
    content: `<p>password reset steps ${i}</p>`,
    updated_at: '2026-05-01T00:00:00Z',
    created_at: '2024-01-01T00:00:00Z',
    company_id: 1,
  }));

/** Assets are NEWER than every article, which is what starves articles without a reservation. */
const assets = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: 5000 + i,
    name: `Asset ${i}`,
    asset_layout_id: 1,
    updated_at: '2026-06-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
  }));

function stubCorpus(articleRows: unknown[], assetRows: unknown[]): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const key = new URL(String(input)).pathname.replace(/^\/api\/v1\//, '').split('/')[0];
    const rows = key === 'articles' ? articleRows : key === 'assets' ? assetRows : [];
    return new Response(JSON.stringify({ [key]: rows, pagination: { totalPages: 1, totalRecords: rows.length, currentPage: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

async function build(maxDocs: number): Promise<{ articles: { indexed: number; capped?: number }; assets: { indexed: number; capped?: number } }> {
  const client = new HuduClient({
    baseUrl: 'https://hudu.example.com',
    apiKey: 'not-a-real-key',
    search: { maxIndexTextBytes: 4 * MiB, maxDocs, maxDocsByResource: indexDocCaps(maxDocs) },
  });
  const result = (await client.operations.searchKnowledge('password reset', { tier: 'index', limit: 1 })) as {
    meta: { index: { docs: Record<string, { indexed: number; capped?: number }> } };
  };
  return { articles: result.meta.index.docs.articles!, assets: result.meta.index.docs.assets! };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the per-resource caps the server sends', () => {
  it('keeps every article and gives the rest of the cap to assets', async () => {
    stubCorpus(articles(10), assets(500));
    const docs = await build(100);
    expect(docs.articles.indexed).toBe(10);
    expect(docs.assets.indexed).toBe(90);
  });

  it('drops every article without the reservation, which is the defect the caps fix', async () => {
    stubCorpus(articles(10), assets(500));
    const client = new HuduClient({
      baseUrl: 'https://hudu.example.com',
      apiKey: 'not-a-real-key',
      search: { maxIndexTextBytes: 4 * MiB, maxDocs: 100 },
    });
    const result = (await client.operations.searchKnowledge('password reset', { tier: 'index', limit: 1 })) as {
      meta: { index: { docs: Record<string, { indexed: number }> } };
    };
    // The assets are newer, so the global cap keeps 100 assets and no article at all.
    expect(result.meta.index.docs.articles!.indexed).toBe(0);
    expect(result.meta.index.docs.assets!.indexed).toBe(100);
  });

  it('caps articles at the document cap and reports what it dropped', async () => {
    stubCorpus(articles(300), assets(5));
    const docs = await build(100);
    expect(docs.articles.indexed).toBe(100);
    expect(docs.articles.capped).toBe(200);
    // The asset share is derived and can be zero: articles alone fill this cap.
    expect(docs.assets.indexed).toBe(0);
    expect(docs.assets.capped).toBe(5);
  });
});
