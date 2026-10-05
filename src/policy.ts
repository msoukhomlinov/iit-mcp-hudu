/**
 * policy.ts — the deployment's authority over the write surface, answered before the governor runs.
 *
 * This module answers **whether** an operation is reachable in this deployment. It never answers
 * **how** a write is performed: validation, the forced dry run and `confirm` stay in the SDK's
 * `dispatchOperation`, used by the disjoint `hudu_read`, `hudu_write` and `hudu_delete`
 * tools. Deployment policy only narrows the SDK mode and effect gates.
 *
 * A policy refusal issues no Hudu request, so the SDK audit hook cannot see it — every refusal is
 * logged here instead. The operation input bag is deliberately never logged: it can carry a
 * credential (e.g. `asset_passwords.create`).
 */
import { CATALOG } from 'node-hudu/mcp';
import type { catalogPage, describeOperation, CatalogRow } from 'node-hudu/mcp';
import { getCapability } from 'node-hudu/capabilities';
import type { CapabilityRecord } from 'node-hudu/capabilities';
import { PolicyDeniedError } from 'node-hudu/errors';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

/** A page of the generated catalog, as `catalogPage` returns it. */
type CatalogPage = ReturnType<typeof catalogPage>;
/** One operation's description, as `describeOperation` returns it. */
type Described = ReturnType<typeof describeOperation>;

/** `write` and `destructive` are the policy's jurisdiction; `read` and unknown effects are not. */
export function isWriteEffect(record: CapabilityRecord): boolean {
  return record.effect === 'write' || record.effect === 'destructive';
}

/**
 * The resources whose records carry a plaintext credential (`password`, `otp_secret`).
 *
 * Mirrors the pair `hudu_search` already redacts; kept here because this module, not the tool
 * surface, is where "may this deployment reach it at all" is answered.
 */
export const CREDENTIAL_RESOURCES = ['asset_passwords', 'password_folders'] as const;

/**
 * Does `operation` sit on a credential-bearing resource?
 *
 * Matches the whole resource rather than the handful of keys known to expand a secret today: a new
 * `asset_passwords.*` operation should arrive denied, not arrive reachable and wait for someone to
 * notice. The dot anchors the prefix so a future `asset_passwords_audit.list` is not swept in.
 */
export function isSecretOperation(operation: string): boolean {
  return CREDENTIAL_RESOURCES.some((resource) => operation.startsWith(`${resource}.`));
}

/** Whether this deployment permits reads that can return a plaintext credential. */
export function secretReadsPermitted(config: Config): boolean {
  return config.HUDU_SECRET_READS === 'allow';
}

/**
 * Does this deployment permit `operation`?
 *
 * Under deny, only an explicitly classified read may reach the SDK.
 */
export function policyAllows(operation: string, record: CapabilityRecord | undefined, config: Config): boolean {
  if (config.HUDU_READ_ONLY || config.HUDU_WRITE_POLICY === 'deny') return record?.effect === 'read';
  if (record === undefined || !isWriteEffect(record)) return true;
  switch (config.HUDU_WRITE_POLICY) {
    case 'allow_list':
      return config.HUDU_WRITE_ALLOW.includes(operation);
    case 'all':
      return true;
  }
}

/**
 * Does this deployment permit `operation` at all, under either policy?
 *
 * The two policies are independent and both are absolute: a credential read is refused under
 * `HUDU_SECRET_READS=deny` even when the write policy is `all`, because they answer different
 * questions for different owners.
 */
export function operationPermitted(operation: string, record: CapabilityRecord | undefined, config: Config): boolean {
  if (isSecretOperation(operation) && !secretReadsPermitted(config)) return false;
  return policyAllows(operation, record, config);
}

/** Why `operation` is refused, phrased for a catalog row, or `null` when it is permitted. */
function refusalReason(operation: string, record: CapabilityRecord | undefined, config: Config): string | null {
  if (isSecretOperation(operation) && !secretReadsPermitted(config)) {
    return 'refused by HUDU_SECRET_READS=deny';
  }
  if (!policyAllows(operation, record, config)) {
    if (config.HUDU_READ_ONLY) return 'refused by HUDU_READ_ONLY=true';
    return `refused by HUDU_WRITE_POLICY=${config.HUDU_WRITE_POLICY}`;
  }
  return null;
}

/** The one-line reason a refused credential read carries, in the SDK's `POLICY_DENIED` vocabulary. */
export function secretRefusalMessage(operation: string): string {
  return `${operation} is refused by HUDU_SECRET_READS=deny; this deployment does not permit reads that can return a plaintext credential (password, otp_secret). Reads of other resources are unaffected, and hudu_search still returns redacted hits for these.`;
}

/**
 * Refuse a credential read before any Hudu request is issued.
 *
 * Same contract as {@link assertWritePermitted}: `PolicyDeniedError`, so the model is told this is
 * fixed for the life of the process rather than something a different argument could satisfy. The
 * operation key is logged; the input bag never is, since it can name the very record being read.
 */
export function assertSecretReadPermitted(operation: string, config: Config, log: Logger): void {
  if (!isSecretOperation(operation) || secretReadsPermitted(config)) return;
  log.warn('credential read refused by secret-read policy', { operation, policy: config.HUDU_SECRET_READS });
  throw new PolicyDeniedError(secretRefusalMessage(operation), {
    operation,
    retryable: false,
    suggestedAction: 'This deployment does not permit credential reads; do not retry it.',
  });
}

/** The one-line reason a refused call carries, in the SDK's `POLICY_DENIED` policy vocabulary. */
export function policyRefusalMessage(operation: string, effect: string, config: Config): string {
  if (config.HUDU_WRITE_POLICY === 'allow_list') {
    return `hudu_read / hudu_write / hudu_delete: ${operation} (${effect}) is refused by HUDU_WRITE_POLICY=allow_list; this deployment permits only: ${config.HUDU_WRITE_ALLOW.join(', ')}. Reads are unaffected.`;
  }
  return `hudu_read / hudu_write / hudu_delete: ${operation} (${effect}) is refused by HUDU_WRITE_POLICY=deny; this deployment does not permit writes. Reads are unaffected.`;
}

/**
 * Refuse a policy-blocked write before the SDK's `dispatchOperation` is called.
 *
 * Throws `PolicyDeniedError`, so the model receives the SDK's `POLICY_DENIED` policy vocabulary
 * rather than `CONFIG_ERROR`: a deployment policy is fixed for the life of the process and no
 * argument the model can choose will satisfy it, so a `CONFIG_ERROR` here would invite the futile
 * retry the policy-aware catalog exists to prevent. Logs one line per refusal — the audit hook fires
 * per Hudu request and this issues none.
 */
export function assertWritePermitted(
  operation: string,
  record: CapabilityRecord | undefined,
  config: Config,
  log: Logger,
): void {
  if (policyAllows(operation, record, config)) return;
  const effect = record?.effect ?? 'unknown';
  log.warn('hudu_read / hudu_write / hudu_delete refused by write policy', { operation, effect, policy: config.HUDU_WRITE_POLICY });
  throw new PolicyDeniedError(policyRefusalMessage(operation, effect, config), {
    operation,
    retryable: false,
    suggestedAction: 'This deployment does not permit this operation; do not retry it.',
  });
}

/**
 * How many currently-reachable catalog rows this policy refuses, globally.
 *
 * `reachable_operations` / `unreachable_operations` on a catalog page are global, not filtered, so
 * the adjustment is computed from the whole catalog rather than from the page's own rows.
 */
function refusedReachableCount(config: Config): number {
  return CATALOG.filter((row) => row.reachable && !operationPermitted(row.op, getCapability(row.op), config)).length;
}

/**
 * Mark policy-refused rows unreachable, with the policy as the reason.
 *
 * A catalog that advertises `companies.delete` under `deny` spends model turns on calls that cannot
 * succeed and teaches the model to retry. The SDK's own `reachable: false` / `reason` for the binary
 * surfaces is the shape being matched; rows the SDK already refused are left untouched.
 */
export function applyCatalogPolicy(page: CatalogPage, config: Config): CatalogPage {
  // `all` alone is no longer an early exit: the secret-read policy refuses rows independently of
  // the write policy, so a deployment with `all` + `deny` still has rows to mark.
  if (!config.HUDU_READ_ONLY && config.HUDU_WRITE_POLICY === 'all' && secretReadsPermitted(config)) return page;
  const rows: CatalogRow[] = page.rows.map((row) => {
    const reason = row.reachable ? refusalReason(row.op, getCapability(row.op), config) : null;
    return reason === null ? row : { ...row, reachable: false, reason };
  });
  const flipped = refusedReachableCount(config);
  return {
    ...page,
    rows,
    reachable_operations: page.reachable_operations - flipped,
    unreachable_operations: page.unreachable_operations + flipped,
  };
}

/**
 * The same override for `hudu_describe_operation`, so its text line and its structured payload agree.
 *
 * The SDK's reason for a binary-surface refusal is kept when it already refused; the policy only
 * overrides rows the SDK considered reachable.
 */
export function applyDescribePolicy(
  described: Described,
  operation: string,
  record: CapabilityRecord | undefined,
  config: Config,
): Described {
  const reason = described.reachable ? refusalReason(operation, record, config) : null;
  if (reason !== null) return { ...described, reachable: false, why_not: reason };
  return described;
}
