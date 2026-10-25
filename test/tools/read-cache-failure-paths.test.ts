import { afterEach, describe, expect, it, vi } from 'vitest';
import { HuduClient } from 'node-hudu';
import { API_KEY, config, connect, connectForRequest, type Session } from '../helpers/mcp-session.js';
import { createLogger } from '../../src/logger.js';
import { createMcpServerFactory } from '../../src/tools.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type A = { id: number; name: string; content: string; updated_at: string };
function stub(mode: { write?: 'ok' | 500 | 'abort' | 'malformed' } = {}) {
  const store = new Map<number, A>([[22, { id: 22, name: 't', content: '<p>old</p>', updated_at: '2026-01-01T00:00:00Z' }]]);
  let s!: Session;
  const respond = (url: string): Response => {
    const method = s.methods.at(-1);
    const body = s.bodies.at(-1) ?? '';
    const m = /\/articles\/(\d+)/.exec(url);
    if (method === 'GET') {
      if (!m) return Response.json({ articles: [...store.values()] });
      const a = store.get(Number(m[1]));
      return a ? Response.json({ article: a }) : Response.json({ error: 'nf' }, { status: 404 });
    }
    // the write "applies" server-side in every mode, then the response is bad
    const parsed = body ? JSON.parse(body) : {}; const data = parsed.article ?? parsed;
    if (method === 'PUT') store.set(Number(m![1]), { ...store.get(Number(m![1]))!, ...data, updated_at: '2026-02-02T00:00:00Z' });
    if (method === 'DELETE') store.delete(Number(m![1]));
    if (method === 'POST') store.set(100, { id: 100, name: data.name, content: data.content, updated_at: 'x' });
    if (mode.write === 500) return Response.json({ error: 'boom' }, { status: 500 });
    if (mode.write === 'abort') throw new DOMException('aborted', 'AbortError');
    if (mode.write === 'malformed') return new Response('<html>not json', { status: 200, headers: { 'content-type': 'application/json' } });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ article: method === 'POST' ? store.get(100) : store.get(Number(m![1])) });
  };
  return { store, respond, bind: (x: Session) => (s = x) };
}
async function open(mode?: Parameters<typeof stub>[0], override = {}) {
  const h = stub(mode);
  const s = await connect((u) => h.respond(u), override);
  h.bind(s);
  return { h, s };
}
const get = (s: Session, id = 22) => s.call('hudu_read', { operation: 'articles.get', input: { id } });
const update = (s: Session, content: string, extra: object = { dry_run: false }) => s.call('hudu_write', { operation: 'articles.update', input: { id: 22, data: { content } }, ...extra });
const text = (r: any) => JSON.stringify(r.structuredContent ?? r.content);

describe('read cache clear: failure, delegate and scope paths', () => {
  for (const w of [500, 'abort', 'malformed'] as const) {
    it(`failing write (${w}) still clears`, async () => {
      const { s } = await open({ write: w });
      try {
        expect(text(await get(s))).toContain('old');
        const r = await update(s, 'applied anyway');
        expect(text(await get(s))).toContain('applied anyway');
      } finally { await s.close(); }
    });
  }

  it('failing delete (500) still clears -> NOT_FOUND', async () => {
    const { s } = await open({ write: 500 });
    try {
      await get(s);
      const d = await s.call('hudu_delete', { operation: 'articles.delete', input: { id: 22 }, dry_run: false, confirm: 'articles.delete' });
      expect(d.isError).toBe(true);
      expect(text(await get(s))).toMatch(/NOT_FOUND/);
    } finally { await s.close(); }
  });

  it('clearCache throwing does not turn a success into an error; warns without secrets', async () => {
    vi.spyOn(HuduClient.prototype, 'clearCache').mockImplementation(() => { throw new Error('kaboom'); });
    const { s } = await open();
    try {
      const r = await update(s, 'new');
      expect(r.isError).toBeUndefined();
      expect(JSON.stringify(r.content)).toContain('completed');
      const warn = s.logs.find((l) => l.msg === 'read cache clear failed after write');
      expect(warn).toBeDefined();
      expect(JSON.stringify(s.logs)).not.toContain(API_KEY);
      expect(s.logs.filter((l) => l.level === 'warn' && l.msg === 'read cache clear failed after write')).toHaveLength(1);
    } finally { await s.close(); }
  });

  it('validation refusal with dry_run false sends nothing (clear is harmless)', async () => {
    const { s } = await open();
    try {
      await get(s);
      const n = s.urls.length;
      const r = await s.call('hudu_write', { operation: 'articles.update', input: { id: 'nope' }, dry_run: false });
      expect(r.isError).toBe(true);
      expect(s.urls.length).toBe(n);
    } finally { await s.close(); }
  });

  it('allow_list patchSection (dependsOn delegate update) clears', async () => {
    const { h, s } = await open({}, { HUDU_WRITE_POLICY: 'allow_list', HUDU_WRITE_ALLOW: ['articles.patchSection'] });
    h.store.set(22, { id: 22, name: 't', content: '<h2>Intro</h2><p>old</p>', updated_at: 'a' });
    try {
      await update(s, 'x'); // refused (not allowed directly)
      const r0 = await s.call('hudu_read', { operation: 'articles.get', input: { id: 22 } });
      expect(text(r0)).toContain('old');
      const r = await s.call('hudu_write', { operation: 'articles.patchSection', input: { id: 22, patch: { heading: 'Intro', markdown: 'patched-via-allowlist', createIfMissing: true } }, dry_run: false });
      expect(r.isError).toBeUndefined(); expect(text(await get(s))).toContain('patched-via-allowlist');
    } finally { await s.close(); }
  });

  it('http: same scope, different requests: R2 write clears R1/R3 read client; other scope untouched', async () => {
    const factory = createMcpServerFactory({ ...config, MCP_TRANSPORT: 'http', HUDU_API_KEY: undefined, HUDU_BASE_URL: undefined }, createLogger('error', () => {}));
    const bodies: Record<string, string> = { 'key-a': 'old-a', 'key-b': 'old-b' };
    const respond = () => Response.json({});
    const r1 = await connectForRequest('key-a', respond, [], {}, 'https://hudu.invalid', factory);
    const r2 = await connectForRequest('key-a', respond, [], {}, 'https://hudu.invalid', factory);
    const r3 = await connectForRequest('key-a', respond, [], {}, 'https://hudu.invalid', factory);
    const rb = await connectForRequest('key-b', respond, [], {}, 'https://hudu.invalid', factory);
    let getsB = 0;
    vi.stubGlobal('fetch', async (_u: unknown, init?: RequestInit) => {
      const key = new Headers(init?.headers).get('x-api-key')!;
      if ((init?.method ?? 'GET') === 'GET') {
        if (key === 'key-b') getsB++;
        return Response.json({ article: { id: 22, name: 't', content: `<p>${bodies[key]}</p>`, updated_at: 'x' } });
      }
      bodies[key] = 'new-a';
      return Response.json({ article: { id: 22, name: 't', content: '<p>new-a</p>', updated_at: 'y' } });
    });
    try {
      expect(text(await get(r1))).toContain('old-a');
      await get(rb);
      expect((await update(r2, 'new-a')).isError).toBeUndefined();
      expect(text(await get(r3))).toContain('new-a');
      expect(text(await get(r1))).toContain('new-a');
      await get(rb);
      expect(getsB).toBe(1);
    } finally { await r1.close(); await r2.close(); await r3.close(); await rb.close(); }
  });
});

