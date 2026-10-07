/**
 * doctor.ts — the zero-wire credential/config preflight.
 *
 * The problem it solves is the expensive one: today the only way to confirm that a credential
 * loaded intact is to dial Hudu, and against a vendor account where repeated auth failures risk a
 * lock (2026-10-07 Autotask incident) that confirmation is the most expensive call the deployment
 * can make. `doctor` answers the same question — "is the value I loaded shaped like the credential
 * the vendor issued, and is it aimed at the origin I meant?" — from the process's own environment,
 * with ZERO vendor requests, by construction: this module imports no Hudu client and reads no
 * network, so there is nothing it could dial even if a value invited it.
 *
 * It reports shape, never value: a length, a two-character prefix and which anomalies were seen.
 * The contract it feeds (README / `.env.example`): run `doctor` before a live session — a green
 * doctor means any later 401 is vendor-side (rotated, revoked or role-restricted key), not a
 * mangled load.
 */
import type { Config } from './config.js';
import { describeCredential, type CredentialShape } from './credential.js';

/** How one credential field's shape check came out. */
export type DoctorCheckStatus = 'absent' | 'ok' | 'malformed';

/** The shape report for one credential-bearing variable: metadata only, never a value. */
export interface DoctorCredentialCheck {
  readonly name: string;
  readonly status: DoctorCheckStatus;
  readonly length?: number;
  readonly prefix2?: string;
  readonly shapeOk?: boolean;
  readonly anomalies?: readonly string[];
  /**
   * Whether the intake path this variable feeds would refuse it. Under `stdio` `HUDU_API_KEY` is
   * required, so an absent one is as fatal as a malformed one; under `http` it is an optional
   * default and absence is fine.
   */
  readonly blocks?: boolean;
}

/** The shape report for one origin value: host and scheme only, never a path or a query. */
export interface DoctorBaseCheck {
  readonly name: string;
  readonly present: boolean;
  /** `origin` (scheme + host + port), never the full URL. The origin is what the SDK dials. */
  readonly origin?: string;
  readonly resolvable: boolean;
}

/** The whole zero-wire report. `ok: false` means at least one field would be refused. */
export interface DoctorReport {
  readonly ok: boolean;
  readonly transport: Config['MCP_TRANSPORT'];
  readonly dialed: number;
  readonly credentials: readonly DoctorCredentialCheck[];
  readonly bases: readonly DoctorBaseCheck[];
  readonly notes: readonly string[];
}

/** Check one credential-shaped value without ever carrying it out of this function. */
function credentialCheck(
  name: string,
  value: string | undefined,
  required: boolean,
): DoctorCredentialCheck {
  if (value === undefined || value.trim() === '') {
    // "not set", never "length 0": the boot schema normalises a blank the same way, and a blank is
    // the `.env.example` placeholder rather than a credential the vendor would see.
    return { name, status: 'absent', blocks: required };
  }
  const shape: CredentialShape = describeCredential(value)!;
  const malformed = shape.anomalies.length > 0;
  return {
    name,
    status: malformed ? 'malformed' : 'ok',
    length: shape.length,
    prefix2: shape.prefix2,
    shapeOk: !malformed,
    anomalies: shape.anomalies,
    // `blocks` is "this field would be refused", and only a malformed or an absent-and-required
    // field is. A present, well-shaped value never blocks, however much the deployment needs it.
    blocks: malformed,
  };
}

/**
 * Check one origin value: does it parse, and what origin will actually be dialed?
 *
 * An origin is not a secret (the operator wrote it), but only its origin crosses into the report:
 * a URL with userinfo (`https://user:pass@host`) would otherwise carry a credential into every log
 * sink this report reaches, so the origin is derived and the raw value is dropped.
 */
function baseCheck(name: string, value: string | undefined): DoctorBaseCheck {
  if (value === undefined || value.trim() === '') return { name, present: false, resolvable: false };
  try {
    return { name, present: true, origin: new URL(value).origin, resolvable: true };
  } catch {
    return { name, present: true, resolvable: false };
  }
}

/**
 * Build the doctor report for an already-validated config.
 *
 * Takes the parsed `Config` rather than a raw environment on purpose: `loadConfig` has already
 * refused a blank/missing/origin-invalid configuration — and, at boot, a malformed credential — so
 * reaching here means every structural question is settled and only the SHAPE facts remain.
 *
 * A malformed credential therefore normally reaches the operator as the boot refusal (the CLI
 * prints it verbatim, exit 1, and it names the anomaly and the load recipe). This report is the
 * same facts in structured form, for a config that is already shaped like a working one; the two
 * routes are tested together in `test/doctor.test.ts`.
 */
export function runDoctor(config: Config): DoctorReport {
  const isStdio = config.MCP_TRANSPORT === 'stdio';
  // The environment is exactly one credential path; the per-request header is not reachable from a
  // preflight (nothing is serving yet), and saying so is part of the contract.
  const credentials = [
    credentialCheck('HUDU_API_KEY', config.HUDU_API_KEY, isStdio),
  ];
  const bases = [baseCheck('HUDU_BASE_URL', config.HUDU_BASE_URL)];
  const notes = [
    'zero vendor requests: this report is computed from the environment alone',
    'shape facts only (length, two-character prefix, anomaly names) — a credential value is never read out',
  ];
  if (!isStdio) {
    notes.push(
      'http transport: the tool-call credential arrives per request in x-hudu-api-key and is checked at that boundary, not here',
    );
  }
  if (credentials.some((c) => c.blocks)) {
    notes.push(
      'a credential-bearing variable would be refused by the server: fix the load recipe before any live session (a 401 costs a real vendor auth failure, and repeated ones risk an account lock)',
    );
  }
  return {
    ok: !credentials.some((c) => c.blocks) && bases.every((b) => !b.present || b.resolvable),
    transport: config.MCP_TRANSPORT,
    dialed: 0,
    credentials,
    bases,
    notes,
  };
}
