/** dispatch-401.test.ts — the dispatcher's search branches keep the credential-shape view on a genuine vendor 401. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HuduClient } from 'node-hudu';
import { config, type Json } from '../helpers/mcp-session.js';
import { createLogger } from '../../src/logger.js';
import { runWithCredentialShapeView } from '../../src/tools/results.js';
import { registerDispatchTools } from '../../src/tools/dispatch.js';

afterEach(() => vi.unstubAllGlobals());

describe('dispatcher genuine-401 branches keep the credential-shape view', () => {
  const hudu401 = () => new Response(JSON.stringify({ error: 'Bad credentials' }), { status: 401, headers: { 'content-type': 'application/json' } });
  const LEGACY = { error: true, code: 'UNAUTHORIZED', httpStatus: 401, message: 'Bad credentials' };

  function readHandler() {
    vi.stubGlobal('fetch', async () => hudu401());
    let handler!: (args: Json) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
    const server = { registerTool: (name: string, _c: unknown, cb: typeof handler) => { if (name === 'hudu_read') handler = cb; } };
    const hudu = new HuduClient({ baseUrl: 'https://hudu.invalid', apiKey: 'valid-key-000', mode: 'read', retry: false } as never);
    registerDispatchTools(server as never, {
      hudu, config: { ...config, HUDU_WRITE_POLICY: 'deny' }, log: createLogger('error', () => {}),
      searchableResources: ['articles'], defaultSearchScope: ['articles'], bodySearchable: false, toolDefaultTier: 'vendor',
    } as never);
    return handler;
  }

  it.each([
    ['searchKnowledge', { operation: 'operations.searchKnowledge', input: { query: 'reset', opts: { tier: 'vendor', scope: ['articles'] } } }],
    ['searchAcross', { operation: 'operations.searchAcrossResources', input: { query: 'reset', opts: { resources: ['articles'], isolateErrors: true } } }],
  ])('%s: a genuine 401 is annotated with the presented anomalies, and legacy bytes without a view', async (_n, args) => {
    const handler = readHandler();
    const annotated = await runWithCredentialShapeView({ env: ['surrounding_single_quotes'] }, () => handler(args));
    expect(annotated.isError).toBe(true);
    const body = JSON.parse(annotated.content[0]!.text);
    expect(body).toMatchObject({ code: 'UNAUTHORIZED', httpStatus: 401, credentialShape: 'anomalous' });
    expect(body.anomalies).toEqual(['surrounding_single_quotes']);
    expect(JSON.parse((await handler(args)).content[0]!.text)).toEqual(LEGACY);
  });
});
