/**
 * results-credential.test.ts — the envelope half of C1c.
 *
 * The auth-failure envelope exists so that a 401 NEVER carries vendor text across the boundary.
 * These tests pin that the shape annotation did not weaken it: the annotation is additive, it is
 * value-free, and with no anomalies published — which is every path that has no view of the
 * credential — the envelope is byte-identical to what it was before this control.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AuthError, HuduConfigError, UnauthorizedError } from 'node-hudu';
import {
  contextErrorContent,
  credentialMalformedContent,
  errorContent,
  resolveErrorContent,
  runWithCredentialShapeView,
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
    // The pre-dial placeholder throws the AuthError node-hudu 0.13.x rethrows unchanged: the
    // anomaly list rides on the error instance (the SDK's AuthError constructor pins its own
    // code), and the envelope must be the typed CREDENTIAL_MALFORMED one, not the 401 shape a
    // real refusal gets.
    const sdkRefusal = Object.assign(new AuthError('this request presented a credential whose shape is malformed; nothing was dialed'), {
      anomalies: ['embedded_quotes', 'edge_whitespace'],
    });
    for (const result of [errorContent(sdkRefusal), searchErrorContent(sdkRefusal), resolveErrorContent(sdkRefusal), contextErrorContent(sdkRefusal)]) {
      const body = JSON.parse(result.content[0]!.text);
      expect(body.code).toBe('CREDENTIAL_MALFORMED');
      expect(body.retryable).toBe(false);
      expect(body.anomalies).toBeUndefined();
      expect(body.message).toContain('embedded_quotes');
      expect(body.message).toContain('edge_whitespace');
      // The strategy's own message text must not cross the boundary.
      expect(body.message).not.toContain('this request presented a credential');
    }
  });

  it('no longer parses anomalies out of a strategy-name message: the pre-0.13.2 stopgap is gone', () => {
    // The stopgap encoded the anomalies in the strategy NAME and regexed them back out of the
    // wrapped AuthError message. That parsing is deleted: an untyped AuthError of that shape now
    // renders as an ordinary error, never as the CREDENTIAL_MALFORMED envelope.
    const legacy = Object.assign(new Error('Auth strategy "x-hudu-api-key malformed (embedded_quotes)" did not produce usable credential headers for GET /api_info (attempt 1); no request was sent'), {
      name: 'AuthError',
      code: 'AUTH_ERROR',
    });
    const body = JSON.parse(errorContent(legacy).content[0]!.text);
    expect(body.code).toBe('AUTH_ERROR');
    expect(body.credentialShape).toBeUndefined();
    expect(body.suggestedAction).toBeUndefined();
  });

  it('answers the SDK construction gate (INVALID_CREDENTIAL_SHAPE) with the same pre-dial envelope', () => {
    // node-hudu 0.13.2 refuses a shape-contaminated value at client construction with a typed
    // HuduConfigError. If one ever reaches the envelope (the server's own gate is a superset and
    // normally refuses first), the answer is the same typed pre-dial refusal; the SDK's gate
    // speaks the SDK's vocabulary, so no anomaly names are claimed.
    const sdkGate = new HuduConfigError('apiKey must be loaded the way the file documents (one-sided surrounding quote)', { code: 'INVALID_CREDENTIAL_SHAPE' });
    const body = JSON.parse(errorContent(sdkGate).content[0]!.text);
    expect(body).toMatchObject({ error: true, code: 'CREDENTIAL_MALFORMED', category: 'validation', retryable: false });
    expect(body.message).toContain('shape anomaly');
    // The SDK's own message text must not cross the boundary.
    expect(body.message).not.toContain('one-sided surrounding quote');
    expect(body.suggestedAction).toContain('shell sourcing');
  });
});

describe('the SDK 401 shape diagnostic (node-hudu 0.13.2, node-hudu#93)', () => {
  // The two sentences and the static 401 action are fixed in the exact-pinned SDK; the test
  // reproduces what the transport attaches: the artifact variant pairs the artifact sentence with
  // the shape-load pointer action, the clean variant keeps the static action.
  const staticAction = 'Check the API key and its scopes.';
  const artifact = () => new UnauthorizedError('Bad credentials', 'https://hudu.invalid/articles', undefined, {
    details: { diagnostic: 'sent value shows shell-quoting/line-break artifacts — check your env load (one-sided surrounding quote) [length 12 (ab)]' },
    suggestedAction: 'Load the credential the way the file documents: shell-sourced (`set -a; . ./.env; set +a`) or via loadHuduCredentialsFromEnv() from node-hudu.',
  });
  const cleanWithDiagnostic = () => new UnauthorizedError('Bad credentials', 'https://hudu.invalid/articles', undefined, {
    details: { diagnostic: 'sent value shows no shape anomalies — credentials or account state are the likely cause [length 37 (ey)]' },
    suggestedAction: staticAction,
  });

  it('annotates the refusal from the SDK diagnostic when the server view is clean', () => {
    const body = JSON.parse(errorContent(artifact()).content[0]!.text);
    expect(body).toMatchObject({ code: 'UNAUTHORIZED', httpStatus: 401, message: 'Bad credentials', credentialShape: 'anomalous' });
    expect(body.credentialShapeDiagnostic).toContain('shell-quoting/line-break artifacts');
    expect(body.suggestedAction).toContain('do NOT re-dial');
    expect(body.suggestedAction).toContain('shell sourcing');
  });

  it('keeps the legacy envelope byte-identical when the SDK reports no anomaly', () => {
    const body = JSON.parse(errorContent(cleanWithDiagnostic()).content[0]!.text);
    expect(body).toEqual({ error: true, code: 'UNAUTHORIZED', httpStatus: 401, message: 'Bad credentials' });
  });

  it('prefers the server view over the SDK diagnostic when both see anomalies', () => {
    setCredentialShapeView({ request: ['embedded_quotes'] });
    const body = JSON.parse(errorContent(artifact()).content[0]!.text);
    expect(body.anomalies).toEqual(['embedded_quotes']);
    expect(body.credentialShapeDiagnostic).toBeUndefined();
  });
});

describe('shape view is bound to the call, not the process (#16)', () => {
  const unauthorized = () => new UnauthorizedError('Bad credentials', 'https://hudu.invalid/articles');
  const bodyOf = (result: ReturnType<typeof errorContent>) => result.content[0]!.text;
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it("a 401 awaiting in request A carries only A's anomalies while request B publishes its own", async () => {
    const a = runWithCredentialShapeView({ request: ['embedded_quotes'] }, async () => {
      await wait(10); // the vendor round trip, during which B starts
      return errorContent(unauthorized());
    });
    const b = runWithCredentialShapeView({ request: ['edge_whitespace'] }, async () => {
      await wait(2);
      return errorContent(unauthorized());
    });
    const [ra, rb] = [await a, await b];
    expect(bodyOf(ra)).toContain('embedded_quotes');
    expect(bodyOf(ra)).not.toContain('edge_whitespace');
    expect(bodyOf(rb)).toContain('edge_whitespace');
    expect(bodyOf(rb)).not.toContain('embedded_quotes');
  });
});
