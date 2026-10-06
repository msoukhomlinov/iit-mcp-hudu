/**
 * dedicated.test.ts — the dedicated-list-tool overlay for `hudu_list_operations` / `hudu_describe_operation`.
 *
 * The defect: the SDK catalogue publishes `assets.list` / `assets.listAcrossCompanies`
 * (and the other list reads this server serves) as `tool: null`, "reachable through hudu_read", so
 * a read-only prompt could route a read through the approval-gated escape hatch and stall. These
 * cases pin the corrected discovery surface.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATALOG } from 'node-hudu/mcp';
import {
  DEDICATED_READ_TOOLS,
  DEDICATED_READ_TOOL_BY_OPERATION,
} from '../../src/tools/dedicated.js';
import { connect } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

/** The catalogue's own unexposed count, before the overlay re-labels anything. */
const SDK_UNEXPOSED = CATALOG.filter((row) => row.reachable === true && row.tool === null).length;
// The four list rows are unreachable in the SDK catalogue (the overlay RESTORES them, which
// moves the reachable counts, not the unexposed one). `operations.fetchMany` is reachable and
// tool-less there, so the overlay re-labels exactly that one row.
const RE_LABELLED = 1;

describe('dedicated read-tool mapping', () => {
  it('matches the tools this server actually registers, by their own backing-operation metadata', async () => {
    const session = await connect();
    const byName = new Map((await session.list()).map((t) => [t.name, t]));
    for (const [tool, spec] of Object.entries(DEDICATED_READ_TOOLS)) {
      const registered = byName.get(tool);
      expect(registered, tool).toBeDefined();
      expect(registered!._meta?.backingOperation, tool).toBe(spec.backingOperation);
      expect(registered!._meta?.requiresApproval, tool).toBe(false);
      // The describe presents the tool's own argument set, so it must be exactly this list.
      expect([...Object.keys(registered!.inputSchema.properties)].sort(), tool).toEqual(
        [...(spec.toolArguments as readonly string[])].sort(),
      );
    }
    await session.close();
  });

  it('maps every covered operation back to its own tool', () => {
    for (const [tool, spec] of Object.entries(DEDICATED_READ_TOOLS)) {
      for (const op of spec.covers) {
        expect(DEDICATED_READ_TOOL_BY_OPERATION[op], op).toBe(tool);
      }
    }
  });
});

describe('hudu_describe_operation steers a mapped read to its ungated tool', () => {
  it.each([
    ['assets.listAcrossCompanies', 'hudu_list_assets'],
    ['companies.list', 'hudu_list_companies'],
    ['articles.list', 'hudu_list_articles'],
    ['asset_layouts.list', 'hudu_list_asset_layouts'],
    ['operations.fetchMany', 'hudu_fetch_many'],
  ])('%s names %s instead of hudu_read', async (operation, tool) => {
    const session = await connect();
    const result = await session.call('hudu_describe_operation', { operation });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.exposed_tool).toBe(tool);
    expect(result.structuredContent.why_not).toBeNull();
    expect(result.structuredContent.reachable).toBe(true);
    expect(result.content[0].text).toContain(`use ${tool}`);
    expect(result.content[0].text).not.toContain('hudu_read');
    await session.close();
  });

  it('presents the dedicated tool schema, not the operation schema', async () => {
    // assets.listAcrossCompanies accepts `include`; hudu_list_assets does not. The describe must
    // present the tool's arguments so a caller cannot supply one the tool would silently strip.
    const session = await connect();
    const d = (await session.call('hudu_describe_operation', { operation: 'assets.listAcrossCompanies' })).structuredContent;
    expect(Object.keys(d.input_schema)).not.toContain('include');
    expect(d.input_schema.company_id).toBeDefined();
    expect(d.example).toBeNull();
    expect(d.preferred_when).toContain('hudu_list_assets');
    await session.close();
  });

  it('does not steer assets.list to hudu_list_assets, whose arguments differ', async () => {
    // assets.list takes { companyId, params }; hudu_list_assets takes a flat company_id. Advertising
    // the tool here would let a caller follow the shown schema and issue an unscoped request.
    const session = await connect();
    const result = await session.call('hudu_describe_operation', { operation: 'assets.list' });
    expect(result.structuredContent.exposed_tool).toBeNull();
    expect(result.structuredContent.why_not).toContain('hudu_read');
    expect(result.content[0].text).not.toContain('hudu_list_assets');
    await session.close();
  });

  it('leaves a long-tail read with no tool of its own pointing at hudu_read', async () => {
    const longTail = CATALOG.find(
      (row) => row.reachable === true && row.tool === null && !(row.op in DEDICATED_READ_TOOL_BY_OPERATION),
    );
    expect(longTail, 'no unexposed long-tail read to check').toBeDefined();
    const session = await connect();
    const result = await session.call('hudu_describe_operation', { operation: longTail!.op });
    expect(result.structuredContent.exposed_tool).toBeNull();
    expect(result.structuredContent.why_not).toContain('hudu_read');
    await session.close();
  });
});

describe('hudu_list_operations advertises the dedicated tool on the mapped rows', () => {
  it('re-labels the operations.fetchMany row with hudu_fetch_many', async () => {
    const session = await connect();
    const result = await session.call('hudu_list_operations', { resource: 'operations', limit: 100 });
    const row = result.structuredContent.rows.find((r: Json) => r.op === 'operations.fetchMany');
    expect(row).toBeDefined();
    expect(row.tool).toBe('hudu_fetch_many');
    expect(row.reachable).toBe(true);
    expect(row.reason ?? '').not.toContain('hudu_read');
    await session.close();
  });

  it('re-labels the asset list row and drops the hudu_read reason', async () => {
    const session = await connect();
    const result = await session.call('hudu_list_operations', { resource: 'assets', limit: 100 });
    const row = result.structuredContent.rows.find((r: Json) => r.op === 'assets.listAcrossCompanies');
    expect(row).toBeDefined();
    expect(row.tool).toBe('hudu_list_assets');
    expect(row.reason ?? '').not.toContain('hudu_read');
    // assets.list keeps its tool-less row: its arguments do not match the dedicated tool.
    const scoped = result.structuredContent.rows.find((r: Json) => r.op === 'assets.list');
    expect(scoped.tool).toBeNull();
    expect(scoped.reason).toContain('hudu_read');
    await session.close();
  });

  it('moves the global unexposed count by the number of re-labelled rows', async () => {
    const session = await connect();
    const result = await session.call('hudu_list_operations', { limit: 1 });
    expect(result.structuredContent.unexposed_operations).toBe(SDK_UNEXPOSED - RE_LABELLED);
    await session.close();
  });

  it('never lists a re-labelled row as unexposed', async () => {
    const session = await connect();
    const result = await session.call('hudu_list_operations', { unexposed_only: true, limit: 100 });
    const ops = result.structuredContent.rows.map((r: Json) => r.op);
    for (const op of Object.keys(DEDICATED_READ_TOOL_BY_OPERATION)) {
      expect(ops, op).not.toContain(op);
    }
    // Every row the filter does return is genuinely tool-less.
    for (const row of result.structuredContent.rows) expect(row.tool).toBeNull();
    await session.close();
  });

  it('paginates unexposed_only over one stable corrected set, with no gap or duplicate', async () => {
    // The mapped rows are removed from the source collection, not the already-sliced page, so a
    // client advancing by offset sees each remaining row exactly once and `matched` never moves.
    const session = await connect();
    const first = await session.call('hudu_list_operations', { unexposed_only: true, limit: 20 });
    const second = await session.call('hudu_list_operations', { unexposed_only: true, limit: 20, offset: first.structuredContent.rows.length });
    expect(first.structuredContent.matched).toBe(SDK_UNEXPOSED - RE_LABELLED);
    expect(second.structuredContent.matched).toBe(first.structuredContent.matched);
    expect(first.structuredContent.has_more).toBe(true);
    expect(second.structuredContent.has_more).toBe(false);
    const ops = [...first.structuredContent.rows, ...second.structuredContent.rows].map((r: Json) => r.op);
    expect(ops).toHaveLength(first.structuredContent.matched);
    expect(new Set(ops).size).toBe(ops.length);
    await session.close();
  });
});

describe('a policy-refused operation reports the refusal, not a tool steer', () => {
  it('names the refusal before any exposed tool', async () => {
    // `companies.delete` has an exposed tool, but under deny the policy sets reachable: false.
    // The text line must report the refusal rather than steer to a guaranteed policy failure.
    const session = await connect(undefined, { HUDU_WRITE_POLICY: 'deny' });
    const result = await session.call('hudu_describe_operation', { operation: 'companies.delete' });
    expect(result.structuredContent.reachable).toBe(false);
    expect(result.content[0].text).toContain('NOT callable here');
    expect(result.content[0].text).not.toContain('use hudu_');
    await session.close();
  });
});

describe('a narrowed HUDU_SEARCH_RESOURCES is honoured before advertising', () => {
  it('does not name a dedicated tool whose resource this deployment excluded', async () => {
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['articles'] });
    // companies is excluded, so hudu_list_companies would be refused before any request.
    const companies = await session.call('hudu_describe_operation', { operation: 'companies.list' });
    expect(companies.structuredContent.exposed_tool).toBeNull();
    expect(companies.content[0].text).not.toContain('hudu_list_companies');
    // asset_layouts is not searchable and is never gated, so its tool stays advertised.
    const layouts = await session.call('hudu_describe_operation', { operation: 'asset_layouts.list' });
    expect(layouts.structuredContent.exposed_tool).toBe('hudu_list_asset_layouts');
    // operations is not a search scope either: the batch tool is advertised even when narrowed.
    const batch = await session.call('hudu_describe_operation', { operation: 'operations.fetchMany' });
    expect(batch.structuredContent.exposed_tool).toBe('hudu_fetch_many');
    await session.close();
  });

  it('leaves an excluded row tool-less in the catalogue and keeps the unexposed count honest', async () => {
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['articles'] });
    const page = await session.call('hudu_list_operations', { limit: 1 });
    // Only articles.list and asset_layouts.list are advertised here; companies/assets are not —
    // but hudu_fetch_many is never search-gated, so its row is still re-labelled.
    expect(page.structuredContent.unexposed_operations).toBe(SDK_UNEXPOSED - RE_LABELLED);
    const assets = await session.call('hudu_list_operations', { resource: 'assets', limit: 100 });
    const row = assets.structuredContent.rows.find((r: Json) => r.op === 'assets.listAcrossCompanies');
    expect(row.tool).toBeNull();
    expect(row.reason).toContain('hudu_read');
    await session.close();
  });
});
