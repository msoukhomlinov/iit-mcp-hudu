/**
 * The read-only Hudu profile used by Cortex's general-purpose roles (Hudu, Research).
 *
 * The profile is a deployment, not a code path: `HUDU_READ_ONLY=true`, `HUDU_WRITE_POLICY=deny`,
 * `HUDU_SECRET_READS=deny`. These tests build the server from that exact environment through
 * `loadConfig` and prove, over the wire, that mutation and credential reads are refused with zero
 * Hudu requests. They also pin that the profile is the shipped default, so the existing consumers
 * (the published Hudu Reader surface) see the same server.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { connect } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

const base = { HUDU_BASE_URL: 'https://hudu.invalid', HUDU_API_KEY: 'k' };
const profileEnv = { ...base, HUDU_READ_ONLY: 'true', HUDU_WRITE_POLICY: 'deny', HUDU_SECRET_READS: 'deny' };

describe('read-only profile', () => {
  it('is exactly what an unconfigured deployment already runs (existing consumers unchanged)', () => {
    const explicit = loadConfig(profileEnv);
    const defaults = loadConfig(base);
    expect(explicit).toEqual(defaults);
    expect([defaults.HUDU_READ_ONLY, defaults.HUDU_WRITE_POLICY, defaults.HUDU_SECRET_READS]).toEqual([true, 'deny', 'deny']);
  });

  it('lists no mutation tool, and the mutation dispatchers do not exist', async () => {
    const session = await connect(undefined, loadConfig(profileEnv));
    try {
      const names = (await session.list()).map((t) => t.name);
      expect(names).toContain('hudu_read');
      for (const name of ['hudu_write', 'hudu_delete', 'hudu_invoke']) {
        expect(names).not.toContain(name);
        expect((await session.call(name, { operation: 'companies.delete', input: { id: 1 }, confirm: 'companies.delete' })).code).toBe(-32602);
      }
      expect(session.urls).toEqual([]);
    } finally { await session.close(); }
  });

  it('refuses a mutation through hudu_read before any request', async () => {
    const session = await connect(undefined, loadConfig(profileEnv));
    try {
      for (const operation of ['companies.update', 'companies.delete', 'asset_passwords.create']) {
        const result = await session.call('hudu_read', { operation, input: { id: 1 } });
        expect(result.isError, operation).toBe(true);
        // hudu_read's operation enum holds only read operations, so a mutation key never reaches the policy.
        expect(result.content[0].text, operation).toContain('Input validation error');
      }
      expect(session.urls).toEqual([]);
    } finally { await session.close(); }
  });

  it('refuses credential reads with POLICY_DENIED before any request', async () => {
    const session = await connect(undefined, loadConfig(profileEnv));
    try {
      let credentialDenied = 0;
      for (const operation of ['asset_passwords.get', 'asset_passwords.list', 'password_folders.get', 'password_folders.list']) {
        const result = await session.call('hudu_read', { operation, input: { id: 1 } });
        expect(result.isError, operation).toBe(true);
        // Either the policy refuses it (POLICY_DENIED) or the operation is not a read at all (schema).
        const text: string = result.content[0].text;
        expect(text.includes('Input validation error') || JSON.parse(text).code === 'POLICY_DENIED', operation).toBe(true);
        credentialDenied += text.includes('POLICY_DENIED') ? 1 : 0;
      }
      expect(credentialDenied).toBeGreaterThan(0);
      expect(session.urls).toEqual([]);
    } finally { await session.close(); }
  });

  it('still serves an ordinary read (the profile narrows, it does not break)', async () => {
    const session = await connect(() => Response.json({ version: '2.45.1' }), loadConfig(profileEnv));
    try {
      const result = await session.call('hudu_read', { operation: 'api_info.get' });
      expect(result.isError).toBeUndefined();
      expect(session.urls).toHaveLength(1);
    } finally { await session.close(); }
  });
});
