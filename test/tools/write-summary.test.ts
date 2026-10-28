/**
 * write-summary.test.ts — the committed article write answers with a summary, not the stored
 * record (issue #63).
 *
 * Every case drives `hudu_write` through the mcp-session harness with `fetch` stubbed: the
 * stored record is the stub's PUT answer, the pre-write body the GET answer. Dry runs and
 * non-article writes keep the full record (deliberate scope), so those cases pin the result
 * unchanged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { markdownToHtml } from 'node-hudu/content';
import { connect } from '../helpers/mcp-session.js';
import type { Json } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

/** A full article record; `content` is the body the stubbed API holds. */
const article = (content: string, updated_at = '2026-01-02T00:00:00Z'): Json => ({
  article: {
    id: 22,
    slug: 'setup',
    name: 'Setup',
    draft: false,
    content,
    url: 'https://hudu.invalid/articles/setup',
    object_type: 'article',
    folder_id: 1,
    enable_sharing: false,
    share_url: '',
    company_id: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at,
    public_photos: [],
  },
});

/** A stub that answers GET and PUT with DIFFERENT records: the stored record is the PUT answer. */
function articleStub(getRecord: Json, putRecord: Json) {
  const calls: { method: string; body: string }[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, body: typeof init?.body === 'string' ? init.body : '' });
    return Response.json(method === 'PUT' ? putRecord : getRecord);
  });
  return calls;
}

/** Every object key anywhere under a JSON value — the deep assert that no `content` key survives. */
const keysOf = (node: unknown, into: string[] = []): string[] => {
  if (Array.isArray(node)) {
    for (const v of node) keysOf(v, into);
    return into;
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      into.push(k);
      keysOf(v, into);
    }
  }
  return into;
};

const noContentKey = (structuredContent: unknown): void => {
  expect(keysOf(structuredContent), JSON.stringify(structuredContent)).not.toContain('content');
  expect(JSON.stringify(structuredContent)).not.toContain('"content"');
};

describe('a committed article write answers with the summary', () => {
  it('a Markdown articles.update: content_match true, byte counts, no content key anywhere', async () => {
    const sent = '## Setup\n\nBody *here*';
    const sentHtml = markdownToHtml(sent);
    const session = await connect();
    articleStub(article('<h2>Setup</h2><p>Old</p>'), article(sentHtml));
    try {
      const result = await session.call('hudu_write', { operation: 'articles.update', input: { id: 22, data: { content: sent } }, dry_run: false });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text).text).toBe('articles.update completed.');
      noContentKey(result.structuredContent);
      expect(result.structuredContent.result).toEqual({
        id: 22,
        name: 'Setup',
        slug: 'setup',
        updated_at: '2026-01-02T00:00:00Z',
        url: 'https://hudu.invalid/articles/setup',
        content_match: true,
        sent_bytes: Buffer.byteLength(sentHtml, 'utf8'),
        stored_bytes: Buffer.byteLength(sentHtml, 'utf8'),
      });
    } finally {
      await session.close();
    }
  });

  it('a block-HTML body is stored as sent: the verbatim path, PUT only', async () => {
    const body = '<div>x</div>';
    const session = await connect();
    const calls = articleStub(article('<h2>Setup</h2><p>Old</p>'), article(body));
    try {
      const result = await session.call('hudu_write', { operation: 'articles.update', input: { id: 22, data: { content: body } }, dry_run: false });
      expect(result.isError).toBeUndefined();
      noContentKey(result.structuredContent);
      const r = result.structuredContent.result;
      expect(r.content_match).toBe(true);
      expect(r.sent_bytes).toBe(Buffer.byteLength(body, 'utf8'));
      expect(r.stored_bytes).toBe(Buffer.byteLength(body, 'utf8'));
      expect(r.element_deltas).toBeUndefined();
      expect(calls.map((c) => c.method)).toEqual(['PUT']);
    } finally {
      await session.close();
    }
  });

  it('an explicit opts.format html takes the verbatim path for any body', async () => {
    const body = 'plain line, no tags';
    const session = await connect();
    const calls = articleStub(article('<h2>Setup</h2><p>Old</p>'), article(body));
    try {
      const result = await session.call('hudu_write', {
        operation: 'articles.update',
        input: { id: 22, data: { content: body }, opts: { format: 'html' } },
        dry_run: false,
      });
      expect(result.isError).toBeUndefined();
      const r = result.structuredContent.result;
      expect(r.content_match).toBe(true);
      expect(r.sent_bytes).toBe(Buffer.byteLength(body, 'utf8'));
      expect(r.stored_bytes).toBe(Buffer.byteLength(body, 'utf8'));
      expect(calls.map((c) => c.method)).toEqual(['PUT']);
    } finally {
      await session.close();
    }
  });

  it('an image src rewrite and a dropped link: content_match false with element_deltas', async () => {
    const sent = '<p><a href="/docs">link</a> <img src="/uploads/x.png" alt="x"></p>';
    const stored = '<p><img src="/public_photo/x.png" alt="x"></p>';
    const session = await connect();
    articleStub(article('<h2>Setup</h2><p>Old</p>'), article(stored));
    try {
      const result = await session.call('hudu_write', { operation: 'articles.update', input: { id: 22, data: { content: sent } }, dry_run: false });
      expect(result.isError).toBeUndefined();
      noContentKey(result.structuredContent);
      const r = result.structuredContent.result;
      expect(r.content_match).toBe(false);
      expect(r.element_deltas).toEqual({ table: 0, pre: 0, a: -1, img: 0 });
      expect(r.sent_bytes).toBe(Buffer.byteLength(sent, 'utf8'));
      expect(r.stored_bytes).toBe(Buffer.byteLength(stored, 'utf8'));
    } finally {
      await session.close();
    }
  });

  it('a Markdown articles.create: summary, content_match true, no content key anywhere', async () => {
    const sent = '# New Guide\n\nFirst *body*';
    const sentHtml = markdownToHtml(sent);
    const session = await connect();
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      calls.push(init?.method ?? 'GET');
      return Response.json({
        article: {
          id: 30,
          slug: 'new-guide',
          name: 'New Guide',
          draft: false,
          content: sentHtml,
          url: 'https://hudu.invalid/articles/new-guide',
          object_type: 'article',
          folder_id: 1,
          enable_sharing: false,
          share_url: '',
          company_id: 1,
          created_at: '2026-02-01T00:00:00Z',
          updated_at: '2026-02-01T00:00:00Z',
          public_photos: [],
        },
      });
    });
    try {
      const result = await session.call('hudu_write', {
        operation: 'articles.create',
        input: { data: { name: 'New Guide', slug: 'new-guide', content: sent } },
        dry_run: false,
      });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text).text).toBe('articles.create completed.');
      noContentKey(result.structuredContent);
      expect(result.structuredContent.result).toEqual({
        id: 30,
        name: 'New Guide',
        slug: 'new-guide',
        updated_at: '2026-02-01T00:00:00Z',
        url: 'https://hudu.invalid/articles/new-guide',
        content_match: true,
        sent_bytes: Buffer.byteLength(sentHtml, 'utf8'),
        stored_bytes: Buffer.byteLength(sentHtml, 'utf8'),
      });
      expect(calls).toEqual(['POST']);
    } finally {
      await session.close();
    }
  });

  it('articles.patchSection: content_match as a presence check, no sent_bytes, no element_deltas', async () => {
    const sectionHtml = markdownToHtml('New');
    const stored = `<h2>Setup</h2>${sectionHtml}`;
    const session = await connect();
    const calls = articleStub(article('<h2>Setup</h2><p>Old</p>'), article(stored));
    try {
      const result = await session.call('hudu_write', {
        operation: 'articles.patchSection',
        input: { id: 22, patch: { heading: 'Setup', markdown: 'New', mode: 'replace' } },
        dry_run: false,
      });
      expect(result.isError).toBeUndefined();
      noContentKey(result.structuredContent);
      const r = result.structuredContent.result;
      expect(r.content_match).toBe(true);
      expect(r.sent_bytes).toBeUndefined();
      expect(r.element_deltas).toBeUndefined();
      expect(r.stored_bytes).toBe(Buffer.byteLength(stored, 'utf8'));
      expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'PUT']);
    } finally {
      await session.close();
    }
  });

  it('articles.patchSection: a stored body without the sent section is content_match false', async () => {
    const session = await connect();
    articleStub(article('<h2>Setup</h2><p>Old</p>'), article('<h2>Setup</h2><p>Old</p>'));
    try {
      const result = await session.call('hudu_write', {
        operation: 'articles.patchSection',
        input: { id: 22, patch: { heading: 'Setup', markdown: 'New', mode: 'replace' } },
        dry_run: false,
      });
      expect(result.isError).toBeUndefined();
      const r = result.structuredContent.result;
      expect(r.content_match).toBe(false);
      expect(r.element_deltas).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('a field-only articles.update (no data.content): no content_match, no sent_bytes', async () => {
    const stored = '<p>Body</p>';
    const session = await connect();
    const calls = articleStub(article(stored), article(stored));
    try {
      const result = await session.call('hudu_write', { operation: 'articles.update', input: { id: 22, data: { name: 'Renamed' } }, dry_run: false });
      expect(result.isError).toBeUndefined();
      noContentKey(result.structuredContent);
      expect(result.structuredContent.result).toEqual({
        id: 22,
        name: 'Setup',
        slug: 'setup',
        updated_at: '2026-01-02T00:00:00Z',
        url: 'https://hudu.invalid/articles/setup',
        stored_bytes: Buffer.byteLength(stored, 'utf8'),
      });
      expect(calls.map((c) => c.method)).toEqual(['PUT']);
    } finally {
      await session.close();
    }
  });

  it('an unexpected result shape (no string content) passes through unchanged', async () => {
    const session = await connect();
    vi.stubGlobal('fetch', async () => Response.json({ article: { id: 22, name: 'Setup' } }));
    try {
      const result = await session.call('hudu_write', { operation: 'articles.update', input: { id: 22, data: { name: 'Renamed' } }, dry_run: false });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent.result).toEqual({ id: 22, name: 'Setup' });
      expect(result.structuredContent.result.content_match).toBeUndefined();
      expect(result.structuredContent.result.stored_bytes).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('a dry run returns the simulated result unchanged, no summary fields', async () => {
    const session = await connect();
    const calls = articleStub(article('<h2>Setup</h2><p>Old</p>'), article('<h2>Setup</h2><p>Old</p>'));
    try {
      const result = await session.call('hudu_write', { operation: 'articles.update', input: { id: 22, data: { content: 'New' } }, dry_run: true });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text).text).toBe('Dry run: nothing was written (articles.update).');
      expect(result.structuredContent.simulated).toBe(true);
      // The full unchanged dry-run shape (the SDK's DryRunResult key set, no summary fields):
      const r = result.structuredContent.result;
      expect(r).toMatchObject({
        operation: 'articles.update',
        wouldApply: true,
        target: { resource: 'articles', ids: [22] },
        request: { method: 'PUT', path: '/articles/22' },
        impact: { affected: 1, scope: 'single', reversible: true },
        simulated: true,
        warnings: ['server-computed fields are not guaranteed by dry-run'],
      });
      expect(Array.isArray(r.checks)).toBe(true);
      expect(Object.keys(r).sort()).toEqual(['checks', 'impact', 'operation', 'request', 'simulated', 'target', 'warnings', 'wouldApply']);
      expect(Object.keys(result.structuredContent).sort()).toEqual(['operation', 'result', 'simulated']);
      expect(calls.map((c) => c.method)).not.toContain('PUT');
    } finally {
      await session.close();
    }
  });

  it('folders.create committed: the full stubbed record, unchanged', async () => {
    const record = { id: 7, name: 'Reports', company_id: 1 };
    const session = await connect(() => Response.json({ folder: record }));
    try {
      const result = await session.call('hudu_write', { operation: 'folders.create', input: { data: { name: 'Reports' } }, dry_run: false });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent.result).toEqual(record);
      expect(result.structuredContent.result.content_match).toBeUndefined();
    } finally {
      await session.close();
    }
  });
});
