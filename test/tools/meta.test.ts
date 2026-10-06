/** Catalog and describe integration tests for src/tools/meta.ts. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config.js';
import { getCapability } from 'node-hudu/capabilities';
import { CATALOG, describeOperation, CORE_TOOLS, SEARCH_RESOURCES } from 'node-hudu/mcp';
import { LIST_TOOLS } from '../../src/tools/lists.js';
import { connect } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

describe('meta discovery and credential tool surface', () => {
  const deny = { HUDU_WRITE_POLICY: 'deny' } as const;

  it('refuses the curated credential tools over the wire, issuing no request', async () => {
    // The exposure this closes: these two are ordinary reads, so no write policy ever touched them,
    // and `expand: true` returns `password` and `otp_secret` in plaintext.
    const session = await connect();
    for (const [tool, args] of [
      ['hudu_find_asset_passwords_by_slug', { slug: 'admin-root', opts: { expand: true } }],
      ['hudu_get_password_folder', { identifier: 'shared', opts: { expand: true } }],
    ] as const) {
      const refused = await session.call(tool, args);
      expect(refused.isError, tool).toBe(true);
      const err = JSON.parse(refused.content[0].text);
      expect(err.code, tool).toBe('POLICY_DENIED');
      expect(err.message, tool).toContain('HUDU_SECRET_READS=deny');
    }
    // No request was issued: the refusal happens before Hudu is ever reached.
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('leaves the curated credential tools working under allow', async () => {
    const session = await connect(
      () => new Response(JSON.stringify({ asset_passwords: [{ id: 7, name: 'admin-root', password: 's3cret' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      { HUDU_SECRET_READS: 'allow' },
    );
    const result = await session.call('hudu_find_asset_passwords_by_slug', { slug: 'admin-root' });
    expect(result.isError).toBeUndefined();
    expect(session.urls.length).toBeGreaterThan(0);
    await session.close();
  });

  it('hudu_list_operations reflects deny: refused rows go unreachable and the global counts move', async () => {
    const session = await connect(undefined, deny);
    const result = await session.call('hudu_list_operations', { effect: 'destructive', limit: 100 });
    const row = result.structuredContent.rows.find((r: Json) => r.op === 'companies.delete');
    expect(row.reachable).toBe(false);
    expect(row.reason).toContain('HUDU_WRITE_POLICY=deny');
    // SDK callable rows plus four bounded wrappers, narrowed by deployment policy.
    // 0.9.2 -> 0.12.0: +1 reachable row (operations.fetchMany, a read; the batch's credential
    // items are refused per item by the fetchMany policy, not per row). The +1 is anchored to
    // the row by identity below, so a different row changing could not keep this delta honest.
    expect(CATALOG.some((row) => row.op === 'operations.fetchMany')).toBe(true);
    expect(result.structuredContent.reachable_operations).toBe(88);
    expect(result.structuredContent.unreachable_operations).toBe(140);
    await session.close();
  });

  it('hudu_list_operations under all leaves the same row reachable', async () => {
    const session = await connect(undefined, { HUDU_WRITE_POLICY: 'all' });
    const result = await session.call('hudu_list_operations', { effect: 'destructive', limit: 100 });
    const row = result.structuredContent.rows.find((r: Json) => r.op === 'companies.delete');
    expect(row.reachable).toBe(true);
    // `all` opens the write surface but not the credential one: the reachable
    // asset_passwords/password_folders rows stay refused under the secret-read default.
    // 0.9.2 -> 0.12.0: +1 reachable row (operations.fetchMany, a read).
    expect(result.structuredContent.reachable_operations).toBe(165);
    expect(result.structuredContent.unreachable_operations).toBe(63);
    await session.close();
  });

  it('hudu_list_operations under all AND allow restores the full surface', async () => {
    // The remaining credential-resource rows become reachable, with SDK masking retained.
    const session = await connect(undefined, { HUDU_WRITE_POLICY: 'all', HUDU_SECRET_READS: 'allow' });
    const result = await session.call('hudu_list_operations', { effect: 'destructive', limit: 100 });
    // 0.9.2 -> 0.12.0: +1 reachable row (operations.fetchMany, a read).
    expect(result.structuredContent.reachable_operations).toBe(180);
    expect(result.structuredContent.unreachable_operations).toBe(48);
    await session.close();
  });

  it('hudu_describe_operation reflects the policy, and leaves all alone', async () => {
    const denied = await connect(undefined, deny);
    const refused = await denied.call('hudu_describe_operation', { operation: 'companies.delete' });
    expect(refused.structuredContent.reachable).toBe(false);
    expect(refused.structuredContent.why_not).toContain('HUDU_WRITE_POLICY=deny');
    await denied.close();

    const allowed = await connect(undefined, { HUDU_WRITE_POLICY: 'all' });
    const reachable = await allowed.call('hudu_describe_operation', { operation: 'companies.delete' });
    expect(reachable.structuredContent.reachable).toBe(true);
    await allowed.close();
  });

  it('steers operations.fetchMany to the dedicated hudu_fetch_many tool', async () => {
    const session = await connect();
    const result = await session.call('hudu_describe_operation', { operation: 'operations.fetchMany' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.exposed_tool).toBe('hudu_fetch_many');
    expect(result.structuredContent.why_not).toBeNull();
    expect(result.structuredContent.reachable).toBe(true);
    // The describe presents the tool's own argument set, not the operation's.
    expect(Object.keys(result.structuredContent.input_schema).sort()).toEqual(['items']);
    expect(result.content[0].text).toContain('use hudu_fetch_many');
    await session.close();
  });

  it('never changes tools/list, in any mode', async () => {
    for (const policy of ['deny', 'allow_list', 'all'] as const) {
      const session = await connect(
        undefined,
        policy === 'allow_list' ? { HUDU_WRITE_POLICY: policy, HUDU_WRITE_ALLOW: ['articles.update'] } : { HUDU_WRITE_POLICY: policy },
      );
      const names = (await session.list()).map((t) => t.name);
      // The full SDK CORE profile is registered — `hudu_fetch_many` included (0.12.0); it is a
      // read, so no write policy changes the surface.
      const expected = [...CORE_TOOLS, ...LIST_TOOLS];
      expect([...names].sort(), policy).toEqual(expected.sort());
      expect(names, policy).toHaveLength(22);
      await session.close();
    }
  });
});

describe('hudu_describe_operation search policy', () => {
  it('narrows the searchKnowledge schema and defaults to the deployment policy', async () => {
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['companies'] });
    const d = (await session.call('hudu_describe_operation', { operation: 'operations.searchKnowledge' })).structuredContent;
    const scope = d.input_schema.opts.fields.find((f: Json) => f.name === 'scope');
    expect(scope.items.enum).toEqual(['companies']);
    expect(d.usage).not.toContain('scope defaults to articles and assets');
    expect(d.usage).toContain('scope defaults to ["companies"]');
    expect(d.usage).not.toContain('defaults to tier "index"');
    expect(d.usage).toContain('defaults to tier "vendor"');
    expect(d.purpose).not.toContain('articles first and assets second');
    expect(d.purpose).toContain('companies');
    expect(d.preferred_when).not.toContain('a phrase in an article body');
    await session.close();
  });

  it('narrows the searchKnowledge catalog row prose', async () => {
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['companies'] });
    const result = await session.call('hudu_list_operations', { resource: 'operations', limit: 100 });
    const row = result.structuredContent.rows.find((r: Json) => r.op === 'operations.searchKnowledge');
    expect(row.summary).not.toContain('articles first and assets second');
    expect(row.summary).toContain('companies');
    expect(row.when).not.toContain('a phrase in an article body');
    await session.close();
  });

  it('leaves the searchKnowledge description verbatim when the policy changes nothing', async () => {
    const session = await connect();
    const d = (await session.call('hudu_describe_operation', { operation: 'operations.searchKnowledge' })).structuredContent;
    const scope = d.input_schema.opts.fields.find((f: Json) => f.name === 'scope');
    expect(scope.items.enum).toHaveLength(8);
    expect(d.usage).toContain('scope defaults to articles and assets');
    expect(d.usage).toContain('defaults to tier "index"');
    expect(d.purpose).toContain('articles first and assets second');
    await session.close();
  });

  it('narrows the resolveAny schema to the deployment search set', async () => {
    // hudu_resolve_any and its hudu_read parity reject an excluded resource, so discovery must
    // not advertise the SDK's full eight for the same operation.
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['companies', 'users'] });
    const d = (await session.call('hudu_describe_operation', { operation: 'operations.resolveAny' })).structuredContent;
    const resources = d.input_schema.opts.fields.find((f: Json) => f.name === 'resources');
    expect(resources.items.enum).toEqual(['companies', 'users']);
    await session.close();
  });

  it('leaves the resolveAny schema verbatim when the policy changes nothing', async () => {
    const session = await connect();
    const d = (await session.call('hudu_describe_operation', { operation: 'operations.resolveAny' })).structuredContent;
    const resources = d.input_schema.opts.fields.find((f: Json) => f.name === 'resources');
    expect(resources.items.enum).toHaveLength(8);
    await session.close();
  });
});

describe('searchAcrossResources discovery matches execution', () => {
  const publicResources = SEARCH_RESOURCES.searchable.map((r) => r.resource)
    .filter((r) => !['asset_passwords', 'password_folders'].includes(r));
  it.each<[string, Partial<Config>, string[]]>([
    ['default secret deny', {}, publicResources],
    ['narrowed secret deny', { HUDU_SEARCH_RESOURCES: ['companies', 'asset_passwords'] }, ['companies']],
    ['narrowed secret allow', { HUDU_SEARCH_RESOURCES: ['companies', 'asset_passwords'], HUDU_SECRET_READS: 'allow' }, ['companies', 'asset_passwords']],
    ['credential-only deny', { HUDU_SEARCH_RESOURCES: ['asset_passwords', 'password_folders'] }, []],
    ['full secret allow', { HUDU_SECRET_READS: 'allow' }, SEARCH_RESOURCES.searchable.map((r) => r.resource)],
  ])('%s advertises only permitted resources and the actual default', async (_name, config, expected) => {
    const session = await connect(undefined, config);
    try {
      const d = (await session.call('hudu_describe_operation', { operation: 'operations.searchAcrossResources' })).structuredContent;
      const resources = d.input_schema.opts.fields.find((f: Json) => f.name === 'resources');
      expect(resources.items.enum).toEqual(expected);
      expect(resources.default).toEqual(expected);
      expect(d.usage).toContain(`resources defaults to ${JSON.stringify(expected)}`);
      expect(session.urls).toEqual([]);
    } finally {
      await session.close();
    }
  });
});

describe('credential operation schema discovery', () => {
  it.each(['asset_passwords.create', 'asset_passwords.update'])('%s retains the SDK input schema', async (operation) => {
    const session = await connect(undefined, { HUDU_READ_ONLY: false, HUDU_WRITE_POLICY: 'all', HUDU_SECRET_READS: 'allow' });
    try {
      const result = await session.call('hudu_describe_operation', { operation });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent.input_schema).toEqual(describeOperation(getCapability(operation)!).input_schema);
      expect(JSON.parse(result.content[0].text).trust).toBe('untrusted_data');
      expect(session.urls).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
