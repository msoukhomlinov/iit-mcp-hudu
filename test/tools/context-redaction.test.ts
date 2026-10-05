/**
 * context-redaction.test.ts — the curated context reads never return an asset's custom-field
 * values (Password / ConfidentialText included); the SDK masks them under every HUDU_SECRET_READS
 * setting. Pairs with `src/tools/reads.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config.js';
const REDACTED_FIELD_VALUE = '[REDACTED]';
import { connect, type Json } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

/** Distinctive enough that a leak into any response or log is unmistakable. */
const PROBE = 'hunter2-probe';
const OTP = 'otp-probe';

const LAYOUT = {
  id: 7,
  name: 'Server',
  fields: [
    { id: 70, label: 'Admin PW', field_type: 'Password' },
    { id: 71, label: 'Recovery Key', field_type: 'ConfidentialText' },
    { id: 72, label: 'Hostname', field_type: 'Text' },
  ],
};

/** The API model's `fields[]` entry: `{ id, label, value, position }` — no field type on the row. */
const ASSET = {
  id: 5,
  company_id: 1,
  asset_layout_id: 7,
  name: 'srv-01',
  fields: [
    { id: 500, label: 'Admin PW', value: PROBE, position: 1 },
    { id: 501, label: 'recovery key ', value: OTP, position: 2 },
    { id: 502, label: 'Hostname', value: 'srv-01.example', position: 3 },
  ],
};

/** Stand-in Hudu: one asset, its layout, and empty lists for every other leg of a context read. */
function hudu(layoutStatus = 200) {
  return (url: string): Response => {
    const path = new URL(url).pathname.replace('/api/v1/', '');
    if (path === 'asset_layouts/7') {
      return layoutStatus === 200 ? Response.json({ asset_layout: LAYOUT }) : Response.json({ error: 'nope' }, { status: layoutStatus });
    }
    if (path === 'assets' || path === 'companies/1/assets') return Response.json({ assets: [ASSET] });
    if (path === 'companies/1') return Response.json({ company: { id: 1, name: 'Acme' } });
    // Hudu answers some list endpoints (expirations, relations) with a bare array.
    if (path === 'expirations' || path === 'relations') return Response.json([]);
    return Response.json({ [path.split('/').pop()!]: [] });
  };
}

async function read(tool: string, args: Json, override: Partial<Config> = {}, layoutStatus = 200) {
  const session = await connect(hudu(layoutStatus), override);
  const result = await session.call(tool, args);
  await session.close();
  return { result, session };
}

const CASES: Array<[string, Json, (r: Json) => Json]> = [
  ['hudu_get_asset_context', { identifier: 5, opts: { expand: true } }, (r) => r.structuredContent.context.asset],
  ['hudu_get_company_context', { id: 1, opts: { expand: true } }, (r) => r.structuredContent.context.assets[0]],
];

describe.each(CASES)('%s under HUDU_SECRET_READS=deny', (tool, args, assetOf) => {
  it('never returns a Password or ConfidentialText value', async () => {
    const { result } = await read(tool, args);
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(PROBE);
    expect(JSON.stringify(result)).not.toContain(OTP);
  });

  it('redacts unclassified values while retaining field labels', async () => {
    const { result } = await read(tool, args);
    const fields = assetOf(result).fields;
    expect(fields.map((f: Json) => f.value)).toEqual([REDACTED_FIELD_VALUE, REDACTED_FIELD_VALUE, REDACTED_FIELD_VALUE]);
    expect(fields.map((f: Json) => f.label)).toEqual(['Admin PW', 'recovery key ', 'Hostname']);
  });

  it('fails closed when the layout cannot be read', async () => {
    const { result } = await read(tool, args, {}, 500);
    expect(JSON.stringify(result)).not.toContain(PROBE);
    if (tool === 'hudu_get_asset_context') {
      // The SDK reads the layout itself as part of the context, so its failure fails the read.
      expect(result.isError).toBe(true);
      return;
    }
    // The SDK masks unclassified values without an extra layout request.
    expect(result.isError).toBeUndefined();
    const values = assetOf(result).fields.map((f: Json) => f.value);
    expect(values).toEqual([REDACTED_FIELD_VALUE, REDACTED_FIELD_VALUE, REDACTED_FIELD_VALUE]);
  });

  it('never logs secret values', async () => {
    const { session } = await read(tool, args);
    expect(JSON.stringify(session.logs)).not.toContain(PROBE);
  });

  it('keeps SDK masking under HUDU_SECRET_READS=allow', async () => {
    const { result } = await read(tool, args, { HUDU_SECRET_READS: 'allow' });
    expect(assetOf(result).fields[0].value).toBe(REDACTED_FIELD_VALUE);
  });
});

describe('summary reads', () => {
  it('spend no layout read on a non-expanded company context', async () => {
    // Summary rows carry no fields[]; classifying them would cost one Hudu request per layout.
    const session = await connect(hudu());
    await session.call('hudu_get_company_context', { id: 1 });
    await session.close();
    expect(session.urls.some((u) => u.includes('/asset_layouts/'))).toBe(false);
  });
});

