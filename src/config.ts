/**
 * config.ts — the process's entire configuration surface, validated once at boot.
 *
 * Every knob is an environment variable. The server refuses to start on an invalid config rather
 * than failing at the first tool call: a missing credential discovered by a model mid-conversation
 * is a far worse failure than a container that never came up.
 *
 */
import * as z from 'zod';
import type { HuduConfig } from 'node-hudu';
import { getCapability } from 'node-hudu/capabilities';
import { SEARCH_RESOURCES } from 'node-hudu/mcp';
import { CREDENTIAL_LOAD_HINT, detectCredentialShape } from './credential.js';
import { isWriteEffect } from './policy.js';

/**
 * `stdio` is the local path (Claude Code, Claude Desktop, VS Code): one process, one credential,
 * the process boundary IS the trust boundary. `http` is the remote path (an HTTP MCP client)
 * and takes the caller's Hudu credential per request.
 */
export const TRANSPORTS = ['stdio', 'http'] as const;
export type Transport = (typeof TRANSPORTS)[number];

/**
 * The deployment's authority over `hudu_read / hudu_write / hudu_delete`'s write surface.
 *
 * `deny` is the default on purpose: an operator who forgets the variable gets a read-only server,
 * never an open one. `all` is today's behaviour and has to be typed out deliberately.
 */
export const WRITE_POLICIES = ['deny', 'allow_list', 'all'] as const;
export type WritePolicy = (typeof WRITE_POLICIES)[number];

/**
 * The deployment's authority over reads that can return a plaintext credential.
 *
 * `asset_passwords.get` returns `password` and `otp_secret` in plaintext as an ordinary read, so no
 * write policy touches it — so it needs its own flag that closes both reachable paths in one place. `deny` is the default for the same reason
 * {@link WRITE_POLICIES} defaults that way: an operator who forgets the variable gets a server that
 * cannot hand a secret to a model, never one that can.
 */
export const SECRET_READ_POLICIES = ['deny', 'allow'] as const;
export type SecretReadPolicy = (typeof SECRET_READ_POLICIES)[number];

/**
 * The deployment's authority over the body-index tier `hudu_search` uses.
 *
 * The tier decides whether a call may WAIT for a corpus-wide index walk. That is a budget question
 * the calling model cannot observe — it knows neither the index's warmth nor the walk's duration —
 * so it is deployment policy, not a request parameter: `auto` answers from Hudu search now and
 * builds the body index in the background, `index` may wait for a complete body-index answer, and
 * `vendor` never builds an index at all. Unset means the transport default: `index` under `stdio`
 * (one long-lived credential, one warmed index) and `auto` under `http` (every caller's scope
 * starts cold, and a cold walk can outlast the consumer's call timeout).
 *
 * `typesense` answers the body search from Hudu's own Typesense index. It has no cold start, so it
 * is the default under BOTH transports when `HUDU_TYPESENSE_URL` / `HUDU_TYPESENSE_API_KEY` are set
 * — the transport asymmetry exists only for the in-memory walk. Naming it without that pair fails
 * boot: a tier that cannot run must not be reachable by configuration typo.
 */
export const SEARCH_TIER_POLICIES = ['auto', 'index', 'vendor', 'typesense'] as const;
export type SearchTierPolicy = (typeof SEARCH_TIER_POLICIES)[number];

/** A blank value is a copied `.env.example` placeholder, never a value: normalise it to unset. */
function blankToUndefined(raw: unknown): unknown {
  return typeof raw === 'string' && raw.trim() === '' ? undefined : raw;
}

/**
 * The Typesense body-search tier's fixed defaults. Of the knobs the design names, only the
 * collection names, the deadline and the verification gate are environment-tunable.
 *
 * Two knobs are deliberately NOT here and NOT set by this server: the candidate count and the
 * circuit-breaker window. They are the SDK's own calibrated values (DESIGN §3 WP-1) — 40 candidates
 * and a 30 s cooldown at node-hudu 0.21.0 — and this server passes neither key, so the library's
 * calibration applies and CANNOT be shadowed by a stale copy here. The intent is not left untested:
 * `test/typesense-config.test.ts` reads the RESOLVED SDK config and asserts those two values, so a
 * recalibration in a future node-hudu release fails a test and shows up in review instead of
 * silently changing behaviour.
 */
export const TYPESENSE_DEFAULTS = {
  /** Hudu's own collection names, so an operator who provisions a search-only key sets nothing. */
  articlesCollection: 'articles',
  assetsCollection: 'assets',
  /** Whole-call deadline for one Typesense search request. */
  timeoutMs: 4000,
  /** Refused above this: one search must never become the slowest thing in a tool call. */
  maxTimeoutMs: 15000,
} as const;

/**
 * The `search.typesense` block handed to the SDK, or `undefined` when the tier is off.
 *
 * Kept out of {@link Config} on purpose: `Config` is the environment surface, and this block is a
 * derived view of it (defaults applied, blanks normalised). Both variables must be set for the
 * block to exist — `loadConfig` refuses a half-configured pair before this is ever called.
 */
export type TypesenseSearchBlock = Omit<NonNullable<NonNullable<HuduConfig['search']>['typesense']>, 'collections'> & {
  collections: { articles: string; assets: string };
};

/**
 * Whether `url` is an http(s) ORIGIN: no path, query or fragment.
 *
 * The boot check in `loadConfig`'s refinement applies these rules with a per-cause message; this
 * predicate is the one the zero-wire doctor reports on, so the two cannot disagree about "shape ok".
 */
export function isTypesenseOrigin(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (parsed.pathname === '' || parsed.pathname === '/') &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
}

/** Build the SDK block from an already-validated config. Never carries a value into a log sink. */
export function typesenseSearchBlock(config: Config): TypesenseSearchBlock | undefined {
  const url = config.HUDU_TYPESENSE_URL;
  const apiKey = config.HUDU_TYPESENSE_API_KEY;
  if (url === undefined || apiKey === undefined) return undefined;
  return {
    url,
    apiKey,
    collections: {
      articles: config.HUDU_TYPESENSE_ARTICLES_COLLECTION ?? TYPESENSE_DEFAULTS.articlesCollection,
      assets: config.HUDU_TYPESENSE_ASSETS_COLLECTION ?? TYPESENSE_DEFAULTS.assetsCollection,
    },
    timeoutMs: config.HUDU_TYPESENSE_TIMEOUT_MS ?? TYPESENSE_DEFAULTS.timeoutMs,
    // No `candidateLimit` and no `cooldownMs`: both are the SDK's calibration, and omission is what
    // keeps this server from pinning a copy that silently overrides a future recalibration.
    verifyHits: config.HUDU_TYPESENSE_VERIFY_HITS ?? true,
  };
}

/**
 * The one boot-time line describing the tier — `undefined` when it is off.
 *
 * Shape only: never the URL or the key, only the collection names the operator can already read in
 * the environment. A disabled feature is INVISIBLE in boot output, because the byte-identical
 * promise for unset deployments covers the log as well as the tool surface. Exported so a test can
 * assert the line without booting a server.
 */
export function describeTypesense(config: Config): string | undefined {
  const block = typesenseSearchBlock(config);
  if (block === undefined) return undefined;
  return `typesense: enabled (collections ${block.collections.articles}, ${block.collections.assets})`;
}

/** The tier a search call may use: the policy values are exactly the tiers the SDK implements. */
export type SearchTier = SearchTierPolicy;

/**
 * Parse `HUDU_WRITE_ALLOW` once, here, so every consumer reads the same list. */
function parseAllowList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

/**
 * Parse `HUDU_SEARCH_RESOURCES` once, here, so every consumer reads the same list.
 *
 * `undefined` means the variable is unset: the SDK's full searchable set. A set-but-empty value is
 * a list, not a default — the caller asked to narrow the surface and named nothing, which is a
 * config error rather than a server that silently searches nothing.
 */
function parseSearchResources(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const parsed = raw
    .split(',')
    .map((resource) => resource.trim())
    .filter((resource) => resource.length > 0);
  // Normalise duplicates: a repeated name would otherwise inflate the effective list's length and
  // make a membership check against the SDK set read as "full" while a resource is missing.
  return [...new Set(parsed)];
}

/**
 * Parse `HUDU_ALLOWED_BASE_HOSTS`: unset or blank stays `undefined` (no list); otherwise a
 * lowercased, de-duplicated list. Validation of the entries happens in the schema refinement.
 */
function parseBaseHosts(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = raw
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
  return [...new Set(parsed)];
}

/**
 * A plausible hostname label (RFC 952/1123): 1-63 characters of lowercase alphanumerics and
 * hyphens, no leading or trailing hyphen. The `*` wildcard is not a real label: it is legal only
 * as the first label of a `*.` suffix entry, which the caller strips before delegating here.
 */
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Whether an entry could match a real hostname, or only a typo.
 *
 * The boot-time regex below rejects what is plainly not a hostname (scheme, port, path, a bare
 * `*`), but its middle `[a-z0-9.-]*` also admits entries that are structurally impossible in any
 * parsed hostname: an empty label (consecutive or edge dots), a label over 63 characters, or a
 * label with a leading or trailing hyphen. Such an entry boots cleanly and then sits in an active
 * list matching nothing — a silent dead entry, so it must fail boot just like a scheme or port
 * entry (see `baseHostAllowed` for what a live entry matches).
 */
function isPlausibleHost(entry: string): boolean {
  const body = entry.startsWith('*.') ? entry.slice(2) : entry;
  if (body === '') return false;
  return body.split('.').every((label) => HOST_LABEL.test(label));
}

const schema = z
  .object({
    /**
     * The Hudu origin. Required under `stdio`; an optional default under `http`.
     *
     * On `stdio` the process IS the trust boundary, so the origin comes from the environment like
     * any other local configuration. Under `http` it is the origin a request falls back to when it
     * sends no `x-hudu-base-url`; a header, when present, still wins. A blank value
     * (`HUDU_BASE_URL=`, as a copied `.env.example` leaves it) is normalised to unset first: an
     * empty string is not an origin, so it must mean "no default" rather than fail boot.
     */
    HUDU_BASE_URL: z.preprocess(
      (raw) => (typeof raw === 'string' && raw.trim() === '' ? undefined : raw),
      z.string().url('HUDU_BASE_URL must be an absolute URL, e.g. https://hudu.example.com').optional(),
    ),
    /**
     * The server-held Hudu credential — required on `stdio`, an optional default on `http`.
     *
     * On `stdio` the process IS the trust boundary, so the key comes from the environment like any
     * other local credential. On `http` the key normally arrives per request in `x-hudu-api-key`;
     * when set here it is the default for a request that brings none, and is only ever presented to
     * the default `HUDU_BASE_URL` (see `resolveHuduClient`). A blank value (`HUDU_API_KEY=`, as a
     * copied `.env.example` leaves it) is normalised to unset first: an empty string is not a
     * credential, so it must select the same path an absent variable does rather than fail boot.
     */
    HUDU_API_KEY: z.preprocess(
      (raw) => (typeof raw === 'string' && raw.trim() === '' ? undefined : raw),
      z.string().min(1, 'HUDU_API_KEY must not be empty').optional(),
    ),
    /**
     * Hosts a caller may name in `x-hudu-base-url` under `http` — the SSRF guard for that header.
     *
     * Comma-separated exact hostnames or `*.example.com` subdomain suffixes. When unset alongside
     * a default `HUDU_BASE_URL`, only that default origin is accepted. When both are unset, any
     * caller-named origin would be accepted (bring-your-own-origin mode, where the SDK still requires
     * http/https and no path), so that mode must be opted into with {@link HUDU_ALLOW_ANY_BASE_HOST}.
     * The default `HUDU_BASE_URL` is always usable and is not checked against an explicit list.
     * Ignored under `stdio`, where no caller names an origin.
     */
    HUDU_ALLOWED_BASE_HOSTS: z.string().optional().transform(parseBaseHosts),
    /**
     * Explicit opt-out of the allow-list requirement under `http`. When `true` and no list is set,
     * any origin a caller names in `x-hudu-base-url` is accepted (the SDK still requires http/https
     * and no path), so the server will send requests, with the caller's key, to hosts of the
     * caller's choosing. Only for a listener reachable by trusted callers alone. Defaults to `false`.
     */
    HUDU_ALLOW_ANY_BASE_HOST: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
    MCP_TRANSPORT: z.enum(TRANSPORTS).default('stdio'),
    /**
     * The resources `hudu_search` may offer and query — the read-edge counterpart to
     * `HUDU_WRITE_POLICY`.
     *
     * The SDK publishes eight searchable resources, but a deployment's Hudu credential can read
     * fewer (a Hudu API key inherits its user's role). Unset means the SDK's full set; set it to the
     * resources THIS credential can read so the tool never advertises a guaranteed-empty search and
     * a model never spends a turn on a resource the key is not allowed to read. Every name is
     * validated against the SDK's searchable set at boot, so a typo fails the container instead of a
     * call weeks later. Applies to `hudu_search`, `hudu_resolve_any` and the same operations through `hudu_read`; the dedicated per-resource resolve tools are unaffected.
     */
    HUDU_SEARCH_RESOURCES: z.string().optional().transform(parseSearchResources),
    /**
     * The tier `hudu_search` uses when the caller names none — see {@link SEARCH_TIER_POLICIES}.
     * Unset keeps the transport default (`index` under stdio, `auto` under http); `vendor` is
     * forced when `HUDU_SEARCH_RESOURCES` excludes the corpus the index walks.
     */
    HUDU_SEARCH_TIER_POLICY: z.enum(SEARCH_TIER_POLICIES).optional(),
    /**
     * The in-memory body index's TTL in milliseconds (the SDK's `search.indexTtlMs`, default
     * 10 minutes). After it, an answer is marked stale and the next search rebuilds in the
     * background; a shorter value trades vendor-tier reads for fresher bodies.
     */
    HUDU_SEARCH_INDEX_TTL: z.coerce.number().int().positive().optional(),
    /**
     * The Typesense body-search endpoint: the origin only, e.g.
     * `https://typesense.hudu.intellectit.com.au`, or `http://127.0.0.1:8108` through an SSH tunnel
     * (DESIGN §7.3). No path, query or fragment — a Typesense base URL is an origin and a path there
     * would silently point every search at nothing.
     *
     * Set together with {@link HUDU_TYPESENSE_API_KEY} or not at all: `loadConfig` refuses a
     * half-configured pair, because a URL with no key is an unreachable tier and a key with no URL
     * has nowhere to go. Both unset means the tier is off and the server behaves exactly as before.
     */
    HUDU_TYPESENSE_URL: z.preprocess(
      blankToUndefined,
      z.string().url('HUDU_TYPESENSE_URL must be an absolute URL, e.g. https://typesense.example.com').optional(),
    ),
    /**
     * The Typesense search-only key (`documents:search` on the two body collections). Never logged,
     * never echoed in an error, never part of `doctor` output — a boolean and a probe result code
     * are the only facts that leave the process.
     */
    HUDU_TYPESENSE_API_KEY: z.preprocess(blankToUndefined, z.string().min(1, 'HUDU_TYPESENSE_API_KEY must not be empty').optional()),
    /** The articles collection name. Defaults to Hudu's own name; a rename is config, not code. */
    HUDU_TYPESENSE_ARTICLES_COLLECTION: z.preprocess(blankToUndefined, z.string().min(1).optional()),
    /** The assets collection name. Defaults to Hudu's own name. */
    HUDU_TYPESENSE_ASSETS_COLLECTION: z.preprocess(blankToUndefined, z.string().min(1).optional()),
    /**
     * Whole-call deadline for one Typesense search, in milliseconds (default 4000).
     *
     * Bounded rather than free: a search has a vendor fallback, so waiting longer than a few seconds
     * is always the wrong trade. Above {@link TYPESENSE_DEFAULTS.maxTimeoutMs} the container fails
     * boot instead of accepting a value the tier was never designed for.
     */
    HUDU_TYPESENSE_TIMEOUT_MS: z.preprocess(
      blankToUndefined,
      z.coerce
        .number()
        .int()
        .positive()
        .max(TYPESENSE_DEFAULTS.maxTimeoutMs, `HUDU_TYPESENSE_TIMEOUT_MS must be at most ${TYPESENSE_DEFAULTS.maxTimeoutMs}; the tier has a vendor fallback and a search must not outlast the call`)
        .optional(),
    ),
    /**
     * Whether every Typesense hit is re-read through the Hudu API under the caller's own credential
     * before it is returned (default `true`).
     *
     * Hudu's index does not carry folder permissions and keeps discarded articles, so a raw hit is
     * an unverified claim about a record this credential may not be allowed to see. `false` is
     * faster and is documented as acceptable only for single-tenant, non-restricted deployments.
     */
    HUDU_TYPESENSE_VERIFY_HITS: z.preprocess(
      // Same treatment as every other new knob: a blank placeholder is unset, and the value is
      // matched case-insensitively so `TRUE` (a shell convention) is not a boot failure.
      (raw) => {
        const value = blankToUndefined(raw);
        return typeof value === 'string' ? value.trim().toLowerCase() : value;
      },
      z.enum(['true', 'false']).optional().transform((value) => (value === undefined ? undefined : value === 'true')),
    ),
    /**
     * The single switch for mutation. `deny` (the default) registers no `hudu_write` / `hudu_delete`
     * tool at all; `allow_list` and `all` register them and gate every call. Read effects are never
     * touched. See {@link WRITE_POLICIES}.
     */
    HUDU_WRITE_POLICY: z.enum(WRITE_POLICIES).default('deny'),
    /**
     * Hard override. `true` means no `hudu_write` / `hudu_delete` tool and no write or destructive
     * operation, whatever `HUDU_WRITE_POLICY` / `HUDU_WRITE_ALLOW` say (see {@link applyReadOnly}).
     * Unset or `false` leaves `HUDU_WRITE_POLICY` in charge (its default is `deny`).
     */
    HUDU_READ_ONLY: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
    /**
     * The operation keys `HUDU_WRITE_POLICY=allow_list` permits. Read only under `allow_list`;
     * ignored under `deny`/`all`. Exposed as the parsed array so no consumer re-splits the string.
     */
    HUDU_WRITE_ALLOW: z.string().optional().transform(parseAllowList),
    /**
     * Whether any operation on a credential-bearing resource may run at all — the secret-read
     * counterpart to `HUDU_WRITE_POLICY`, and independent of it.
     *
     * Scoped to the whole `asset_passwords` / `password_folders` surface rather than to the `expand`
     * flag alone: `asset_passwords.get` returns the secret without `expand`, so gating the flag
     * would leave the plainest path open. Defaults to `deny` — see {@link SECRET_READ_POLICIES}.
     * `hudu_search` is unaffected; it redacts those resources already. The curated context reads
     * always have asset custom-field values masked by the SDK, under every policy.
     */
    HUDU_SECRET_READS: z.enum(SECRET_READ_POLICIES).default('deny'),
    PORT: z.coerce.number().int().positive().max(65535).default(8787),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  .superRefine((c, ctx) => {
    // Pre-dial integrity check (2026-10-07 Autotask incident class): a credential whose bytes were
    // mangled by a quote-preserving load is refused HERE, before any client is constructed and so
    // before the first dial. Refusal is transport-independent: `HUDU_API_KEY` under `http` is the
    // default key for a request that brings none, and presenting a mangled one is the same
    // incident on a different path.
    checkCredentialShape(c.HUDU_API_KEY, ctx, 'HUDU_API_KEY');

    // `stdio` has exactly one origin and one credential (the environment's), so it requires both.
    // Under `http` both are optional defaults: a caller's `x-hudu-*` headers win, and the defaults
    // fill in whatever a request leaves out (see `resolveHuduClient` for how they pair).
    if (c.MCP_TRANSPORT === 'stdio' && c.HUDU_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['HUDU_API_KEY'],
        message: 'HUDU_API_KEY is required when MCP_TRANSPORT is "stdio"',
      });
    }
    if (c.MCP_TRANSPORT === 'stdio' && c.HUDU_BASE_URL === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['HUDU_BASE_URL'],
        message: 'HUDU_BASE_URL is required when MCP_TRANSPORT is "stdio"',
      });
    }

    // Fail closed: with no allow-list and no default origin, any caller picks the origin this server
    // calls (bring-your-own-origin mode). Booting that way has to be typed out, never reached by
    // forgetting a variable. A set `HUDU_BASE_URL` already restricts callers to that one origin.
    if (
      c.MCP_TRANSPORT === 'http' &&
      c.HUDU_ALLOWED_BASE_HOSTS === undefined &&
      c.HUDU_BASE_URL === undefined &&
      !c.HUDU_ALLOW_ANY_BASE_HOST
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['HUDU_ALLOWED_BASE_HOSTS'],
        message:
          'or HUDU_BASE_URL is required when MCP_TRANSPORT is "http": without either, any caller can make this server send requests to a host of their choosing. Set one (e.g. HUDU_BASE_URL=https://hudu.example.com), or set HUDU_ALLOW_ANY_BASE_HOST=true to accept any origin deliberately',
      });
    }

    // A host entry is a bare hostname or `*.` suffix. A scheme, port or path would never match the
    // parsed hostname, so it would silently refuse every caller; fail boot instead.
    for (const host of c.HUDU_ALLOWED_BASE_HOSTS ?? []) {
      if (!/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) {
        ctx.addIssue({
          code: 'custom',
          path: ['HUDU_ALLOWED_BASE_HOSTS'],
          message: `"${host}" is not a hostname; use e.g. hudu.example.com or *.example.com (no scheme, port or path)`,
        });
      } else if (!isPlausibleHost(host)) {
        // Passes the shape check but matches no real hostname: an empty label (consecutive dots),
        // an over-long label, or a label with a leading or trailing hyphen. A dead entry in an
        // active list is a config error, not a harmless one — name it and fail boot.
        ctx.addIssue({
          code: 'custom',
          path: ['HUDU_ALLOWED_BASE_HOSTS'],
          message: `"${host}" can match no hostname (labels are 1-63 characters, no leading or trailing hyphen, no consecutive dots); use e.g. hudu.example.com or *.example.com`,
        });
      }
    }

    // The search-resource list is independent of the write policy, so it is validated before the
    // early return below. A set list must be non-empty and every name must exist in the SDK's
    // searchable set — a typo fails boot with the variable and the name, not one empty search later.
    if (c.HUDU_SEARCH_RESOURCES !== undefined) {
      if (c.HUDU_SEARCH_RESOURCES.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['HUDU_SEARCH_RESOURCES'],
          message:
            'must name at least one searchable resource when set (an empty list would make hudu_search search nothing)',
        });
      } else {
        const searchable = new Set(SEARCH_RESOURCES.searchable.map((r) => r.resource));
        for (const resource of c.HUDU_SEARCH_RESOURCES) {
          if (!searchable.has(resource)) {
            ctx.addIssue({
              code: 'custom',
              path: ['HUDU_SEARCH_RESOURCES'],
              message: `"${resource}" is not a searchable resource; the SDK searchable set is ${[...searchable].join(', ')}`,
            });
          }
        }
      }
    }

    // The Typesense pair is all-or-nothing. A URL with no key searches nowhere; a key with no URL
    // has nowhere to go, and a key typed into the wrong deployment is a secret in the wrong place.
    // Name BOTH variables in one message so the operator fixes the pair, not one guess at a time.
    const typesenseUrl = c.HUDU_TYPESENSE_URL;
    const typesenseKey = c.HUDU_TYPESENSE_API_KEY;
    if ((typesenseUrl === undefined) !== (typesenseKey === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [typesenseUrl === undefined ? 'HUDU_TYPESENSE_URL' : 'HUDU_TYPESENSE_API_KEY'],
        message:
          'HUDU_TYPESENSE_URL and HUDU_TYPESENSE_API_KEY must be set together or not at all: ' +
          (typesenseUrl === undefined
            ? 'a key was set with no URL for it to reach (set HUDU_TYPESENSE_URL, or unset the key)'
            : 'a URL was set with no search key (set HUDU_TYPESENSE_API_KEY, or unset the URL to leave the Typesense tier off)'),
      });
    }
    // An origin, not a URL. A scheme other than http/https is not a Typesense endpoint, and any
    // path, query or fragment would be dropped or misapplied by a client that joins paths onto it —
    // a silent wrong endpoint rather than a refused boot.
    if (typesenseUrl !== undefined) {
      let parsed: URL | undefined;
      try {
        parsed = new URL(typesenseUrl);
      } catch {
        parsed = undefined;
      }
      if (parsed === undefined || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
        ctx.addIssue({
          code: 'custom',
          path: ['HUDU_TYPESENSE_URL'],
          message: 'HUDU_TYPESENSE_URL must be an http:// or https:// origin, e.g. https://typesense.example.com',
        });
      } else if (parsed.username !== '' || parsed.password !== '') {
        // Credentials in the URL would be sent to the vendor on every probe and would land in a log
        // the moment anything printed the endpoint. Refused, and the message never repeats the value
        // (it is a credential, and this is the one place it could leak by accident).
        ctx.addIssue({
          code: 'custom',
          path: ['HUDU_TYPESENSE_URL'],
          message: 'HUDU_TYPESENSE_URL must not carry credentials: put the key in HUDU_TYPESENSE_API_KEY, and never in the URL',
        });
      } else if ((parsed.pathname !== '' && parsed.pathname !== '/') || parsed.search !== '' || parsed.hash !== '') {
        ctx.addIssue({
          code: 'custom',
          path: ['HUDU_TYPESENSE_URL'],
          message: 'HUDU_TYPESENSE_URL must be an origin only: no path, query or fragment (e.g. https://typesense.example.com)',
        });
      }
    }
    // Two resources in one collection would make every hit ambiguous: an article id and an asset id
    // are both bare numbers, and the caller's `resources` scope could not be honoured.
    const articlesCollection = c.HUDU_TYPESENSE_ARTICLES_COLLECTION ?? TYPESENSE_DEFAULTS.articlesCollection;
    const assetsCollection = c.HUDU_TYPESENSE_ASSETS_COLLECTION ?? TYPESENSE_DEFAULTS.assetsCollection;
    if (articlesCollection === assetsCollection) {
      ctx.addIssue({
        code: 'custom',
        path: [c.HUDU_TYPESENSE_ASSETS_COLLECTION === undefined ? 'HUDU_TYPESENSE_ARTICLES_COLLECTION' : 'HUDU_TYPESENSE_ASSETS_COLLECTION'],
        message: `articles and assets must search different collections (both resolve to "${articlesCollection}"); set HUDU_TYPESENSE_ARTICLES_COLLECTION or HUDU_TYPESENSE_ASSETS_COLLECTION`,
      });
    }

    // A tier that cannot run must not be reachable by configuration: naming `typesense` without the
    // endpoint and key would otherwise degrade every search at the first call instead of failing
    // the container once, at boot.
    if (c.HUDU_SEARCH_TIER_POLICY === 'typesense' && typesenseUrl === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['HUDU_SEARCH_TIER_POLICY'],
        message:
          'HUDU_SEARCH_TIER_POLICY=typesense requires HUDU_TYPESENSE_URL and HUDU_TYPESENSE_API_KEY; set both, or choose auto|index|vendor',
      });
    }

    // `HUDU_WRITE_ALLOW` is only meaningful under `allow_list`, where a bad list must fail the
    // container rather than a call six months later. Every problem is reported at once, on the one
    // error path `loadConfig` already owns.
    if (c.HUDU_WRITE_POLICY !== 'allow_list') return;
    if (c.HUDU_WRITE_ALLOW.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['HUDU_WRITE_ALLOW'],
        message:
          'must list at least one operation key when HUDU_WRITE_POLICY=allow_list (an empty list is a config error, not a silently read-only server)',
      });
      return;
    }
    for (const key of c.HUDU_WRITE_ALLOW) {
      const record = getCapability(key);
      if (record === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['HUDU_WRITE_ALLOW'],
          message: `"${key}" is not a registry operation key; check the spelling against hudu_list_operations`,
        });
      } else if (!isWriteEffect(record)) {
        // An allow-list entry must name a write. Assert the positive rather than negating `read`:
        // `getCapability` is a prototype-backed lookup, so an inherited name (`constructor`,
        // `toString`) resolves to a function whose `effect` is `undefined`, not to `undefined`.
        // Testing `effect === 'read' || effect === null` let those keys fall through as writes.
        const detail =
          record.effect === 'read' || record.effect === null
            ? `"${key}" is a ${record.effect ?? 'non-write'} operation`
            : `"${key}" is not a write operation`;
        // It grants nothing either way, so silently accepting it would let the config's apparent
        // scope differ from its effect. A non-write key in a write allow-list is a misunderstanding
        // worth failing on.
        ctx.addIssue({
          code: 'custom',
          path: ['HUDU_WRITE_ALLOW'],
          message: `${detail}; HUDU_WRITE_ALLOW is a write allow-list and it would grant nothing`,
        });
      }
    }
  });

/**
 * Every `HUDU_TYPESENSE_*` knob the schema accepts, derived from the schema rather than retyped.
 *
 * The documentation-drift test reads THIS list: a knob added to the schema and forgotten in
 * `.env.example` / the README then fails the test, which a hand-written list in the test could not
 * catch — the test would have been asserting its own copy.
 */
export const TYPESENSE_ENV_NAMES: readonly string[] = Object.keys(schema.shape).filter((name) =>
  name.startsWith('HUDU_TYPESENSE_'),
);

/**
 * Apply the same check to `HUDU_API_KEY` here as to the per-request key under `http`.
 *
 * {@link CREDENTIAL_LOAD_HINT} — the env-load pitfall the refusal ends with — lives in
 * `src/credential.ts` beside the anomaly vocabulary, so the boot error and the http refusal explain
 * the same cause in the same words.
 *
 * Lives in a refinement rather than in the field's own `preprocess` so the issue carries the same
 * `path` (the variable name) the operator already reads, and so a value that is BOTH blank and
 * malformed reports only the blank case.
 *
 * The message never contains a character of the value: the anomaly names and the length are the
 * whole diagnostic. That matters — the value is the secret, and this text is printed to the boot
 * log (and, under `http`, would be too).
 */
function checkCredentialShape(value: string | undefined, ctx: z.RefinementCtx, path: string): void {
  if (value === undefined) return;
  const anomalies = detectCredentialShape(value);
  if (anomalies.length === 0) return;
  ctx.addIssue({
    code: 'custom',
    path: [path],
    message:
      `${path} has a value whose shape cannot be right (length ${value.length}, ${anomalies.join(', ')}); ` +
      `the server refuses to boot rather than present a malformed credential to Hudu. ${CREDENTIAL_LOAD_HINT}`,
  });
}

export type Config = z.infer<typeof schema>;

/**
 * Parse and validate configuration from an environment-shaped record.
 *
 * Takes the environment as an argument rather than reading `process.env` directly so the failure
 * paths are testable without mutating global state.
 *
 * @throws {ConfigError} when any variable is missing or malformed. The message lists every problem
 *   at once — a boot loop that surfaces one missing variable per restart wastes real minutes.
 */
/** Variables removed in 0.3.0. A stale one must fail boot rather than be ignored silently. */
const REMOVED_VARS = ['HUDU_CACHE_PRESET', 'HUDU_COOLDOWN', 'HUDU_TIMEOUT_MS', 'HUDU_SEARCH_MAX_INDEX_PAGES'] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const stale = REMOVED_VARS.filter((name) => env[name] !== undefined);
  if (stale.length > 0) {
    throw new ConfigError(`Invalid configuration:\n  ${stale.join(', ')}: removed in 0.3.0; delete it. HUDU_WRITE_POLICY (deny | allow_list | all) governs writes, with HUDU_READ_ONLY=true as a hard override.`);
  }
  const parsed = schema.safeParse(env);
  if (parsed.success) return parsed.data;

  const problems = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(config)'}: ${i.message}`);
  throw new ConfigError(`Invalid configuration:\n${problems.join('\n')}`);
}

/**
 * The configuration the server actually runs with: `HUDU_READ_ONLY=true` forces the policy to
 * `deny` (no write or delete tool is registered and every write is refused), whatever
 * `HUDU_WRITE_POLICY` / `HUDU_WRITE_ALLOW` say. Otherwise the config is returned unchanged.
 */
export function applyReadOnly(config: Config): Config {
  return config.HUDU_READ_ONLY ? { ...config, HUDU_WRITE_POLICY: 'deny', HUDU_WRITE_ALLOW: [] } : config;
}

/** Thrown only by {@link loadConfig}. Never carries a credential value — only variable names. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}
