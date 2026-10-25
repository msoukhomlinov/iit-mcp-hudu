
import http from 'node:http';
import { HuduClient } from 'node-hudu';

// --- stub tenant: 400 articles with 3 KB bodies, served for any resource path ---
const body = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet '.repeat(40); // ~2.9 KB
const docs = Array.from({ length: 400 }, (_, i) => ({
  id: i + 1, name: `Article ${i}`, content: body, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
}));
const server = http.createServer((req, res) => {
  // one payload shape that satisfies every resource the walk asks for
  const payload = { articles: docs, assets: [], asset_layouts: [], companies: [], meta: { total_pages: 1, page: 1 } };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const MAXDOCS = Number(process.env.MAXDOCS ?? 50000);
async function run(label, maxIndexTextBytes) {
  const client = new HuduClient({ baseUrl: base, apiKey: 'x'.repeat(40), search: { maxIndexTextBytes, maxDocs: MAXDOCS } });
  const t0 = Date.now();
  const r = await client.operations.searchKnowledge('juliet', { tier: 'index', limit: 5 });
  const ms = Date.now() - t0;
  const idx = r?.meta?.index ?? {};
  const docStats = idx.docs ?? {};
  const evicted = Object.values(docStats).reduce((n, d) => n + (d.textEvicted ?? d.evicted ?? 0), 0);
  console.log('DOCS_SAMPLE', JSON.stringify(Object.entries(r?.meta?.index?.docs ?? {})));
  console.log(JSON.stringify({ label, maxIndexTextBytes, ms, state: idx.state, staleness: idx.staleness,
    hitCount: r?.hits?.length ?? null, reasons: r?.meta?.reasons ?? null,
    degraded: r?.meta?.degraded?.reason ?? null, docKeys: Object.keys(docStats).slice(0, 6), evicted }));
}
await run('docs_cap_pool', 8 * 1024 * 1024);
server.close();
