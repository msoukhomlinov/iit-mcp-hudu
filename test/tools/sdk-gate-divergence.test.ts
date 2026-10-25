/**
 * sdk-gate-divergence.test.ts — when the SDK's credential shape gate fires at client construction
 * after the server's own gate passed, the request fails closed with the typed credential refusal.
 */
import { describe, expect, it, vi } from 'vitest';
import { HuduConfigError } from 'node-hudu';
import { createLogger } from '../../src/logger.js';
import { errorContent } from '../../src/tools/results.js';
import { resolveHuduClient } from '../../src/tools/server.js';
import { config } from '../helpers/mcp-session.js';

describe('resolveHuduClient: SDK shape gate fires where the server gate passed', () => {
  it('returns the malformed placeholder plus a CREDENTIAL_MALFORMED refusal, and warns', () => {
    const placeholder = { tag: 'placeholder' };
    const entry = {
      parent: {}, noBase: {}, badBase: {}, baseRefused: {},
      scopes: { for: () => { throw new HuduConfigError('shape', { code: 'INVALID_CREDENTIAL_SHAPE' }); } },
      malformed: new Map(),
      buildPlaceholder: vi.fn(() => placeholder),
    };
    const lines: string[] = [];
    const ctx = { requestInfo: new Request('http://localhost/mcp', { headers: { 'x-hudu-api-key': 'clean-key-000', 'x-hudu-base-url': 'https://hudu.invalid' } }) };
    const out = resolveHuduClient(entry as never, { ...config, MCP_TRANSPORT: 'http', HUDU_BASE_URL: undefined, HUDU_API_KEY: undefined }, ctx as never, createLogger('warn', (l) => lines.push(l)));

    expect(out.client).toBe(placeholder);
    expect(entry.buildPlaceholder).toHaveBeenCalledOnce();
    expect(entry.malformed.get('')).toBe(placeholder);
    expect(JSON.parse(errorContent(out.refusal).content[0]!.text).code).toBe('CREDENTIAL_MALFORMED');
    expect(lines.join('')).toContain('the gates have diverged');
  });
});
