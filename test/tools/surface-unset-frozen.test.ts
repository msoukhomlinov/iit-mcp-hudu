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
  // Re-recorded for #62 (node-hudu#128, node-hudu 0.23.0): the one-sentence text-channel
  // tolerance was added to the hudu_read/hudu_write/hudu_delete descriptions — +543 B to the
  // write profiles and +181 B to the read-only profiles. The unset surface IS meant to change
  // (the sentence is served on every profile); every deployment's surface grows by exactly the
  // sentence, so no conditional tier clause leaked into the unset path.
  // Re-recorded for #64, then again after its review pass: the hudu_write description names both
  // article-body paths plus the explicit format 'html' edge, and the re-read sentence moved to the
  // README (net -6 B on the write profiles; the read-only profiles are untouched).
  'stdio-all': { sha: '5de6d43744a4a317', bytes: 28042 },
  'stdio-deny': { sha: '1c177d15cace4d8c', bytes: 22922 },
  'http-all': { sha: '2f8338d6229804f2', bytes: 27935 },
  'http-deny': { sha: 'b67ad71a74eed8cf', bytes: 22815 },
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
