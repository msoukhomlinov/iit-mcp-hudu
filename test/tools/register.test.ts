/**
 * register.test.ts — the surface `registerTools` publishes. Pairs with `src/tools/register.ts`;
 * the catalogue-plan drift check (a `src/tools.ts` concern) lives in `test/tools.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATALOG, CORE_TOOLS } from 'node-hudu/mcp';
import { LIST_TOOLS } from '../../src/tools/lists.js';
import { connect } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

/** Every property name anywhere in a JSON Schema — descriptions are deliberately not searched. */
function propertyNames(schema: any, out: string[] = []): string[] {
  if (schema === null || typeof schema !== 'object') return out;
  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    out.push(name);
    propertyNames(sub, out);
  }
  propertyNames(schema.items, out);
  propertyNames(schema.additionalProperties, out);
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(schema[key])) for (const sub of schema[key]) propertyNames(sub, out);
  }
  return out;
}

describe('tool contract', () => {
  it('registers exactly the CORE profile plus the four dedicated list reads', async () => {
    const session = await connect();
    const names = (await session.list()).map((t) => t.name);
    // Set equality, not a count: a swapped name would pass a length check. LIST_TOOLS is derived
    // from the module that registers them, so a rename fails here rather than silently shipping.
    // Since node-hudu 0.12.0 the full SDK CORE profile is registered, `hudu_fetch_many` included:
    // the dedicated batch read coexists with the `hudu_read` dispatch of `operations.fetchMany`,
    // and both paths apply the secret-read policy to the batch's items.
    const expected = [...CORE_TOOLS, ...LIST_TOOLS];
    expect([...names].sort()).toEqual([...expected].sort());
    expect(names).toHaveLength(22);
    await session.close();
  });

  it('gives every tool both an inputSchema and an outputSchema', async () => {
    const session = await connect();
    for (const tool of await session.list()) {
      // structuredContent is only meaningful when the tool declares the shape it conforms to.
      expect(tool.inputSchema, tool.name).toBeTypeOf('object');
      expect(tool.outputSchema, tool.name).toBeTypeOf('object');
    }
    await session.close();
  });

  it('never asks a model for a credential', async () => {
    const session = await connect();
    for (const tool of await session.list()) {
      const fields = propertyNames(tool.inputSchema);
      expect(fields.filter((f) => /^(api_?key|token|password)$/i.test(f)), tool.name).toEqual([]);
    }
    await session.close();
  });

  it('lists no write or destructive tool', async () => {
    const session = await connect();
    const listed = new Set((await session.list()).map((t) => t.name));
    // Derived from the catalogue, so a future SDK release that promotes a write to a tool name is
    // caught here rather than by someone noticing it in a client.
    const writes = CATALOG.filter((r) => r.effect !== 'read' && r.tool).map((r) => r.tool);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.filter((t) => listed.has(t as string))).toEqual([]);
    await session.close();
  });
});

it('omits mutation tools in read-only mode, even when write policy is all', async () => {
  const session = await connect(undefined, { HUDU_READ_ONLY: true, HUDU_WRITE_POLICY: 'all' });
  try {
    const tools = await session.list();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['hudu_read']));
    expect(tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(['hudu_write']));
    expect(tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(['hudu_delete']));
    expect(tools.map((tool) => tool.name)).not.toContain('hudu_invoke');
    // hudu_fetch_many is a read: read-only mode keeps it.
    expect(tools.map((tool) => tool.name)).toContain('hudu_fetch_many');
    expect(tools).toHaveLength(20);
    for (const name of ['hudu_write', 'hudu_delete', 'hudu_invoke']) {
      expect((await session.call(name, { operation: 'companies.delete', input: { id: 1 } })).code).toBe(-32602);
    }
    expect(session.urls).toEqual([]);
  } finally { await session.close(); }
});

it('uses SDK operation enums and annotations for all three dispatchers', async () => {
  const { META_TOOLS } = await import('node-hudu/mcp');
  const session = await connect();
  try {
    const tools = await session.list();
    for (const name of ['hudu_read', 'hudu_write', 'hudu_delete']) {
      const spec = META_TOOLS.find((tool) => tool.name === name)!;
      const tool = tools.find((tool) => tool.name === name)!;
      expect(tool.annotations).toEqual(spec.annotations);
      expect(tool.inputSchema.properties.operation.enum).toEqual(spec.inputSchema.fields.operation?.enum);
    }
    expect(tools.find((tool) => tool.name === 'hudu_read')!.inputSchema.properties).not.toHaveProperty('dry_run');
  } finally { await session.close(); }
});
