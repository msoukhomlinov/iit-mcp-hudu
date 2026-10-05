/** URL fields published by node-hudu resource records and search/context results.
 * Deliberately explicit: prose, arbitrary *_url properties and input text are not links.
 */
const URL_FIELDS = new Set([
  'url', 'full_url', 'knowledge_base_url', 'passwords_url', 'asset_url',
  'share_url', 'download_url', 'image_url', 'login_url',
]);

function absoluteUrl(value: string, origin: string): string {
  // Accept only a single root slash. Reject parser repair, escaped separators/controls,
  // invalid percent escapes and whitespace rather than inventing a different destination.
  const hasControl = [...value].some((char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159));
  if (hasControl || !value.startsWith('/') || value.startsWith('//') || /[\\\s]/u.test(value)
    || /%(?![0-9a-f]{2})|%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/iu.test(value)) return value;
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? url.href : value;
  } catch {
    return value;
  }
}

/** Copy nested JSON results; only known root-relative URL fields are normalized. No I/O. */
export function normalizeResultUrls(value: unknown, origin?: string): unknown {
  if (origin === undefined) return value;
  // Defence in depth for direct callers: only a canonical HTTP(S) origin is usable.
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) return value;
  } catch {
    return value;
  }
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (node === null || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [
      key, URL_FIELDS.has(key) && typeof child === 'string' ? absoluteUrl(child, origin) : visit(child),
    ]));
  };
  return visit(value);
}
