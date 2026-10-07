/**
 * credential.test.ts — the shape gate itself: what is an anomaly, and what the metadata leaks.
 *
 * The incident this defends against (2026-10-07 Autotask): a single-quoted `.env` value whose
 * secret contained `$` was fed to the wire with its quotes intact by a quote-preserving parser, and
 * the opaque 401 that came back was read as a bad credential. The first case below is that exact
 * value shape.
 */
import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_ANOMALIES,
  describeCredential,
  detectCredentialShape,
  isFatalAnomaly,
  reportCredential,
} from '../src/credential.js';

describe('credential shape detection', () => {
  it('accepts a clean key: no anomalies, and none of the value is echoed', () => {
    expect(detectCredentialShape('eyJhbGciOiJIUzI1NiJ9.payload.sig')).toEqual([]);
    expect(detectCredentialShape('test-key')).toEqual([]);
  });

  it('flags the incident: single quotes preserved around the value', () => {
    // The literal bytes the quote-preserving parser produced on 2026-10-07.
    expect(detectCredentialShape("'a$b c'")).toEqual(['surrounding_single_quotes', 'embedded_quotes']);
  });

  it('flags surrounding double quotes, and a lone embedded quote', () => {
    expect(detectCredentialShape('"a$b"')).toEqual(['surrounding_double_quotes', 'embedded_quotes']);
    expect(detectCredentialShape("ab'cd")).toEqual(['embedded_quotes']);
  });

  it('flags CR and LF contamination from a Windows-edited .env', () => {
    expect(detectCredentialShape('key\r')).toEqual(['carriage_return', 'edge_whitespace']);
    expect(detectCredentialShape('key\r\n')).toEqual(['carriage_return', 'newline', 'edge_whitespace']);
    expect(detectCredentialShape('ke\ny')).toEqual(['newline']);
  });

  it('flags edge whitespace, which is invisible in every editor', () => {
    expect(detectCredentialShape(' key')).toEqual(['edge_whitespace']);
    expect(detectCredentialShape('key ')).toEqual(['edge_whitespace']);
    expect(detectCredentialShape('key\t')).toEqual(['edge_whitespace']);
  });

  it('never returns a character of the value it inspected', () => {
    const secret = "SENTINEL-9f3c-'a$b c'\r\n";
    const anomalies = detectCredentialShape(secret);
    const rendered = JSON.stringify(anomalies);
    // The anomaly names are fixed vocabulary, so the only way a character could leak is a bug here.
    for (const part of ['SENTINEL', '9f3c', 'a$b c']) expect(rendered).not.toContain(part);
    expect(new Set(anomalies).size).toBe(anomalies.length);
  });

  it('reports length and a two-character prefix, and nothing else', () => {
    const shape = describeCredential('abcdef')!;
    expect(shape).toEqual({ length: 6, prefix2: 'ab', anomalies: [] });
    expect(Object.keys(shape).sort()).toEqual(['anomalies', 'length', 'prefix2']);
  });

  it('never emits a one-character prefix, so the report cannot imply a one-char secret', () => {
    expect(describeCredential('a')!.prefix2).toBe('<1>');
    expect(describeCredential(undefined)).toBeUndefined();
  });

  it('treats every declared anomaly as fatal, and the vocabulary is the closed set', () => {
    for (const anomaly of CREDENTIAL_ANOMALIES) expect(isFatalAnomaly(anomaly)).toBe(true);
  });

  it('reports a blank value as an unset variable, exactly as the boot schema normalises it', () => {
    expect(reportCredential({}, 'HUDU_API_KEY')).toEqual({ present: false });
    expect(reportCredential({ HUDU_API_KEY: '' }, 'HUDU_API_KEY')).toEqual({ present: false });
    expect(reportCredential({ HUDU_API_KEY: '   ' }, 'HUDU_API_KEY')).toEqual({ present: false });
    expect(reportCredential({ HUDU_API_KEY: 'key' }, 'HUDU_API_KEY')).toEqual({
      present: true,
      shape: { length: 3, prefix2: 'ke', anomalies: [] },
    });
  });
});
