/** Identifier validation across the generic dispatcher and the dedicated tools (#17). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

const REJECTED: unknown[] = [1.5, -1, 0, '12abc', '1/2'];

type Case = [tool: string, args: (id: unknown) => Record<string, unknown>, url: string];

const CASES: Case[] = [
  ['hudu_read', (id) => ({ operation: 'companies.get', input: { id } }), 'https://hudu.invalid/api/v1/companies/42'],
  ['hudu_read', (id) => ({ operation: 'articles.get', input: { id } }), 'https://hudu.invalid/api/v1/articles/42'],
  ['hudu_write', (id) => ({ operation: 'companies.update', input: { id, data: { name: 'x' } }, dry_run: false }), 'https://hudu.invalid/api/v1/companies/42'],
  ['hudu_delete', (id) => ({ operation: 'companies.delete', input: { id }, dry_run: false, confirm: 'companies.delete' }), 'https://hudu.invalid/api/v1/companies/42'],
  ['hudu_get_company_context', (id) => ({ id }), 'https://hudu.invalid/api/v1/companies/42'],
  ['hudu_get_article_context', (id) => ({ id }), 'https://hudu.invalid/api/v1/articles/42'],
  ['hudu_fetch_many', (id) => ({ items: [{ resource: 'companies', id }] }), 'https://hudu.invalid/api/v1/companies/42'],
  ['hudu_get_folder', (id) => ({ identifier: { id } }), 'https://hudu.invalid/api/v1/folders/42'],
  ['hudu_list_assets', (id) => ({ company_id: id }), 'https://hudu.invalid/api/v1/assets?company_id=42&page=1&page_size=25'],
];

const respond = () => Response.json({ company: { id: 42 }, article: { id: 42 }, folder: { id: 42 }, companies: [], assets: [], articles: [] });

describe('identifier validation', () => {
  it.each(CASES.flatMap(([tool, args]) => REJECTED.map((id) => [tool, JSON.stringify(args(id))] as const)))(
    '%s refuses %s without a request',
    async (tool, label) => {
      const session = await connect(respond);
      try {
        const result = await session.call(tool, JSON.parse(label));
        expect(result.isError).toBe(true);
        expect(session.urls).toEqual([]);
      } finally {
        await session.close();
      }
    },
  );

  it.each(CASES.map(([tool, args, url]) => [tool, JSON.stringify(args(42)), url] as const))(
    '%s accepts a valid id: %s',
    async (tool, label, url) => {
      const session = await connect(respond);
      try {
        await session.call(tool, JSON.parse(label));
        expect(session.urls[0]).toBe(url);
      } finally {
        await session.close();
      }
    },
  );
});
