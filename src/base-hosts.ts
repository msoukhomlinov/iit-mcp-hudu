/**
 * base-hosts.ts — the optional allow-list for client-supplied Hudu origins.
 *
 * Under `http` a caller names the origin its key is presented to (`x-hudu-base-url`), which makes
 * this server an outbound HTTP client for whoever can reach the listener. The SDK only checks the
 * scheme and that there is no path, so when `HUDU_ALLOWED_BASE_HOSTS` is set this is what keeps a
 * caller from pointing the server at an internal host or a hostile one.
 */

/**
 * Whether `baseUrl`'s host is permitted by `allowed`.
 *
 * An entry is an exact hostname (`hudu.example.com`) or a `*.` suffix (`*.example.com`) that
 * matches subdomains only, never the bare domain. Unset (`undefined`) permits everything at this
 * level; the http server layers the effective policy on top (default-only when a default origin is
 * set, bring-your-own-origin when it is not). A URL that does not parse is refused rather than
 * passed through, so the SDK's own error is never the gate.
 */
export function baseHostAllowed(baseUrl: string, allowed: readonly string[] | undefined): boolean {
  if (allowed === undefined) return true;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowed.some((entry) =>
    entry.startsWith('*.') ? host.endsWith(entry.slice(1)) : host === entry,
  );
}

/** The origin of `url`, or `undefined` when it does not parse. Used to compare against the default. */
export function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
