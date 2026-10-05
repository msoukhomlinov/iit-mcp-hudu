/**
 * tools/server.ts — the per-serving-unit `McpServer` factory and the per-(origin, credential)
 * client cache behind it.
 */
import { McpServer, type McpRequestContext, type McpServerFactory } from '@modelcontextprotocol/server';
import { createHash } from 'node:crypto';
import { CAPABILITY_NAMES, getCapability } from 'node-hudu/capabilities';
import { HuduClient } from 'node-hudu';
import { HuduConfigError } from 'node-hudu';
import type { AuthStrategy, HuduConfig } from 'node-hudu';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { headerRecord, readHuduBase, readHuduKey } from '../auth.js';
import { baseHostAllowed, originOf } from '../base-hosts.js';
import { registerTools } from './register.js';

/** Identity this server reports in `initialize`. The version is this repo's, not the SDK's. */
const SERVER_NAME = 'iit-mcp-hudu';
const SERVER_VERSION = '0.1.0';

/**
 * The maximum number of per-(origin, credential) scoped clients kept warm in one process.
 *
 * Each scoped client owns its own Hudu knowledge index, which the SDK bounds with a 64 MB text
 * budget (see `HUDU_SEARCH_MAX_INDEX_PAGES`, the same budget from the walk side). An unbounded map
 * would let enough distinct callers grow the heap past the container limit, so the cache is capped
 * and evicts least-recently-used first. Eight scopes is 8 × 64 MB of text at the absolute worst
 * case — the cap, not a typical tenant — which leaves headroom under the 1 GB container limit for
 * the Node runtime and in-flight request bodies while keeping the common working set resident.
 */
export const MAX_SCOPED_CLIENTS = 8;

/**
 * A strategy that refuses to produce headers.
 *
 * Under `http` the parent client exists only to share transport state (rate-limit bucket, queue,
 * logger, audit hook) with the per-caller scopes, and it must itself hold no Hudu credential. This
 * strategy makes that literal: any code path that reached Hudu through the parent would throw
 * before a request was built, so no sentinel value can be mistaken for a working credential.
 */
const NO_SERVER_CREDENTIAL: AuthStrategy = {
  name: 'no-server-credential',
  headers() {
    throw new Error('this client holds no Hudu credential; resolve a per-request scope first');
  },
};

/**
 * A strategy that refuses to produce headers because the request named no Hudu origin.
 *
 * Sibling of {@link NO_SERVER_CREDENTIAL} for the base-URL case: a request that presents a Hudu
 * key but no `x-hudu-base-url` (or a blank one) is let through for `initialize`/`tools/list`,
 * which never reach Hudu, then fails closed on every tool call, before any Hudu request is built,
 * so zero requests are dialed.
 *
 * The name, not the thrown message, is what the caller sees: the SDK's `AuthError` uses a fixed
 * message shape that carries the strategy name and never the cause (node-hudu, deliberate). The
 * name is therefore the only diagnostic channel, and it names the missing header so the caller
 * knows what to fix. No tenant value is involved — the header is simply absent.
 */
const NO_REQUEST_BASE_URL: AuthStrategy = {
  name: 'x-hudu-base-url missing',
  headers() {
    throw new Error('this request named no Hudu origin; supply the x-hudu-base-url header');
  },
};

/**
 * A strategy that refuses to produce headers because the request's `x-hudu-base-url` is not a
 * usable origin (not a URL, not http(s), or carrying a path).
 *
 * Sibling of {@link NO_REQUEST_BASE_URL}: the SDK rejects such a value when the scoped client is
 * built, and that throw must not escape the per-request factory, or `initialize`/`tools/list`
 * would fail with it. Like its sibling, the fixed name is the only diagnostic channel and echoes
 * none of the caller's value.
 */
const INVALID_REQUEST_BASE_URL: AuthStrategy = {
  name: 'x-hudu-base-url invalid',
  headers() {
    throw new Error('this request named an unusable Hudu origin; supply an http(s) origin with no path');
  },
};

/**
 * Sibling of {@link NO_REQUEST_BASE_URL} for an origin `HUDU_ALLOWED_BASE_HOSTS` does not permit.
 * Same fail-closed shape: every tool call throws before a request is built, so nothing is dialed.
 * The name is the only diagnostic the caller sees and carries no part of the refused value.
 */
const BASE_URL_NOT_ALLOWED: AuthStrategy = {
  name: 'x-hudu-base-url host not allowed',
  headers() {
    throw new Error('this request named a Hudu origin the server does not allow');
  },
};

/**
 * A per-(origin, credential) client built from the request's own `x-hudu-base-url` and
 * `x-hudu-api-key`, cached by the pair's hash.
 *
 * Keyed by the SHA-256 of `origin + '\0' + credential` and *nothing else*. The SDK caches its
 * knowledge index against the client instance, and that index holds article bodies, so a key
 * mixing in anything else would let one caller's index answer another's search. The (origin,
 * credential) hash is the one key that guarantees two callers share a client only when they
 * present the identical origin AND the identical credential.
 *
 * Scopes are built as fresh `HuduClient` instances rather than via the parent's `withAuth()`:
 * `withAuth()` shares the parent's transport state and differs only in its credential — it cannot
 * carry a base URL. The side effect is that transport state (rate-limit bucket, queue) is per
 * (origin, credential) instead of shared with the parent, which the `http` parent shares nothing
 * with in spirit anyway ({@link NO_SERVER_CREDENTIAL}).
 *
 * Exported for its own unit tests (identity and the eviction bound); the server otherwise reaches
 * it only through {@link createMcpServerFactory}.
 */
export class ScopedClientCache {
  private readonly clients = new Map<string, HuduClient>();

  constructor(
    private readonly buildScoped: (baseUrl: string, apiKey: string) => HuduClient,
    private readonly capacity: number,
    private readonly log: Logger,
  ) {}

  /** The client for `(baseUrl, apiKey)`, creating it on first use and refreshing its recency on every hit. */
  for(baseUrl: string, apiKey: string): HuduClient {
    const id = createHash('sha256').update(baseUrl + '\0' + apiKey, 'utf8').digest('hex');
    const existing = this.clients.get(id);
    if (existing !== undefined) {
      // Re-insert so Map iteration order stays least-recently-used first.
      this.clients.delete(id);
      this.clients.set(id, existing);
      return existing;
    }
    const scoped = this.buildScoped(baseUrl, apiKey);
    this.clients.set(id, scoped);
    if (this.clients.size > this.capacity) {
      const oldest = this.clients.keys().next().value;
      if (oldest !== undefined) this.clients.delete(oldest);
      // Credential material is never logged: only that the working set moved on.
      this.log.info('evicted least-recently-used Hudu credential scope', {
        size: this.clients.size,
        max: this.capacity,
      });
    }
    return scoped;
  }
}

/**
 * One built mode: the client instances every serving unit of that mode can resolve to.
 *
 * `parent` is the mode's own client — the environment's under `stdio`; the credential-less
 * placeholder under `http`. `noBase` is the fail-closed target for a request that presents a key
 * but no origin; `badBase` for one whose origin the SDK rejects; `baseRefused` for one that names
 * an origin outside `HUDU_ALLOWED_BASE_HOSTS`. `scopes` is the warm cache of per-(origin,
 * credential) clients.
 */
interface ModeEntry {
  parent: HuduClient;
  noBase: HuduClient;
  badBase: HuduClient;
  baseRefused: HuduClient;
  scopes: ScopedClientCache;
}

/**
 * The client a request's tools should use.
 *
 * Under `http` the request's `x-hudu-base-url` and `x-hudu-api-key` win; `HUDU_BASE_URL` and
 * `HUDU_API_KEY`, when set, fill in whichever the request omits. Two rules keep that safe:
 *
 * - A caller-named origin resolves to the {@link BASE_URL_NOT_ALLOWED} client unless
 *   `HUDU_ALLOWED_BASE_HOSTS` permits it. When that list is unset, a configured default origin
 *   permits only itself; with neither setting, bring-your-own-origin mode is unrestricted, and config refuses to boot
 *   into it without `HUDU_ALLOW_ANY_BASE_HOST=true`.
 *   The default origin is operator-chosen and is never checked.
 * - The default key is only ever presented to the default origin. A request that names some other
 *   origin without its own key gets no credential rather than the server's, so a caller cannot
 *   aim the server's key at a host it controls.
 *
 * With no usable key the request resolves to the credential-less parent: the HTTP transport lets
 * it through so the SDK can answer `initialize`/`tools/list` for a catalog sync, and those never
 * reach Hudu. A key with no origin at all resolves to the {@link NO_REQUEST_BASE_URL} client, and
 * one whose origin the SDK rejects at construction resolves to the {@link
 * INVALID_REQUEST_BASE_URL} client. The placeholder clients throw before any Hudu request is
 * built, so every tool call fails closed.
 *
 * Under `stdio` the process boundary is the trust boundary and the parent already carries the
 * environment's credential and origin; the headers are never read on this path.
 */
function resolveHuduClient(entry: ModeEntry, config: Config, ctx: McpRequestContext): { client: HuduClient; origin?: string } {
  if (config.MCP_TRANSPORT === 'stdio') return { client: entry.parent, origin: new URL(config.HUDU_BASE_URL!).origin };
  const headers = ctx.requestInfo === undefined ? undefined : headerRecord(ctx.requestInfo.headers);
  const usable = (v: string | undefined) => (v === undefined || v.trim().length === 0 ? undefined : v);
  const headerKey = usable(headers === undefined ? undefined : readHuduKey(headers));
  const headerBase = usable(headers === undefined ? undefined : readHuduBase(headers));
  const defaultBase = config.HUDU_BASE_URL;

  const base = headerBase ?? defaultBase;
  // Only a caller-named origin is subject to the allow-list, and naming the default one is free.
  const defaultOrigin = defaultBase === undefined ? undefined : originOf(defaultBase);
  const headerOrigin = headerBase === undefined ? undefined : originOf(headerBase);
  // An unparsable header value is caller-named even when there is no default to differ from: two
  // `undefined` origins must not read as "the default", or the default key would be paired with it.
  const callerNamed = headerBase !== undefined && (headerOrigin === undefined || headerOrigin !== defaultOrigin);
  // Keep `undefined` distinct from an explicit list in config: with a configured default, an
  // omitted list means default-only; without one it preserves documented BYO-origin mode.
  const callerOriginAllowed = config.HUDU_ALLOWED_BASE_HOSTS === undefined
    ? defaultBase === undefined
    : baseHostAllowed(headerBase!, config.HUDU_ALLOWED_BASE_HOSTS);
  if (callerNamed && !callerOriginAllowed) return { client: entry.baseRefused };

  const key = headerKey ?? (callerNamed ? undefined : config.HUDU_API_KEY);
  if (key === undefined) return { client: entry.parent };
  if (base === undefined) return { client: entry.noBase };
  try {
    const client = entry.scopes.for(base, key);
    // Only publish an origin after the dispatched client has passed SDK validation.
    return { client, origin: new URL(base).origin };
  } catch (err) {
    // Only the SDK's config validation is caller error; anything else is a bug and must surface.
    if (err instanceof HuduConfigError) return { client: entry.badBase };
    throw err;
  }
}

/**
 * Render audit query values as shape metadata, never caller-supplied content. The SDK redacts
 * credential-shaped keys but not values, so search text and free-form `hudu_read`/`hudu_invoke`
 * input must not cross this sink. Array and object values use their size rather than their
 * contents, which keeps one audit line small even for a large filter.
 */
export const boundAuditQuery = (query: Record<string, unknown>): Record<string, unknown> => {
  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") {
      bounded[key] = { type: "string", chars: value.length };
    } else if (typeof value === "number" || typeof value === "boolean") {
      bounded[key] = value;
    } else if (Array.isArray(value)) {
      bounded[key] = { type: "array", items: value.length };
    } else if (value === null) {
      bounded[key] = { type: "null" };
    } else if (typeof value === "object") {
      bounded[key] = { type: "object", keys: Object.keys(value).length };
    } else {
      bounded[key] = { type: typeof value };
    }
  }
  return bounded;
};

/**
 * Build the factory both transports serve from: one fresh `McpServer` per serving unit (one stdio
 * connection, or one HTTP request under `createMcpHandler`), all registering the same surface.
 *
 * One parent client is built per enabled mode; different modes have separate transport state.
 * Under `stdio` that parent carries the environment's Hudu credential and origin and is the client
 * every instance uses. Under `http` the parent carries no credential at all and only a placeholder
 * origin: each request's `x-hudu-base-url` and `x-hudu-api-key` are resolved into a scoped client
 * built as a fresh `HuduClient` (the SDK's `withAuth()` cannot carry a base URL), and a request
 * with no key — or a key with no origin — resolves to a placeholder client that throws before any
 * Hudu request is built, so `tools/list` works while every tool call fails closed — see
 * {@link resolveHuduClient}.
 *
 * The old boot prewarm of the body index is gone with the server-held key: it warmed a credential
 * nobody uses under `http`, and it would have walked the whole corpus once per process against a
 * key that is never the caller's. The index now warms per credential on that credential's first
 * search, and the scoped-client cache keeps it warm across that caller's later calls.
 *
 * `log` is handed to the client twice over: as its request log sink, and as the sink for the audit
 * hook. Without the hook there is no record of what a model actually asked Hudu for — the tool call
 * is visible to the MCP client, but the requests it turned into are not (design spec §5.6).
 */
export function createMcpServerFactory(config: Config, log: Logger): McpServerFactory {
  // Under `http` the origin is per-request; the placeholder exists only so the credential-less
  // clients can be constructed. It is a reserved RFC 6761 domain that nothing in the real world
  // resolves — if any code path ever dialed it, the failure would be unmistakable — and its label
  // says what it is, since the parent client's log and audit lines carry this origin.
  const HTTP_PLACEHOLDER_ORIGIN = 'https://no-hudu-origin.invalid';
  const options: HuduConfig = {
    baseUrl: config.MCP_TRANSPORT === 'http' ? HTTP_PLACEHOLDER_ORIGIN : config.HUDU_BASE_URL!,
    logger: log,
    // Omitted entirely when unset, so the SDK's own default stays the default rather than being
    // shadowed by a local copy of its value.
    ...(config.HUDU_SEARCH_MAX_INDEX_PAGES === undefined
      ? {}
      : { search: { maxIndexPages: config.HUDU_SEARCH_MAX_INDEX_PAGES } }),
    // One line per Hudu request, on the success and the error path. The SDK redacts every
    // credential-shaped key out of the event, and the path stays query-free — but the SDK does not
    // redact query *values*, so the sink records only each query value's shape. This prevents a
    // search string or free-form operation input from reaching logs, while preserving keys and
    // safe numeric/boolean filters for diagnosis.
    onAudit: (event) => log.info('hudu request', {
      ...event,
      ...(event.query !== undefined ? { query: boundAuditQuery(event.query) } : {}),
    }),
  };

  // Separate effect clients prevent the read dispatcher from ever borrowing mutation authority.
  // Reads are included for SDK helper dependencies; write filters never widen the SDK's mode.
  const reads = CAPABILITY_NAMES.filter((key) => getCapability(key)?.effect === 'read');
  const build = (mode: 'read' | 'write' | 'delete') => {
    const allowOperations = mode === 'read' || config.HUDU_READ_ONLY || config.HUDU_WRITE_POLICY === 'deny'
      ? reads
      : config.HUDU_WRITE_POLICY === 'allow_list'
        ? [...reads, ...config.HUDU_WRITE_ALLOW.filter((key) => getCapability(key)?.effect === (mode === 'delete' ? 'destructive' : 'write'))]
        : undefined;
    const scopedOptions = { ...options, mode, reveal: false, ...(allowOperations ? { allowOperations } : {}) };
    const parent = config.MCP_TRANSPORT === 'stdio'
      ? new HuduClient({ ...scopedOptions, apiKey: config.HUDU_API_KEY! })
      : new HuduClient({ ...scopedOptions, auth: NO_SERVER_CREDENTIAL });
    // Built in both transports: under `stdio` it is never resolved (the parent wins first); under
    // `http` it is the fail-closed target for a key that names no origin.
    const noBase = new HuduClient({ ...scopedOptions, auth: NO_REQUEST_BASE_URL });
    const badBase = new HuduClient({ ...scopedOptions, auth: INVALID_REQUEST_BASE_URL });
    const baseRefused = new HuduClient({ ...scopedOptions, auth: BASE_URL_NOT_ALLOWED });
    return {
      parent,
      noBase,
      badBase,
      baseRefused,
      // Fresh clients, not `parent.withAuth(key)`: a scoped client must carry the request's origin
      // as well as its credential, and `withAuth()` can carry the credential only.
      scopes: new ScopedClientCache(
        (baseUrl, apiKey) => new HuduClient({ ...scopedOptions, baseUrl, apiKey }),
        MAX_SCOPED_CLIENTS,
        log,
      ),
    };
  };
  const read = build('read');
  const mutations = config.HUDU_READ_ONLY ? undefined : { write: build('write'), delete: build('delete') };

  return (ctx: McpRequestContext) => {
    const resolve = (entry: ModeEntry) => resolveHuduClient(entry, config, ctx);
    const { client: hudu, origin: huduOrigin } = resolve(read);
    const mutationClients = mutations ? { write: resolve(mutations.write).client, delete: resolve(mutations.delete).client } : undefined;
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION, title: 'Hudu MCP Server' });
    registerTools(server, { hudu, huduOrigin, config, log, ...(mutationClients ? { mutationClients } : {}) });
    return server;
  };
}
