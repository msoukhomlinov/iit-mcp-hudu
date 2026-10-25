/** Reads after a write are fresh in-process: the dispatchers clear the same scope's read-client cache (#45). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, connect, connectForRequest, type Session } from '../helpers/mcp-session.js';
import { createLogger } from '../../src/logger.js';
import { createMcpServerFactory } from '../../src/tools.js';

afterEach(() => vi.unstubAllGlobals());

/** A tiny stateful Hudu: one article at /articles/22 (plus optional extra ids), GET/PUT/POST/DELETE. */
function hudu(opts: { failWrites?: number } = {}) {
  const store = new Map<number, { id: number; name: string; content: string; updated_at: string }>([[22, { id: 22, name: 't', content: '<p>old</p>', updated_at: '2026-01-01T00:00:00Z' }]]);
  let session!: Session;
  let next = 100;
  const respond = (url: string): Response => {
    const method = session.methods.at(-1);
    const body = session.bodies.at(-1) ?? '';
    const id = Number(/\/articles\/(\d+)/.exec(url)?.[1]);
    const parsed = body ? JSON.parse(body) : {};
    const data = parsed.article ?? parsed;
    if (method === 'GET') {
      const a = store.get(id);
      return a ? Response.json({ article: a }) : Response.json({ error: 'nf' }, { status: 404 });
    }
    if (opts.failWrites) return Response.json({ error: 'boom' }, { status: opts.failWrites });
    if (method === 'PUT') {
      const a = { ...store.get(id)!, ...data, updated_at: '2026-02-02T00:00:00Z' };
      store.set(id, a);
      return Response.json({ article: a });
    }
    if (method === 'POST') {
      const a = { id: next++, name: data.name ?? 'n', content: data.content ?? '', updated_at: '2026-02-02T00:00:00Z' };
      store.set(a.id, a);
      return Response.json({ article: a });
    }
    if (method === 'DELETE') {
      store.delete(id);
      return new Response(null, { status: 204 });
    }
    return Response.json({}, { status: 500 });
  };
  return { store, respond, bind: (s: Session) => (session = s) };
}

const get = (s: Session, id = 22) => s.call('hudu_read', { operation: 'articles.get', input: { id } });
const update = (s: Session, content: string) => s.call('hudu_write', { operation: 'articles.update', input: { id: 22, data: { content } }, dry_run: false });
const text = (r: any) => JSON.stringify(r.structuredContent ?? r.content);

async function open(opts?: Parameters<typeof hudu>[0]) {
  const h = hudu(opts);
  const s = await connect((u) => h.respond(u));
  h.bind(s);
  return { h, s };
}

describe('read cache is cleared after a write attempt', () => {
  it('cache is live: a second get makes no request', async () => {
    const { s } = await open();
    try {
      await get(s);
      const n = s.urls.length;
      await get(s);
      expect(s.urls.length).toBe(n);
    } finally { await s.close(); }
  });

  it('get -> update -> get returns the new body via a request', async () => {
    const { s } = await open();
    try {
      expect(text(await get(s))).toContain('old');
      expect((await update(s, 'brand new body')).isError).toBeUndefined();
      const n = s.urls.length;
      expect(text(await get(s))).toContain('brand new body');
      expect(s.urls.length).toBeGreaterThan(n);
    } finally { await s.close(); }
  });

  it('getSection, fetch_many, article context (default and expand) are fresh after a write', async () => {
    const { s } = await open();
    try {
      const reads = async () => ({
        section: text(await s.call('hudu_read', { operation: 'articles.getSection', input: { id: 22, heading: 'Intro' } })),
        many: text(await s.call('hudu_fetch_many', { items: [{ resource: 'articles', id: 22 }] })),
        ctx: text(await s.call('hudu_get_article_context', { id: 22 })),
        ctxx: text(await s.call('hudu_get_article_context', { id: 22, opts: { expand: true } })),
      });
      await update(s, '## Intro\n\nfirst');
      const before = await reads();
      expect(before.many).toContain('first');
      expect(before.ctxx).toContain('first');
      await update(s, '## Intro\n\nsecond');
      const after = await reads();
      expect(after.many).toContain('second');
      expect(after.ctxx).toContain('second');
      expect(after.section).toContain('second');
      expect(after.ctx).toBeDefined();
    } finally { await s.close(); }
  });

  it('patchSection then get is fresh', async () => {
    const { s } = await open();
    try {
      await update(s, '## Intro\n\nfirst');
      await get(s);
      const r = await s.call('hudu_write', { operation: 'articles.patchSection', input: { id: 22, patch: { heading: 'Intro', markdown: 'patched text' } }, dry_run: false });
      expect(r.isError, text(r)).toBeUndefined();
      expect(text(await get(s))).toContain('patched text');
    } finally { await s.close(); }
  });

  it('create: the new record is readable; delete: get after delete is NOT_FOUND', async () => {
    const { s } = await open();
    try {
      const c = await s.call('hudu_write', { operation: 'articles.create', input: { data: { name: 'fresh', content: 'hello' } }, dry_run: false });
      expect(c.isError, text(c)).toBeUndefined();
      const id = c.structuredContent.result.id;
      expect(text(await get(s, id))).toContain('hello');
      await get(s, 22);
      const d = await s.call('hudu_delete', { operation: 'articles.delete', input: { id: 22 }, dry_run: false, confirm: 'articles.delete' });
      expect(d.isError, text(d)).toBeUndefined();
      const gone = await get(s, 22);
      expect(gone.isError).toBe(true);
      expect(text(gone)).toMatch(/NOT_FOUND/);
    } finally { await s.close(); }
  });

  it('a write that fails with 500 still clears the stale pre-write cache', async () => {
    const { h, s } = await open({ failWrites: 500 });
    try {
      await get(s);
      h.store.set(22, { ...h.store.get(22)!, content: '<p>applied anyway</p>' });
      expect((await update(s, 'x')).isError).toBe(true);
      expect(text(await get(s))).toContain('applied anyway');
    } finally { await s.close(); }
  });

  it('a dry run does not clear the cache', async () => {
    const { s } = await open();
    try {
      await get(s);
      await s.call('hudu_write', { operation: 'articles.update', input: { id: 22, data: { content: 'x' } }, dry_run: true });
      const n = s.urls.length;
      await get(s);
      expect(s.urls.length).toBe(n);
      // dry_run absent is forced to a dry run by the SDK: no write, no clear
      await s.call('hudu_write', { operation: 'articles.update', input: { id: 22, data: { content: 'x' } } });
      const m = s.urls.length;
      await get(s);
      expect(s.urls.length).toBe(m);
    } finally { await s.close(); }
  });

  it('a policy refusal never dials and does not clear', async () => {
    const h = hudu();
    const s = await connect((u) => h.respond(u), { HUDU_WRITE_POLICY: 'allow_list', HUDU_WRITE_ALLOW: ['articles.create'] });
    h.bind(s);
    try {
      await get(s);
      const n = s.urls.length;
      const refused = await update(s, 'nope');
      expect(refused.isError).toBe(true);
      expect(text(refused)).toMatch(/POLICY_DENIED/);
      await get(s);
      expect(s.urls.length).toBe(n);
    } finally { await s.close(); }
  });

  it('a read in flight across a write is not stored', async () => {
    const h = hudu();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    const s = await connect((u) => {
      const method = s.methods.at(-1);
      const stale = h.respond(u);
      if (method === 'GET' && !held) {
        held = true;
        return gate.then(() => stale) as any;
      }
      return h.respond(u);
    });
    h.bind(s);
    try {
      const inflight = get(s); // snapshot of the OLD body taken at request time, response held
      await new Promise((r) => setTimeout(r, 20));
      expect((await update(s, 'newer body')).isError).toBeUndefined();
      release();
      expect(text(await inflight)).toContain('old');
      expect(text(await get(s))).toContain('newer body');
    } finally { await s.close(); }
  });
});

describe('scopes', () => {
  it('a write in scope A does not clear scope B', async () => {
    const logs: any[] = [];
    const factory = createMcpServerFactory({ ...config, MCP_TRANSPORT: 'http', HUDU_API_KEY: undefined, HUDU_BASE_URL: undefined }, createLogger('error', () => {}));
    const a = await connectForRequest('key-a', () => Response.json({}), logs, {}, 'https://hudu.invalid', factory);
    const b = await connectForRequest('key-b', () => Response.json({}), logs, {}, 'https://hudu.invalid', factory);
    const bodies: Record<string, string> = { 'key-a': 'old-a', 'key-b': 'old-b' };
    const gets: Record<string, number> = { 'key-a': 0, 'key-b': 0 };
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const key = new Headers(init?.headers).get('x-api-key')!;
      if ((init?.method ?? 'GET') === 'GET') {
        gets[key]++;
        return Response.json({ article: { id: 22, name: 't', content: `<p>${bodies[key]}</p>`, updated_at: 'x' } });
      }
      bodies[key] = 'new-a';
      return Response.json({ article: { id: 22, name: 't', content: '<p>new-a</p>', updated_at: 'y' } });
    });
    try {
      const read = (s: Session) => s.call('hudu_read', { operation: 'articles.get', input: { id: 22 } });
      await read(a);
      await read(b);
      await update(a, 'new-a');
      expect(text(await read(a))).toContain('new-a');
      expect(gets['key-a']).toBeGreaterThanOrEqual(2);
      bodies['key-b'] = 'changed-elsewhere';
      expect(text(await read(b))).toContain('old-b');
      expect(gets['key-b']).toBe(1);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
