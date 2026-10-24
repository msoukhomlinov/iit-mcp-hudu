/**
 * share-ops.test.ts — the four asset_passwords share operations (node-hudu 0.16.0, issue #24 G):
 * refused under the default secret-read policy, `createShare` never runnable here (the SDK needs
 * `reveal`, which this server never grants), a share `url` masked on read, link text scrubbed
 * from errors.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

const LINK = 'https://hudu.invalid/share/secret-token-never-returned';
const SHARE = { id: 5, url: LINK, shareable_type: 'AssetPassword', shareable_id: 7, expires_at: '2027-01-01T00:00:00Z' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const calls = [
  ['hudu_read', 'asset_passwords.listShares', { passwordId: 7 }],
  ['hudu_read', 'asset_passwords.getShare', { passwordId: 7, shareId: 5 }],
  ['hudu_write', 'asset_passwords.createShare', { passwordId: 7, data: { expire_in: 3600 } }],
  ['hudu_delete', 'asset_passwords.deleteShare', { passwordId: 7, shareId: 5 }],
] as const;

describe('share operations under the default HUDU_SECRET_READS=deny', () => {
  it.each(calls)('%s %s is refused with no request, even under write policy all', async (tool, operation, input) => {
    const session = await connect(undefined, { HUDU_WRITE_POLICY: 'all' });
    const result = await session.call(tool, { operation, input, ...(tool === 'hudu_read' ? {} : { dry_run: false }), ...(tool === 'hudu_delete' ? { confirm: operation } : {}) });
    expect(result.isError).toBe(true);
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('a write share op also needs the write policy (deny registers no hudu_write)', async () => {
    const session = await connect(undefined, { HUDU_WRITE_POLICY: 'deny', HUDU_SECRET_READS: 'allow' });
    expect((await session.list()).some((t) => t.name === 'hudu_write')).toBe(false);
    await session.close();
  });
});

describe('share operations under HUDU_SECRET_READS=allow', () => {
  const open = { HUDU_WRITE_POLICY: 'all', HUDU_SECRET_READS: 'allow' } as const;

  it('listShares and getShare pass and mask the share url', async () => {
    for (const [, operation, input] of calls.slice(0, 2)) {
      const session = await connect(() => json(operation.endsWith('listShares') ? [SHARE] : SHARE), open);
      const result = await session.call('hudu_read', { operation, input });
      expect(result.isError).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('secret-token-never-returned');
      await session.close();
    }
  });

  it('createShare stays refused, dry-run included, and issues no request', async () => {
    for (const dry_run of [true, false]) {
      const session = await connect(() => json(SHARE), open);
      const result = await session.call('hudu_write', { operation: 'asset_passwords.createShare', input: calls[2][2], dry_run });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(/reveal/i);
      expect(session.urls).toEqual([]);
      await session.close();
    }
  });

  it('hudu_list_operations reports createShare unreachable with the reason', async () => {
    const session = await connect(undefined, open);
    const result = await session.call('hudu_describe_operation', { operation: 'asset_passwords.createShare' });
    expect(result.structuredContent.reachable).toBe(false);
    expect(result.structuredContent.why_not).toContain('reveal');
    await session.close();
  });

  it('an upstream error never re-adds a link to the envelope', async () => {
    const session = await connect(() => json({ error: `see ${LINK}` }, 500), open);
    const result = await session.call('hudu_read', { operation: 'asset_passwords.getShare', input: calls[1][2] });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret-token-never-returned');
    await session.close();
  });
});

describe('discovery names only tools this server serves', () => {
  it('asset_passwords.resolve / websites.resolve report no exposed_tool', async () => {
    const session = await connect(undefined, { HUDU_WRITE_POLICY: 'all', HUDU_SECRET_READS: 'allow' });
    const tools = new Set((await session.list()).map((t) => t.name));
    for (const operation of ['asset_passwords.resolve', 'websites.resolve']) {
      const described = await session.call('hudu_describe_operation', { operation });
      expect(described.structuredContent.exposed_tool).toBeNull();
      expect(described.content[0].text).not.toMatch(/use hudu_get_/);
    }
    const page = await session.call('hudu_list_operations', { limit: 100 });
    for (const row of page.structuredContent.rows) if (row.tool !== null) expect(tools.has(row.tool), row.op).toBe(true);
    await session.close();
  });
});

describe('createShare is refused by this server before any request', () => {
  it('under all + allow, even if the SDK client were revealing', async () => {
    const session = await connect(() => json(SHARE), { HUDU_WRITE_POLICY: 'all', HUDU_SECRET_READS: 'allow' });
    const result = await session.call('hudu_write', { operation: 'asset_passwords.createShare', input: { passwordId: 7, data: { expire_in: 60 } }, dry_run: false });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('never grants');
    expect(session.urls).toEqual([]);
    await session.close();
  });
});
