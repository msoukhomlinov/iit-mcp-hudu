/**
 * text-channel-tolerance.test.ts — regression gate for the node-hudu text-channel tolerance
 * (node-hudu#128; this repo #62). node-hudu 0.23.0 coerces an exact-literal scalar ("61") to its
 * scalar (61) before validation and dispatch, so a text-channel host that quotes every scalar
 * reads the same record; 0.22.0 refused the quoted id. This test FAILS against the 0.22.0
 * install and pins the behaviour change the dependency bump makes live.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

describe('hudu_read text-channel tolerance (node-hudu#128 / #62)', () => {
  it('dispatches a quoted exact-literal id as its scalar: companies.get id "61" -> GET /companies/61', async () => {
    const session = await connect(() => Response.json({ company: { id: 61, name: 'Acme' } }));
    try {
      const result = await session.call('hudu_read', { operation: 'companies.get', input: { id: '61' } });
      expect(result.isError, JSON.stringify(result)).toBeUndefined();
      // The proof it dispatched is the request, not merely the absence of an error.
      expect(session.urls).toHaveLength(1);
      expect(session.urls.some((u) => u.includes('/companies/61'))).toBe(true);
      expect(session.methods[0]).toBe('GET');
      // The same record an unquoted id returns.
      expect(JSON.stringify(result.structuredContent)).toContain('Acme');
    } finally {
      await session.close();
    }
  });

  it('refuses a non-literal quoted id with the type message, before any request', async () => {
    const session = await connect(undefined);
    try {
      const result = await session.call('hudu_read', { operation: 'companies.get', input: { id: 'abc' } });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).message).toContain('expected integer, got string');
      expect(session.urls).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
