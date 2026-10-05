import { afterEach, expect, it, vi } from 'vitest';
import { createMcpServerFactory } from '../../src/tools/server.js';
import { createLogger } from '../../src/logger.js';
import { connect, connectForRequest, config } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

it('supplies the companies.resolve documentation URL in actual MCP structuredContent', async () => {
  const session = await connect(() => Response.json({ company: {
    id: 1, name: 'Intellect IT', knowledge_base_url: '/kba?company_id=1',
  } }));
  try {
    const result = await session.call('hudu_read', { operation: 'companies.resolve', input: { identifier: 1, opts: { expand: true } } });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.result.knowledge_base_url).toBe('https://hudu.invalid/kba?company_id=1');
  } finally {
    await session.close();
  }
});

it('keeps concurrent allowed request origins isolated in one factory, overriding the default', async () => {
  const factory = createMcpServerFactory({ ...config, MCP_TRANSPORT: 'http',
    HUDU_ALLOWED_BASE_HOSTS: ['a.example', 'b.example'] }, createLogger('error', () => {}));
  const respond = () => Response.json({ company: { id: 1, knowledge_base_url: '/kba?company_id=1' } });
  const a = await connectForRequest('same-key', respond, [], {}, 'https://a.example', factory);
  const b = await connectForRequest('same-key', respond, [], {}, 'https://b.example:8443', factory);
  const fetched: string[] = [];
  vi.stubGlobal('fetch', async (url: unknown) => { fetched.push(String(url)); return respond(); });
  try {
    const call = (s: typeof a) => s.call('hudu_read', { operation: 'companies.resolve', input: { identifier: 1, opts: { expand: true } } });
    const results = await Promise.all([call(a), call(b), call(a)]);
    expect(results.map((r) => r.structuredContent.result.knowledge_base_url)).toEqual([
      'https://a.example/kba?company_id=1', 'https://b.example:8443/kba?company_id=1', 'https://a.example/kba?company_id=1',
    ]);
    expect(fetched).toHaveLength(3);
    expect(fetched.map((u) => new URL(u).origin).sort()).toEqual(['https://a.example', 'https://a.example', 'https://b.example:8443']);
  } finally { await a.close(); await b.close(); }
});

it.each([
  { base: null, overrides: {} },
  { base: 'not-a-url', overrides: { HUDU_BASE_URL: 'https://default.example' } },
  { base: 'https://a.example/path', overrides: { HUDU_BASE_URL: 'https://default.example' } },
  { base: 'https://refused.example', overrides: { HUDU_BASE_URL: 'https://default.example', HUDU_ALLOWED_BASE_HOSTS: ['allowed.example'] } },
])('does not fall back from missing/invalid/refused origin: $base', async ({ base, overrides }) => {
  const s = await connectForRequest('key', () => { throw new Error('must not fetch'); }, [], overrides, base);
  try {
    const r = await s.call('hudu_read', { operation: 'companies.resolve', input: { identifier: 1, opts: { expand: true } } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(s.urls).toEqual([]);
  } finally { await s.close(); }
});

it('normalizes list output and preserves credential redaction', async () => {
  const s = await connect(() => Response.json({ companies: [{ id: 1, name: 'Intellect IT',
    knowledge_base_url: '/kba?company_id=1', password: 'never-emit-this', otp_seed: 'never-emit-seed' }] }));
  try {
    const r = await s.call('hudu_list_companies', { expand: true });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent.rows[0].knowledge_base_url).toBe('https://hudu.invalid/kba?company_id=1');
    expect(JSON.stringify(r)).not.toContain('never-emit');
    expect(s.urls).toHaveLength(1);
  } finally { await s.close(); }
});

it('uses the operator default when HTTP legitimately selects it', async () => {
  const s = await connectForRequest(undefined, () => Response.json({ company: {
    id: 1, knowledge_base_url: '/kba?company_id=1',
  } }), [], { HUDU_BASE_URL: 'https://default.example', HUDU_API_KEY: 'default-key' }, null);
  try {
    const r = await s.call('hudu_read', { operation: 'companies.resolve', input: { identifier: 1, opts: { expand: true } } });
    expect(r.structuredContent.result.knowledge_base_url).toBe('https://default.example/kba?company_id=1');
    expect(new URL(s.urls[0]!).origin).toBe('https://default.example');
  } finally { await s.close(); }
});
