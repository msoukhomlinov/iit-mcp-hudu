/** Preserve the deny policy's summary-only credential boundary on company context. */
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { secretReadsPermitted } from '../policy.js';

export const ASSET_PASSWORD_SAFE_FIELDS = [
  'id',
  'name',
  'slug',
  'company_id',
  'password_folder_id',
  'password_folder_name',
  'username',
  'url',
  'login_url',
  'password_type',
  'updated_at',
] as const;

/** Project one `asset_passwords` record to {@link ASSET_PASSWORD_SAFE_FIELDS}; report whether anything was dropped. */
function projectAssetPassword(row: unknown): { row: unknown; narrowed: boolean } {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return { row: null, narrowed: true };
  const source = row as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const field of ASSET_PASSWORD_SAFE_FIELDS) {
    if (field in source) safe[field] = source[field];
  }
  return { row: safe, narrowed: Object.keys(source).some((key) => !(ASSET_PASSWORD_SAFE_FIELDS as readonly string[]).includes(key)) };
}

/**
 * Enforce `HUDU_SECRET_READS=deny` on a `companies.getContext` result.
 *
 * `companies.getContext` is not a credential operation, so the credential-resource guard never
 * sees it — yet the SDK always lists `/asset_passwords` for the company, and with `expand: true`
 * returns full records with free-text and unknown fields that key-based redaction cannot protect.
 * This retains the summary-only boundary established for company-context reads. Under `deny` every `assetPasswords` row is projected to
 * the credential-free summary whether or not `expand` was asked for, so the guarantee holds on the
 * summary path too if the SDK's own projection ever changes. A narrowing is logged with the
 * operation and a count; the records themselves never are.
 */
export function redactCompanyContextCredentials(context: unknown, operation: string, config: Config, log: Logger): unknown {
  if (secretReadsPermitted(config)) return context;
  if (context === null || typeof context !== 'object' || !('assetPasswords' in context)) return context;
  const rows = (context as { assetPasswords: unknown }).assetPasswords;
  // Anything other than an array is not a shape we can vouch for; drop it rather than pass it on.
  const projected = Array.isArray(rows) ? rows.map(projectAssetPassword) : [{ row: null, narrowed: true }];
  const narrowed = projected.filter((p) => p.narrowed).length;
  if (narrowed > 0) {
    log.warn('credential fields stripped by secret-read policy', {
      operation,
      policy: config.HUDU_SECRET_READS,
      records: narrowed,
    });
  }
  return {
    ...(context as Record<string, unknown>),
    assetPasswords: projected.map((p) => p.row).filter((row) => row !== null),
  };
}
