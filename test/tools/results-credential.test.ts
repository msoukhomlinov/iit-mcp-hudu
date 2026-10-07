/**
 * results-credential.test.ts — the envelope half of C1c.
 *
 * The auth-failure envelope exists so that a 401 NEVER carries vendor text across the boundary.
 * These tests pin that the shape annotation did not weaken it: the annotation is additive, it is
 * value-free, and with no anomalies published — which is every path that has no view of the
 * credential — the envelope is byte-identical to what it was before this control.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { UnauthorizedError } from 'node-hudu';
import {
  contextErrorContent,
  credentialMalformedContent,
  errorContent,
  resolveErrorContent,
  searchErrorContent,
  setCredentialShapeView,
  unauthorizedContent,
} from '../../src/tools/results.js';

afterEach(() => setCredentialShapeView({}));

describe('CREDENTIAL_MALFORMED envelope', () => {
  it('is a value-free pre-dial refusal, not an auth one', () => {
    const result = credentialMalformedContent(['surrounding_single_quotes']);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text);
    expect(body).toMatchObject({ error: true, code: 'CREDENTIAL_MALFORMED', category: 'validation', retryable: false });
    // No status: nothing was dialed, so claiming one would misdescribe the wire.
    expect(body.httpStatus).toBeUndefined();
    expect(body.message).toContain('surrounding_single_quotes');
    expect(body.suggestedAction).toContain('shell sourcing');
    expect(result.content[1]!.text).toContain('untrusted data');
  });
});

describe('shape annotation on the auth-failure branch', () => {
  const err = () => new UnauthorizedError('Bad credentials', 'https://hudu.invalid/articles');

  it('keeps the exact legacy envelope when no anomalies are published', () => {
    // The default the unit tests and every credential-less path run in: no view of the values, so
    // nothing is inferred and nothing is added.
    for (const result of [
      unauthorizedContent(),
      errorContent(err()),
      searchErrorContent(err()),
      resolveErrorContent(err()),
      contextErrorContent(err()),
    ]) {
      expect(JSON.parse(result.content[0]!.text)).toEqual({
        error: true,
        code: 'UNAUTHORIZED',
        httpStatus: 401,
        message: 'Bad credentials',
      });
    }
  });

  it('annotates the refusal when the server holds an anomalous credential, keeping the 401 shape', () => {
    setCredentialShapeView({ env: ['surrounding_single_quotes'] });
    const body = JSON.parse(errorContent(err()).content[0]!.text);
    // The 401 shape is untouched: the code, the status and the message are what every existing test
    // and every client already reads.
    expect(body).toMatchObject({ code: 'UNAUTHORIZED', httpStatus: 401, message: 'Bad credentials' });
    expect(body.credentialShape).toBe('anomalous');
    expect(body.anomalies).toEqual(['surrounding_single_quotes']);
    expect(body.suggestedAction).toContain('do NOT re-dial');
    expect(body.suggestedAction).toContain('shell sourcing');
  });

  it('reaches every auth-refusal path, so the refusal shape stays one shape', () => {
    setCredentialShapeView({ request: ['embedded_quotes'] });
    for (const result of [searchErrorContent(err()), resolveErrorContent(err()), contextErrorContent(err())]) {
      const body = JSON.parse(result.content[0]!.text);
      expect(body.code).toBe('UNAUTHORIZED');
      expect(body.anomalies).toEqual(['embedded_quotes']);
    }
  });

  it('never repeats an anomaly seen in both the environment and the request', () => {
    setCredentialShapeView({ env: ['embedded_quotes'], request: ['embedded_quotes', 'edge_whitespace'] });
    const body = JSON.parse(errorContent(err()).content[0]!.text);
    expect(body.anomalies).toEqual(['embedded_quotes', 'edge_whitespace']);
  });

  it('leaves a non-auth error alone: the annotation is for the credential refusal only', () => {
    setCredentialShapeView({ env: ['surrounding_single_quotes'] });
    const body = JSON.parse(errorContent(new Error('something else')).content[0]!.text);
    expect(body.credentialShape).toBeUndefined();
    expect(body.anomalies).toBeUndefined();
  });

  it('answers a malformed-credential refusal with its OWN envelope on every error path', () => {
    // The pre-dial placeholder surfaces as an SDK AuthError naming the anomalies; the envelope must
    // be the typed CREDENTIAL_MALFORMED one, not the 401 shape a real refusal gets.
    const sdkRefusal = Object.assign(new Error('Auth strategy "x-hudu-api-key malformed (embedded_quotes, edge_whitespace)" did not produce usable credential headers for GET /api_info (attempt 1); no request was sent'), {
      name: 'AuthError',
      code: 'AUTH_ERROR',
      category: 'auth',
      retryable: false,
    });
    for (const result of [errorContent(sdkRefusal), searchErrorContent(sdkRefusal), resolveErrorContent(sdkRefusal), contextErrorContent(sdkRefusal)]) {
      const body = JSON.parse(result.content[0]!.text);
      expect(body.code).toBe('CREDENTIAL_MALFORMED');
      expect(body.retryable).toBe(false);
      expect(body.anomalies).toBeUndefined();
      expect(body.message).toContain('embedded_quotes');
      expect(body.message).toContain('edge_whitespace');
      // The SDK's own message text (with the strategy name and the operation) must not cross.
      expect(body.message).not.toContain('did not produce usable credential headers');
    }
  });
});
