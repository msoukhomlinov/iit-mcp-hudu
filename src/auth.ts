/**
 * auth.ts — caller authentication for the HTTP transport.
 *
 * Two per-request headers answer different questions:
 *
 * - `X-Hudu-Api-Key` is the caller's own Hudu key. Under the `http` transport the server normally
 *   holds no Hudu credential of its own (an operator may set an optional `HUDU_API_KEY` default for
 *   requests that bring none): the client supplies the key per request,
 *   scoped per user or per agent to match how the connection is configured. That key is
 *   what actually reaches Hudu, so a caller can read exactly what its own Hudu role permits and no
 *   more.
 * - `X-Hudu-Base-Url` is the origin that key belongs to. It is not a secret — the caller supplied
 *   it and only ever sees its own value — but it decides which Hudu tenant the key is presented
 *   to, so it is scoped exactly like the key: per request, single-valued, absent when duplicated,
 *   and never in the server's config surface or tool schemas.
 *
 * The legacy `X-MCP-Token` shared-secret gate is gone (see the 2026-09-29 amendment to the design
 * spec): the transport boundary is the private, unpublished network the listener must stay on. A
 * client that still sends `x-mcp-token` is answered exactly as if the header were not there.
 *
 * Neither header ever appears in a tool's input schema. See design spec §5.4.
 */

/**
 * The header carrying the caller's Hudu API key.
 *
 * Fixed rather than configurable: it is the wire contract clients are built to send, and making it a
 * knob would let a deployment and its only consumer disagree silently. The value is per request, so
 * it never enters the server's config surface, logs, or tool schemas.
 */
export const HUDU_KEY_HEADER = 'x-hudu-api-key';

/**
 * The header carrying the caller's Hudu base URL — the origin its key belongs to.
 *
 * Sibling of {@link HUDU_KEY_HEADER}: fixed rather than configurable, per request, and never in
 * the server's config surface or tool schemas. It is not a secret — the caller supplied it and
 * only ever sees its own value — so it is not bound by the key's no-logging rule; the
 * single-valued rule still applies, though: a base URL presented twice is absent, exactly as with
 * the key.
 */
export const HUDU_BASE_URL_HEADER = 'x-hudu-base-url';

/**
 * Read a single-valued header, tolerating Node's array-valued header shape.
 *
 * A duplicated header is treated as absent rather than trusting the first value: a request that
 * presents two different credentials is malformed, and picking one is how request-smuggling bugs
 * start.
 */
function readSingleHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.length === 1) return raw[0];
  return undefined;
}

/** Read the caller's per-request Hudu API key from request headers. */
export function readHuduKey(headers: Record<string, string | string[] | undefined>): string | undefined {
  return readSingleHeader(headers, HUDU_KEY_HEADER);
}

/** Read the caller's per-request Hudu base URL from request headers. */
export function readHuduBase(headers: Record<string, string | string[] | undefined>): string | undefined {
  return readSingleHeader(headers, HUDU_BASE_URL_HEADER);
}

/**
 * Collapse a web `Headers` bag into the lowercased record shape the readers expect.
 *
 * A header given twice becomes an array, which the readers treat as absent — see
 * {@link readSingleHeader}. That is the whole reason this cannot just be `Object.fromEntries`.
 */
export function headerRecord(headers: Headers): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  });
  return out;
}
