/**
 * company-context-fixture.ts — a stand-in Hudu for `companies.getContext` whose one asset_passwords
 * row carries a plaintext credential, an OTP seed and an unknown field. Shared by the
 * reads and meta tool tests so both call paths are asserted against the same secret.
 */

/** Distinctive enough that any leak into a response is unmistakable. */
export const PLAINTEXT = 'hunter2-plaintext-never-returned';
export const OTP_SEED = 'JBSWY3DPEHPK3PXP-otp-never-returned';

export const PASSWORD_ROW = {
  id: 7,
  name: 'Domain admin',
  slug: 'domain-admin',
  company_id: 1,
  username: 'administrator',
  url: 'https://dc.example.invalid',
  password: PLAINTEXT,
  otp_secret: OTP_SEED,
  // A field Hudu might add tomorrow: the allow-list must drop it without anyone naming it.
  recovery_code: 'future-secret-field',
  description: 'break-glass-note-never-returned',
  backup_codes: ['unnamed-future-value-never-returned'],
  passwordable_id: 99,
};

/** What survives `HUDU_SECRET_READS=deny`: the record narrowed, not destroyed. */
export const SAFE_ROW = {
  id: 7,
  name: 'Domain admin',
  slug: 'domain-admin',
  company_id: 1,
  username: 'administrator',
  url: 'https://dc.example.invalid',
};

/** Company 1 with one password row; every other context list empty. */
export function companyContextHudu(url: string): Response {
  const path = new URL(url).pathname;
  if (path.endsWith('/asset_passwords')) return Response.json({ asset_passwords: [PASSWORD_ROW] });
  if (path.endsWith('/assets')) return Response.json({ assets: [] });
  if (path.endsWith('/articles')) return Response.json({ articles: [] });
  if (path.endsWith('/websites')) return Response.json([]);
  if (path.endsWith('/companies/1')) return Response.json({ company: { id: 1, name: 'Acme' } });
  return new Response('not found', { status: 404 });
}

/** Whether no credential field or value reached the wire. */
export function credentialFree(result: unknown): boolean {
  const wire = JSON.stringify(result);
  return ![PLAINTEXT, OTP_SEED, 'future-secret-field', PASSWORD_ROW.description, ...PASSWORD_ROW.backup_codes].some((needle) => wire.includes(needle));
}
