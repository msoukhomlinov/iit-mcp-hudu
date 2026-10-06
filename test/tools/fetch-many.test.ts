/**
 * fetch-many.test.ts — the dedicated `hudu_fetch_many` batch-read tool, driven over the wire
 * through the shared MCP-session harness (the real registered handler, the protocol-converted
 * schemas, Hudu stubbed at fetch).
 *
 * Pinned: the tool is registered in EVERY mode (it is a read) with the SDK's readOnlyHint and
 * both schemas; the per-item partial-failure envelope is served even when an item misses (one
 * wire request per item); a `fields` projection adds zero wire; every closed-shape violation is
 * refused at the schema layer with ZERO wire; a credential item is refused per item by the
 * deployment's secret-read policy BEFORE any request under the default deny (and logged), while
 * the same batch executes under allow; and the served 22-resource enum stays identical to the
 * registry record's `dependsOn` with the `.get` suffix stripped (the drift guard).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCapability } from 'node-hudu/capabilities';
import { FETCH_MANY_RESOURCES } from '../../src/tools/fetch-many.js';
import { connect } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

describe('hudu_fetch_many (the dedicated batch-read tool)', () => {
  it('is registered as a read-only tool in every mode, with both schemas', async () => {
    for (const readOnly of [false, true]) {
      const session = await connect(undefined, { HUDU_READ_ONLY: readOnly });
      const tool = (await session.list()).find((t) => t.name === 'hudu_fetch_many');
      expect(tool, `hudu_fetch_many in ${readOnly ? 'read-only' : 'default'} mode`).toBeDefined();
      expect(tool!.annotations?.readOnlyHint, 'readOnlyHint').toBe(true);
      // structuredContent is only meaningful when the tool declares the shape it conforms to.
      expect(tool!.inputSchema, 'inputSchema').toBeTypeOf('object');
      expect(tool!.outputSchema, 'outputSchema').toBeTypeOf('object');
      // The closed item list is the single top-level field; a read tool has no dry-run affordance.
      const shape = (tool!.inputSchema as { properties?: Record<string, unknown> }).properties;
      expect(shape, 'items').toHaveProperty('items');
      expect(shape, 'dry_run').not.toHaveProperty('dry_run');
      await session.close();
    }
  });

  it('fetches mixed resources in one call and serves the per-item envelope (partial failure is PER-ITEM, never all-or-nothing)', async () => {
    const session = await connect((url) => {
      if (url.endsWith('/companies/1')) return Response.json({ id: 1, name: 'Acme' });
      if (url.endsWith('/users/2')) return new Response('no such user', { status: 404, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/websites/3')) return Response.json({ id: 3, url: 'https://acme.com' });
      throw new Error(`unexpected url: ${url}`);
    });
    const result = await session.call('hudu_fetch_many', {
      items: [
        { resource: 'companies', id: 1 },
        { resource: 'users', id: 2 },
        { resource: 'websites', id: 3 },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.ok).toBe(2);
    expect(result.structuredContent.failed).toBe(1);
    const rows = result.structuredContent.results as Array<Record<string, any>>;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ resource: 'companies', id: 1, found: true });
    expect(rows[1]).toMatchObject({ resource: 'users', id: 2, found: false });
    expect(rows[1].error?.code).toBe('NOT_FOUND');
    expect(rows[2]).toMatchObject({ resource: 'websites', id: 3, found: true });
    // One wire call per item, through each resource's own get.
    expect(session.urls).toHaveLength(3);
    expect(session.urls[0]).toContain('/companies/1');
    expect(session.urls[1]).toContain('/users/2');
    expect(session.urls[2]).toContain('/websites/3');
    await session.close();
  });

  it('serves a client-side projection when fields are given (zero extra wire)', async () => {
    const session = await connect(() => Response.json({ id: 1, name: 'Acme', notes: 'secret' }));
    const result = await session.call('hudu_fetch_many', {
      items: [{ resource: 'companies', id: 1, fields: ['id', 'name'] }],
    });
    expect(result.isError).toBeUndefined();
    const row = (result.structuredContent.results as Array<Record<string, any>>)[0];
    expect(row.found).toBe(true);
    expect(row.value).toEqual({ id: 1, name: 'Acme' }); // notes dropped by the projection
    expect(session.urls).toHaveLength(1); // projection is post-fetch: no second request
    await session.close();
  });

  it('refuses a closed-shape violation at the schema layer with ZERO wire', async () => {
    const session = await connect();
    const violations: Array<[string, Json]> = [
      ['21 items (over the cap)', { items: Array.from({ length: 21 }, (_, i) => ({ resource: 'companies', id: i + 1 })) }],
      ['an empty fields projection', { items: [{ resource: 'companies', id: 1, fields: [] }] }],
      ['a negative id', { items: [{ resource: 'companies', id: -1 }] }],
      ['a resource outside the 22', { items: [{ resource: 'assets', id: 5 }] }],
      ['an item missing its resource', { items: [{ id: 5 }] }],
      ['items not an array', { items: { resource: 'companies', id: 1 } }],
    ];
    for (const [why, args] of violations) {
      const result = await session.call('hudu_fetch_many', args);
      // A schema-layer refusal: an isError result carrying the MCP SDK's validation message —
      // the handler (and therefore any request) is never reached.
      expect(result.isError, why).toBe(true);
      expect(result.content[0].text, why).toContain('Invalid arguments for tool hudu_fetch_many');
    }
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('refuses a credential item per the secret-read policy with zero wire, and logs the refusal (default deny)', async () => {
    // The session fixture defaults to HUDU_SECRET_READS=deny.
    const session = await connect();
    const result = await session.call('hudu_fetch_many', {
      items: [
        { resource: 'asset_passwords', id: 1 },
        { resource: 'companies', id: 1 },
      ],
    });
    expect(result.isError).toBe(true);
    const err = JSON.parse(result.content[0].text);
    expect(err.code).toBe('POLICY_DENIED');
    expect(err.message).toContain('HUDU_SECRET_READS=deny');
    // The refusal is pre-request: neither item of the batch went out.
    expect(session.urls).toEqual([]);
    // The refusal is logged: the operation key only, never the item.
    const refusal = session.logs.find((l) => l.msg === 'credential read refused by secret-read policy');
    expect(refusal).toBeDefined();
    expect(refusal.operation).toBe('asset_passwords.get');
    await session.close();
  });

  it('executes the same batch under HUDU_SECRET_READS=allow', async () => {
    const session = await connect(
      (url) => {
        if (url.endsWith('/asset_passwords/1')) return Response.json({ id: 1, name: 'admin-root' });
        if (url.endsWith('/companies/1')) return Response.json({ id: 1, name: 'Acme' });
        throw new Error(`unexpected url: ${url}`);
      },
      { HUDU_SECRET_READS: 'allow' },
    );
    const result = await session.call('hudu_fetch_many', {
      items: [
        { resource: 'asset_passwords', id: 1 },
        { resource: 'companies', id: 1 },
      ],
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.ok).toBe(2);
    expect(result.structuredContent.failed).toBe(0);
    expect(session.urls).toHaveLength(2);
    await session.close();
  });

  it('the served 22-resource enum is the registry record\'s dependsOn with the .get suffix stripped (drift guard)', () => {
    const record = getCapability('operations.fetchMany');
    expect(record).toBeDefined();
    const fromRegistry = (record!.dependsOn as readonly string[]).map((op) => op.replace(/\.get$/, ''));
    expect([...FETCH_MANY_RESOURCES].sort()).toEqual([...fromRegistry].sort());
    expect(FETCH_MANY_RESOURCES).toHaveLength(22);
  });
});
