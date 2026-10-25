/**
 * tools/server.ts — the per-serving-unit `McpServer` factory and the per-(origin, credential)
 * client cache behind it.
 */
import { McpServer, type McpRequestContext, type McpServerFactory } from '@modelcontextprotocol/server';
import { createHash } from 'node:crypto';
import { CAPABILITY_NAMES, getCapability } from 'node-hudu/capabilities';
import { createRequire } from 'node:module';
import { getHeapStatistics } from 'node:v8';
import { HuduClient } from 'node-hudu';
import { AuthError, HuduConfigError } from 'node-hudu';
import type { AuthStrategy, HuduConfig } from 'node-hudu';
import { applyReadOnly, type Config } from '../config.js';
import type { Logger } from '../logger.js';
import { headerRecord, readHuduBase, readHuduKey } from '../auth.js';
import { baseHostAllowed, originOf } from '../base-hosts.js';
import { CREDENTIAL_LOAD_HINT, detectCredentialShape, type CredentialAnomaly } from '../credential.js';
import { SCOPED_INDEX_BUDGET_DIVISOR, indexTextBudgetBytes, scopedIndexMaxDocs, scopedIndexTextBudgetBytes } from '../search-budget.js';
import { runWithCredentialShapeView, type CredentialShapeView } from './results.js';
import { registerTools } from './register.js';
import { answerRenamedTools } from './renamed.js';
import { slimToolSchemas } from './slim.js';

/** Identity this server reports in `initialize`. The version is this repo's, not the SDK's. */
const SERVER_NAME = 'iit-mcp-hudu';
const SERVER_VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;

/**
 * The maximum number of per-(origin, credential) scoped clients kept warm in one process.
 *
 * Each scoped client owns its own Hudu knowledge index. An unbounded map would let enough distinct
 * callers grow the heap past the container limit, so the cache is capped and evicts
 * least-recently-used first. The cap is the same number the process-wide index text budget is
 * divided by (`search-budget.ts`), so eight clients share one pool instead of each claiming it.
 */
export const MAX_SCOPED_CLIENTS = SCOPED_INDEX_BUDGET_DIVISOR;

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
 * A strategy that refuses to produce headers because the request's own credential value is
 * MALFORMED — the pre-dispatch shape gate for the http intake path (2026-10-07 Autotask incident
 * class, see `src/credential.ts`).
 *
 * Sibling of {@link NO_REQUEST_BASE_URL}, and it exists for the same reason: a refusal must happen
 * BEFORE a `HuduClient` is constructed, so the malformed value cannot reach the wire even as far as
 * client construction. The refusal carries the anomaly names and never a character of the value.
 */
function malformedCredentialStrategy(anomalies: readonly CredentialAnomaly[]): AuthStrategy {
  return {
    // A typed AuthError, not a plain throw: node-hudu 0.13.x rethrows a strategy's own AuthError
    // unchanged, while a plain throw is wrapped into a fixed message that carries only the name.
    // The SDK's AuthError constructor pins its own code and category, so the marker
    // `tools/results.ts` reads back is the anomaly list attached to the instance — never message
    // parsing.
    name: 'x-hudu-api-key malformed',
    async headers() {
      throw malformedCredentialRefusal(anomalies);
    },
  };
}

/** The typed refusal a malformed credential answers with; `errorContent` maps it to CREDENTIAL_MALFORMED. */
function malformedCredentialRefusal(anomalies: readonly string[]): AuthError {
  const refusal = new AuthError('this request presented a credential whose shape is malformed; nothing was dialed', {
    suggestedAction: CREDENTIAL_LOAD_HINT,
  });
  (refusal as { anomalies?: readonly string[] }).anomalies = anomalies;
  return refusal;
}

/** The error a refusing placeholder client's strategy surfaces, as `errorContent` renders it for every other tool. */
function placeholderRefusal(strategy: AuthStrategy): AuthError {
  return new AuthError(`Auth strategy "${strategy.name}" did not produce usable credential headers; no request was sent`);
}

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
  /**
   * Build one more fail-closed placeholder client for this mode, from the same option literal the
   * named placeholders use. Only the malformed-credential placeholder needs it, because its
   * strategy carries the anomalies seen.
   */
  buildPlaceholder: (auth: AuthStrategy) => HuduClient;
  /**
   * The malformed-credential clients, one per anomaly set seen so far (the empty set is the
   * node-hudu shape-gate tripwire: the server gate passed but the SDK's own gate refused).
   *
   * Lazily built and cached rather than one per mode: the strategy carries the anomaly names,
   * the anomaly set is small and bounded (`CREDENTIAL_ANOMALIES`), and a fresh `HuduClient` per
   * malformed request would let a caller allocate a client (and its 64 MB text budget) per request
   * — which is the resource the scoped-client cap exists to protect. The cache is bounded by the
   * power set of the anomalies in `CREDENTIAL_ANOMALIES` plus the empty set, i.e. it cannot grow
   * with request volume.
   */
  malformed: Map<string, HuduClient>;
}

/** A header value that is present and non-blank; anything else is treated as not sent. */
const usable = (v: string | undefined) => (v === undefined || v.trim().length === 0 ? undefined : v);

/**
 * Which credential an http request presents: the usable header key and base, and whether the
 * origin is caller-named. The request key wins; the server-held `HUDU_API_KEY` is dialed only when
 * no header key came and the origin is not caller-named. One rule, shared by the dispatcher
 * ({@link resolveHuduClient}) and the 401 shape view ({@link buildCredentialShapeView}).
 */
function presentedCredential(config: Config, headers: ReturnType<typeof headerRecord> | undefined) {
  const headerKey = usable(headers === undefined ? undefined : readHuduKey(headers));
  const headerBase = usable(headers === undefined ? undefined : readHuduBase(headers));
  const defaultOrigin = config.HUDU_BASE_URL === undefined ? undefined : originOf(config.HUDU_BASE_URL);
  const headerOrigin = headerBase === undefined ? undefined : originOf(headerBase);
  // An unparsable header value is caller-named even when there is no default to differ from: two
  // `undefined` origins must not read as "the default", or the default key would be paired with it.
  const callerNamed = headerBase !== undefined && (headerOrigin === undefined || headerOrigin !== defaultOrigin);
  return { headerKey, headerBase, callerNamed, envKeyPresented: headerKey === undefined && !callerNamed };
}

/**
 * The credential anomalies a 401 on this serving unit may be annotated with: ONLY those of the
 * credential actually presented. Under stdio that is the env key; under http the request key wins,
 * and the env key's anomalies join only when it is the one that would be dialed. (A malformed key
 * from either source is refused pre-dial, so a real 401 is almost always clean-shape.)
 */
export function buildCredentialShapeView(config: Config, headers: ReturnType<typeof headerRecord> | undefined): CredentialShapeView {
  const anomaliesOf = (k: string | undefined) => {
    const a = k === undefined ? [] : detectCredentialShape(k);
    return a.length > 0 ? a : undefined;
  };
  if (config.MCP_TRANSPORT === 'stdio') return { env: anomaliesOf(config.HUDU_API_KEY) };
  const { headerKey, envKeyPresented } = presentedCredential(config, headers);
  return { env: envKeyPresented ? anomaliesOf(config.HUDU_API_KEY) : undefined, request: anomaliesOf(headerKey) };
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
export function resolveHuduClient(entry: ModeEntry, config: Config, ctx: McpRequestContext, log: Logger): { client: HuduClient; origin?: string; refusal?: AuthError } {
  if (config.MCP_TRANSPORT === 'stdio') return { client: entry.parent, origin: new URL(config.HUDU_BASE_URL!).origin };
  const headers = ctx.requestInfo === undefined ? undefined : headerRecord(ctx.requestInfo.headers);
  const { headerKey, headerBase, callerNamed } = presentedCredential(config, headers);
  const defaultBase = config.HUDU_BASE_URL;

  const base = headerBase ?? defaultBase;
  // Only a caller-named origin is subject to the allow-list, and naming the default one is free.
  // Keep `undefined` distinct from an explicit list in config: with a configured default, an
  // omitted list means default-only; without one it preserves documented BYO-origin mode.
  const callerOriginAllowed = config.HUDU_ALLOWED_BASE_HOSTS === undefined
    ? defaultBase === undefined
    : baseHostAllowed(headerBase!, config.HUDU_ALLOWED_BASE_HOSTS);
  if (callerNamed && !callerOriginAllowed) {
    return { client: entry.baseRefused, refusal: placeholderRefusal(BASE_URL_NOT_ALLOWED) };
  }

  const key = headerKey ?? (callerNamed ? undefined : config.HUDU_API_KEY);
  if (key === undefined) return { client: entry.parent, refusal: placeholderRefusal(NO_SERVER_CREDENTIAL) };
  // Pre-dispatch shape gate, on the value this request will actually present: a credential whose
  // bytes were mangled by the load is refused HERE, before a client is constructed and so before
  // the first dial. The check is on whichever value won above, so it covers the per-request header
  // and the server-held `HUDU_API_KEY` default alike.
  const anomalies = detectCredentialShape(key);
  if (anomalies.length > 0) {
    // One line, and no part of the value: the anomalies are the diagnostic, and the key is a
    // per-caller secret that must never reach a log sink.
    log.warn('refused a malformed Hudu credential before dialing', {
      source: headerKey === undefined ? 'HUDU_API_KEY' : 'x-hudu-api-key',
      anomalies,
      length: key.length,
      hint: CREDENTIAL_LOAD_HINT,
    });
    const id = anomalies.join(',');
    let client = entry.malformed.get(id);
    if (client === undefined) {
      client = entry.buildPlaceholder(malformedCredentialStrategy(anomalies));
      entry.malformed.set(id, client);
    }
    return { client, refusal: malformedCredentialRefusal(anomalies) };
  }
  if (base === undefined) return { client: entry.noBase, refusal: placeholderRefusal(NO_REQUEST_BASE_URL) };
  try {
    const client = entry.scopes.for(base, key);
    // Only publish an origin after the dispatched client has passed SDK validation.
    return { client, origin: new URL(base).origin };
  } catch (err) {
    // Only the SDK's config validation is caller error; anything else is a bug and must surface.
    if (err instanceof HuduConfigError) {
      // The pre-dispatch gate above is a superset of the SDK's own shape gate (node-hudu 0.13.2);
      // the SDK's INVALID_CREDENTIAL_SHAPE firing here means the two have diverged. Fail closed with
      // the typed credential refusal — nothing was dialed — rather than the base-URL placeholder,
      // which would misname the cause.
      if ((err as { code?: string }).code === 'INVALID_CREDENTIAL_SHAPE') {
        log.warn('the SDK credential shape gate fired where the server gate passed; the gates have diverged', { source: 'node-hudu' });
        const id = '';
        let client = entry.malformed.get(id);
        if (client === undefined) {
          client = entry.buildPlaceholder(malformedCredentialStrategy([]));
          entry.malformed.set(id, client);
        }
        return { client, refusal: malformedCredentialRefusal([]) };
      }
      return { client: entry.badBase, refusal: placeholderRefusal(INVALID_REQUEST_BASE_URL) };
    }
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
export function createMcpServerFactory(requested: Config, log: Logger): McpServerFactory {
  // HUDU_READ_ONLY=true is a hard override of the write policy; everything below sees the effective config.
  const config = applyReadOnly(requested);
  // Under `http` the origin is per-request; the placeholder exists only so the credential-less
  // clients can be constructed. It is a reserved RFC 6761 domain that nothing in the real world
  // resolves — if any code path ever dialed it, the failure would be unmistakable — and its label
  // says what it is, since the parent client's log and audit lines carry this origin.
  const HTTP_PLACEHOLDER_ORIGIN = 'https://no-hudu-origin.invalid';
  const heapLimitBytes = getHeapStatistics().heap_size_limit;
  // The process-wide body-index text pool, and the doc cap derived from that same pool (search-budget.ts).
  const poolTextBytes = indexTextBudgetBytes(heapLimitBytes);
  const poolMaxDocs = scopedIndexMaxDocs(poolTextBytes);
  const options: HuduConfig = {
    baseUrl: config.MCP_TRANSPORT === 'http' ? HTTP_PLACEHOLDER_ORIGIN : config.HUDU_BASE_URL!,
    logger: log,
    // 0.12.0 adoption: the opt-ins every client this factory builds gets (the parent, the
    // fail-closed placeholders and the per-scope clients), in one literal so a later option added
    // here cannot drift between them. Precedence: explicit env > profile > SDK default.
    // `profile: 'agent'` fills the options left unset with the agent preset (20 s whole-call
    // deadline, 1 retry, 240/min rate limit, concurrency 3, bounded resolution scans). It stays
    // a deployment-wide constant (no env override), so every option this server sets explicitly
    // wins over it; the rate-limit bucket is per client, i.e. per (origin, credential) scope.
    // `timeoutMs` is a fixed 30 s. It is ALWAYS passed
    // explicitly, so it stays above the profile's 20 s deadline regardless of preset: the
    // preset's 20 s would shorten a cold `tier:'index'` body-index walk that the 0.9.2 deployment
    // tolerated at the SDK's 30 s, and a cold-scope search must not start timing out because of
    // an upgrade.
    // `cache` is the SDK's `recommended` per-entity read-through TTL preset (1 h structural / 5 min mutable / 1 min
    // base). Caches are per
    // client, hence per scope — a write through the write or delete client does NOT clear the
    // read client's cache (separate instances), so the dispatchers call the read client's
    // `clearCache()` after every write or delete attempt (src/tools/dispatch.ts). A write from
    // another process is still TTL-bounded stale.
    // `cooldown` is the 429 cooldown gate, always on; a
    // locally refused call answers with RateLimitError.notSent, which the error envelope
    // surfaces so a local refusal stays distinguishable from a vendor rejection.
    // The literal-IP SSRF floor is NOT here: it applies to the per-scope clients only (below) —
    // the caller-named origins are the untrusted surface. The operator's own base (the
    // HUDU_BASE_URL under stdio, the default origin under http) is trusted at the process / env
    // boundary, and flooring it would break an on-prem install whose Hudu sits on a literal
    // private IP. No env override: it is a security property, not a deployment preference.
    profile: 'agent',
    cache: 'recommended',
    // The body index's text budget follows the process's own heap ceiling, so a small container
    // reports index state "partial" instead of dying at the V8 heap limit (#51). This value is the
    // PROCESS-wide pool: the scoped clients below each take a share of it, since each materialises
    // its own index. The parent client keeps the pool because under `stdio` it is the only client.
    // HUDU_SEARCH_INDEX_TTL, when set, is the body index's TTL (the SDK default is 10 minutes).
    search: {
      maxIndexTextBytes: poolTextBytes,
      // The doc cap comes from the SAME pool: the text budget bounds extracted text only, while a
      // document whose text it evicted keeps its record and postings, and the SDK's own default is
      // 50,000 documents. One document per KiB of text budget, so the two caps grow together.
      // HONEST SCOPE: the SDK upserts every walked document and applies this cap only AFTER the walk,
      // so `maxDocs` bounds the RETAINED index, not the build peak; the peak during a walk is bounded
      // by the heap ceiling and the text budget's eviction (an estimate, not a proof), and a capped
      // index reports index state "partial".
      maxDocs: poolMaxDocs,
      ...(config.HUDU_SEARCH_INDEX_TTL === undefined ? {} : { indexTtlMs: config.HUDU_SEARCH_INDEX_TTL }),
    },
    timeoutMs: 30000,
    cooldown: { enabled: true },
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
  // A write operation may delegate to another write (articles.patchSection -> articles.update); the SDK
  // refuses the delegate unless it is allowed too, so granting the parent grants its write dependencies.
  const withWriteDependencies = (key: string, effect: string): string[] => [key, ...(getCapability(key)?.dependsOn ?? []).filter((dep) => getCapability(dep)?.effect === effect)];
  const build = (mode: 'read' | 'write' | 'delete') => {
    const allowOperations = mode === 'read' || config.HUDU_WRITE_POLICY === 'deny'
      ? reads
      : config.HUDU_WRITE_POLICY === 'allow_list'
        ? [...reads, ...config.HUDU_WRITE_ALLOW.filter((key) => getCapability(key)?.effect === (mode === 'delete' ? 'destructive' : 'write')).flatMap((key) => withWriteDependencies(key, mode === 'delete' ? 'destructive' : 'write'))]
        : undefined;
    const scopedOptions = { ...options, mode, reveal: false, ...(allowOperations ? { allowOperations } : {}) };
    // ONE scoped client's share of the process pool: the cache can hold MAX_SCOPED_CLIENTS of them,
    // so handing each the whole pool would let the process hold 8x the text it was sized for (#51).
    // Only the per-(origin, credential) clients are divided — the parent keeps the pool, because
    // under `stdio` it is the only client and a deeper index is the point of serving that way.
    const scopedTextBytes = scopedIndexTextBudgetBytes(heapLimitBytes);
    const scopedSearch = { ...options.search, maxIndexTextBytes: scopedTextBytes, maxDocs: scopedIndexMaxDocs(scopedTextBytes) };
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
      buildPlaceholder: (auth: AuthStrategy) => new HuduClient({ ...scopedOptions, auth }),
      malformed: new Map<string, HuduClient>(),
      // Fresh clients, not `parent.withAuth(key)`: a scoped client must carry the request's origin
      // as well as its credential, and `withAuth()` can carry the credential only.
      // `blockPrivateHosts` floors the CALLER-named origin only (literal-IP SSRF, fail-closed at
      // construction): it complements the HUDU_ALLOWED_BASE_HOSTS hostname matcher in
      // base-hosts.ts (which alone can express wildcard suffixes) and holds even in
      // bring-your-own-origin mode, where that matcher is wide. `allowedHosts` is deliberately not
      // passed: it cannot express the hostname matcher's wildcard suffixes, and the private bound
      // wins over it anyway.
      scopes: new ScopedClientCache(
        (baseUrl, apiKey) => new HuduClient({ ...scopedOptions, baseUrl, apiKey, blockPrivateHosts: true, search: scopedSearch }),
        MAX_SCOPED_CLIENTS,
        log,
      ),
    };
  };
  const read = build('read');
  const mutations = config.HUDU_WRITE_POLICY === 'deny' ? undefined : { write: build('write'), delete: build('delete') };

  return (ctx: McpRequestContext) => {
    const resolve = (entry: ModeEntry) => resolveHuduClient(entry, config, ctx, log);
    // Per serving unit (one stdio connection, or one HTTP request): the anomalies of the credential
    // this unit presents, published before the first tool can fail (see buildCredentialShapeView).
    const shapeView = buildCredentialShapeView(config, ctx.requestInfo === undefined ? undefined : headerRecord(ctx.requestInfo.headers));
    const { client: hudu, origin: huduOrigin, refusal } = resolve(read);
    const mutationClients = mutations ? { write: resolve(mutations.write).client, delete: resolve(mutations.delete).client } : undefined;
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION, title: 'Hudu MCP Server' });
    answerRenamedTools(server);
    slimToolSchemas(server);
    // Every handler registered below runs inside this request's view scope (see results.ts).
    const register = server.registerTool.bind(server) as (name: string, config: unknown, cb: (...a: unknown[]) => unknown) => unknown;
    (server as { registerTool: unknown }).registerTool = (name: string, config: unknown, cb: (...a: unknown[]) => unknown) =>
      register(name, config, (...a: unknown[]) => runWithCredentialShapeView(refusal === undefined ? shapeView : { ...shapeView, refusal }, () => cb(...a)));
    registerTools(server, { hudu, huduOrigin, config, log, ...(mutationClients ? { mutationClients } : {}) });
    return server;
  };
}
