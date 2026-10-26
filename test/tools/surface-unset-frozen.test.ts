/**
 * surface-unset-frozen.test.ts — the UNSET deployment's `tools/list`, frozen.
 *
 * The Typesense tier's promise is that an operator who never sets `HUDU_TYPESENSE_URL` /
 * `HUDU_TYPESENSE_API_KEY` sees no change at all. `surface-size.test.ts` bounds how big that surface
 * may get; this test pins WHAT it is: the exact bytes of the served `tools/list` JSON per transport
 * and write profile, hashed from the head of the env-wiring PR (node-hudu 0.21.0, before any tier
 * policy existed).
 *
 * A failure here means this branch changed a deployment that never configured the tier — a
 * conditional clause leaked into the unset path, or a description was edited on both paths instead
 * of only the configured one. Update the hashes ONLY when the unset surface is meant to change, and
 * say why in the commit message: this is the file that makes "byte-identical" checkable rather than
 * a claim.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { API_KEY, connect, connectForRequest } from '../helpers/mcp-session.js';

vi.mock('node:child_process', () => ({ spawnSync: () => ({}) }));

/**
 * sha256 (first 16 hex chars) / byte length of `JSON.stringify(await session.list())`, captured from
 * the env-wiring PR head (`4e9bf0b`) with no Typesense variable set.
 */
const FROZEN: Record<string, { sha: string; bytes: number }> = {
  'stdio-all': { sha: '7e9e21c89c75c872', bytes: 27469 },
  'stdio-deny': { sha: '55c100d3768e4355', bytes: 22741 },
  'http-all': { sha: 'ec0299e560e6946d', bytes: 27362 },
  'http-deny': { sha: '849e938f10b75644', bytes: 22634 },
};

async function served(transport: 'stdio' | 'http', policy: 'all' | 'deny') {
  const override = { HUDU_WRITE_POLICY: policy } as const;
  const session = transport === 'stdio'
    ? await connect(undefined, override)
    : // Listing needs no Hudu call; a fetch here would be a bug, so the stub refuses.
      await connectForRequest(API_KEY, () => {
        throw new Error('unexpected network call');
      }, [], override);
  const json = JSON.stringify(await session.list());
  await session.close();
  return {
    sha: createHash('sha256').update(json).digest('hex').slice(0, 16),
    bytes: Buffer.byteLength(json, 'utf8'),
  };
}

describe('an unset deployment serves exactly the surface it served before the tier', () => {
  for (const transport of ['stdio', 'http'] as const) {
    for (const policy of ['all', 'deny'] as const) {
      const key = `${transport}-${policy}`;
      it(`${key}: ${FROZEN[key].bytes} bytes, hash ${FROZEN[key].sha}`, async () => {
        expect(await served(transport, policy)).toEqual(FROZEN[key]);
      });
    }
  }
});
