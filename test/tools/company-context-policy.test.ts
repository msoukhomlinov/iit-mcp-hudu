import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { redactCompanyContextCredentials } from '../../src/tools/company-context-policy.js';
import { config } from '../helpers/mcp-session.js';
import { PASSWORD_ROW, SAFE_ROW } from '../helpers/company-context-fixture.js';

const silent = createLogger('error', () => {});
const project = (context: unknown) => redactCompanyContextCredentials(context, 'companies.getContext', config, silent);

describe('company context summary policy', () => {
  it('drops unknown fields without mutating the SDK result or logging their values', () => {
    const logs: string[] = [];
    const context = { company: { id: 1 }, assetPasswords: [PASSWORD_ROW] };
    const result = redactCompanyContextCredentials(context, 'companies.getContext', config, createLogger('warn', (line) => logs.push(line)));
    expect(result).toEqual({ company: { id: 1 }, assetPasswords: [SAFE_ROW] });
    expect(context.assetPasswords[0]).toBe(PASSWORD_ROW);
    expect(JSON.parse(logs[0]!)).toMatchObject({ operation: 'companies.getContext', policy: 'deny', records: 1 });
    expect(logs.join('')).not.toContain(PASSWORD_ROW.description);
    expect(logs.join('')).not.toContain(PASSWORD_ROW.password);
  });

  it('drops malformed password rows and collections', () => {
    expect(project({ assetPasswords: [null, 'x', [], { id: 2, description: 'private' }] })).toEqual({ assetPasswords: [{ id: 2 }] });
    expect(project({ assetPasswords: { description: 'private' } })).toEqual({ assetPasswords: [] });
  });

  it('leaves unrelated contexts and the allow policy to SDK redaction', () => {
    const plain = { article: { id: 1 } };
    expect(project(plain)).toBe(plain);
    expect(project(null)).toBeNull();
    const context = { assetPasswords: [PASSWORD_ROW] };
    expect(redactCompanyContextCredentials(context, 'companies.getContext', { ...config, HUDU_SECRET_READS: 'allow' }, silent)).toBe(context);
  });
});
