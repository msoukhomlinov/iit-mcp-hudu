/**
 * credential.ts — the pre-dispatch shape gate for Hudu credential values, and the value-free
 * description of a credential the operator-facing doctor reports.
 *
 * Why this exists (2026-10-07 Autotask incident): a `.env` value written `HUDU_API_KEY='a$b'` was
 * fed through a quote-preserving dotenv parser, so the quotes reached the wire as part of the
 * secret. The vendor answered 401 and the operator read three opaque failures as a rotated key —
 * on an account where retries risk a lock. Nothing in this package, and nothing in node-hudu
 * 0.12.0, inspects the shape of a credential value before it is dialed, so that class of misload
 * booted cleanly and dialed.
 *
 * This module closes that at the boundary. It never inspects, stores or reports a credential
 * VALUE — only shape facts derived from it (a length, a two-character prefix, and which anomaly
 * was seen). {@link describeCredential} and {@link detectCredentialShape} return metadata for a
 * value caller; no field of either ever carries a character of the value itself, so both are safe
 * to log and to serialize.
 */

export const CREDENTIAL_LOAD_HINT =
  'load the value the way the file documents: values written in single quotes (the .env.example style) are only unquoted by shell sourcing — `set -a; . ./.env; set +a` — and a quote-preserving parser such as a plain dotenv parse of the file feeds the quotes to the vendor; run `doctor` to confirm the shape';

/**
 * The shape anomalies a mislanded credential file load produces, in the order they are reported.
 *
 * `surrounding_single_quotes` is the incident itself: a value written `KEY='a$b'` in a `.env` loses
 * its quotes when the file is SOURCED by a shell, so a value that still carries them here was never
 * shell-sourced (or was parsed by something that preserves them).
 */
export const CREDENTIAL_ANOMALIES = [
  'surrounding_double_quotes',
  'surrounding_single_quotes',
  'embedded_quotes',
  'carriage_return',
  'newline',
  'edge_whitespace',
  'nul_byte',
] as const;
export type CredentialAnomaly = (typeof CREDENTIAL_ANOMALIES)[number];

/**
 * Whether a shape anomaly means the server must refuse to dial rather than warn.
 *
 * Every anomaly in {@link CREDENTIAL_ANOMALIES} changes the bytes presented to the vendor, so
 * every one of them is refused by both intake paths. The predicate is a function, not a literal
 * `true` in the callers, so the decision lives in one place if it ever narrows.
 */
export function isFatalAnomaly(anomaly: CredentialAnomaly): boolean {
  return CREDENTIAL_ANOMALIES.includes(anomaly);
}

/** The value-free shape description of one credential-shaped string. */
export interface CredentialShape {
  /** Character count of the value as received. A count, never a character of the value. */
  readonly length: number;
  /**
   * The first two characters, which identify the format for the operator (a Hudu API key starts
   * `ey` — a base64url-encoded JWT). Two characters of an already-leaked-format credential say
   * nothing; the other 500 do.
   */
  readonly prefix2: string;
  /** Every anomaly seen, in {@link CREDENTIAL_ANOMALIES} order. */
  readonly anomalies: readonly CredentialAnomaly[];
}

/** Every anomaly present in `value`, in a fixed order. Never returns any part of the value. */
export function detectCredentialShape(value: string): readonly CredentialAnomaly[] {
  const anomalies: CredentialAnomaly[] = [];
  // The incident, first: quotes preserved by a parser that should have consumed them.
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) anomalies.push('surrounding_double_quotes');
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) anomalies.push('surrounding_single_quotes');
  // A quote that survived inside the value: a shell-sourced value cannot contain a bare one, and
  // a shell that never ran leaves them where a parser put them.
  if (value.includes('"') || value.includes("'")) anomalies.push('embedded_quotes');
  // CRLF is the canonical Windows-edited .env contamination: the CRLF and everything after it
  // reaches the vendor as part of the secret. (A per-request header cannot carry one — Node's
  // `Headers` strips it — so this branch is reachable only through the server-held value.)
  if (value.includes('\r')) anomalies.push('carriage_return');
  if (value.includes('\n')) anomalies.push('newline');
  // A trailing space from `KEY=value ` is invisible in every editor and is presented verbatim.
  // `trim()` also catches a tab, which survives a header hop even though Node's Headers strips
  // space at the edges of a header value.
  if (value.length > 0 && value !== value.trim()) anomalies.push('edge_whitespace');
  // NUL is not a legal header character: Node's `Headers.set` THROWS on a value carrying one, and
  // that throw happens before any auth strategy runs, so a request with such a key answers with a
  // framework error instead of a typed refusal. Flagged here so the server-held value is refused at
  // boot, where the operator can act on it.
  if (value.includes('\u0000')) anomalies.push('nul_byte');
  return anomalies;
}

/**
 * The shape facts an operator-facing surface may report for one credential field.
 *
 * `prefix2` is emitted for values of at least two characters and a single `<1>` otherwise, so the
 * report never implies a one-character secret. The value itself is never returned.
 */
export function describeCredential(value: string | undefined): CredentialShape | undefined {
  if (value === undefined) return undefined;
  return {
    length: value.length,
    prefix2: value.length >= 2 ? value.slice(0, 2) : '<1>',
    anomalies: detectCredentialShape(value),
  };
}

/**
 * The partial config one credential-bearing attempt produced, in the shape the operator's next
 * step needs: whether the variable was set at all, and its value-free shape when it was.
 */
export interface CredentialReport {
  readonly present: boolean;
  readonly shape?: CredentialShape;
}

/** Describe one credential-bearing variable for a diagnostic surface. Never carries its value. */
export function reportCredential(env: Record<string, string | undefined>, name: string): CredentialReport {
  const raw = env[name];
  // `''` is the .env.example placeholder an operator forgot to fill in: "not set", exactly as the
  // boot schema normalises it, rather than a zero-length credential.
  if (raw === undefined || raw.trim() === '') return { present: false };
  return { present: true, shape: describeCredential(raw)! };
}
