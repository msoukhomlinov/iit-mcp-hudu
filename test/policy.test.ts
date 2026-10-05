/**
 * policy.test.ts — the write policy's refusal contract, asserted directly.
 *
 * `tools.test.ts` proves the code reaches the model as `POLICY_DENIED` over the wire. This file
 * pins the fields `errorContent` deliberately drops (`retryable`, `suggestedAction`, `operation`),
 * so a future consumer that does read them finds the values the spec asks for.
 */
import { describe, expect, it } from 'vitest';
import { getCapability, type CapabilityRecord } from 'node-hudu/capabilities';
import { PolicyDeniedError } from 'node-hudu/errors';
import type { Config } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import {
  assertSecretReadPermitted,
  assertWritePermitted,
  isSecretOperation,
  operationPermitted,
} from '../src/policy.js';

const config = (override: Partial<Config> = {}): Config => ({
  HUDU_BASE_URL: 'https://hudu.invalid',
  HUDU_API_KEY: 'k',
  MCP_TRANSPORT: 'stdio',
  PORT: 8787,
  LOG_LEVEL: 'error',
  HUDU_READ_ONLY: false,
  HUDU_WRITE_POLICY: 'deny',
  HUDU_WRITE_ALLOW: [],
  HUDU_SECRET_READS: 'deny',
  ...override,
});

/** The refusal is asserted, not printed; a real sink would bury the suite's own failures. */
const silent = createLogger('error', () => {});

describe('assertWritePermitted', () => {
  it('throws PolicyDeniedError with retryable false and a do-not-retry suggestedAction', () => {
    try {
      assertWritePermitted('companies.update', getCapability('companies.update'), config(), silent);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyDeniedError);
      const err = e as PolicyDeniedError;
      expect(err.code).toBe('POLICY_DENIED');
      expect(err.retryable).toBe(false);
      expect(err.operation).toBe('companies.update');
      expect(err.suggestedAction).toMatch(/do not retry/i);
    }
  });

  it('allows a write the policy permits', () => {
    expect(() =>
      assertWritePermitted('companies.update', getCapability('companies.update'), config({ HUDU_WRITE_POLICY: 'all' }), silent),
    ).not.toThrow();
  });
});

describe('assertSecretReadPermitted', () => {
  it('refuses a credential read under the default deny, with the POLICY_DENIED contract', () => {
    try {
      assertSecretReadPermitted('asset_passwords.get', config(), silent);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyDeniedError);
      const err = e as PolicyDeniedError;
      expect(err.code).toBe('POLICY_DENIED');
      expect(err.retryable).toBe(false);
      expect(err.operation).toBe('asset_passwords.get');
      expect(err.suggestedAction).toMatch(/do not retry/i);
      expect(err.message).toMatch(/HUDU_SECRET_READS=deny/);
    }
  });

  it('covers password_folders as well as asset_passwords', () => {
    expect(() => assertSecretReadPermitted('password_folders.resolve', config(), silent)).toThrow(PolicyDeniedError);
  });

  it('permits the same read under allow', () => {
    expect(() =>
      assertSecretReadPermitted('asset_passwords.get', config({ HUDU_SECRET_READS: 'allow' }), silent),
    ).not.toThrow();
  });

  it('leaves non-credential reads alone', () => {
    expect(() => assertSecretReadPermitted('companies.get', config(), silent)).not.toThrow();
  });

  it('anchors the resource prefix on the dot, so a lookalike resource is not swept in', () => {
    expect(isSecretOperation('asset_passwords.get')).toBe(true);
    expect(isSecretOperation('asset_passwords_audit.list')).toBe(false);
  });
});

describe('the two policies are independent', () => {
  it('still refuses a credential read when the write policy is all', () => {
    // Different questions, different owners: an open write policy must not imply open secrets.
    expect(operationPermitted('asset_passwords.get', getCapability('asset_passwords.get'), config({ HUDU_WRITE_POLICY: 'all' }))).toBe(false);
  });

  it('still refuses a write when secret reads are allowed', () => {
    expect(operationPermitted('companies.update', getCapability('companies.update'), config({ HUDU_SECRET_READS: 'allow' }))).toBe(false);
  });
});

describe('deny fails closed', () => {
  it('refuses missing capability records', () => {
    expect(() => assertWritePermitted('future.operation', undefined, config(), silent)).toThrow(PolicyDeniedError);
  });
  it.each([null, undefined, 'future-effect'])('refuses effect %s', (effect) => {
    const record = { ...getCapability('api_info.get'), effect } as unknown as CapabilityRecord;
    expect(() => assertWritePermitted('api_info.get', record, config(), silent)).toThrow(PolicyDeniedError);
  });
});
