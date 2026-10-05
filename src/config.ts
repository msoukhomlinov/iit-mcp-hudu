/**
 * config.ts — the process's entire configuration surface, validated once at boot.
 *
 * Every knob is an environment variable. The server refuses to start on an invalid config rather
 * than failing at the first tool call: a missing credential discovered by a model mid-conversation
 * is a far worse failure than a container that never came up.
 *
 */
import * as z from 'zod';
import { getCapability } from 'node-hudu/capabilities';
import { SEARCH_RESOURCES } from 'node-hudu/mcp';
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

/** Parse `HUDU_WRITE_ALLOW` once, here, so every consumer reads the same list. */
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
     * Pages the body index walks per resource per build (SDK default 250 = 25,000 records).
     *
     * Tenant-shaped, so it is a knob rather than a constant. The walk runs articles first and assets
     * second, and both compete for one 64 MB text budget that evicts least-recently-read text: on a
     * tenant with tens of thousands of assets the asset text arrives last, so the ARTICLE BODIES are
     * the first thing evicted — and article bodies are the only reason this index exists (assets
     * carry no body, and Hudu's own ?search= already covers their titles and fields). Sizing this so
     * the article walk completes with budget left over is what keeps searches from going body-blind.
     * A tenant with 3,000+ articles needs about 32 pages.
     */
    HUDU_SEARCH_MAX_INDEX_PAGES: z.coerce.number().int().min(1).max(1000).optional(),
    /**
     * The resources `hudu_search` may offer and query — the read-edge counterpart to
     * `HUDU_WRITE_POLICY`.
     *
     * The SDK publishes eight searchable resources, but a deployment's Hudu credential can read
     * fewer (a Hudu API key inherits its user's role). Unset means the SDK's full set; set it to the
     * resources THIS credential can read so the tool never advertises a guaranteed-empty search and
     * a model never spends a turn on a resource the key is not allowed to read. Every name is
     * validated against the SDK's searchable set at boot, so a typo fails the container instead of a
     * call weeks later. Applies to `hudu_search` only; the dedicated resolve tools are unaffected.
     */
    HUDU_SEARCH_RESOURCES: z.string().optional().transform(parseSearchResources),
    /**
     * Whether `hudu_read / hudu_write / hudu_delete` may reach a `write` or `destructive` operation at all. Read/`null`
     * effects are never touched by this policy. Defaults to `deny` — see {@link WRITE_POLICIES}.
     */
    HUDU_READ_ONLY: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
    HUDU_WRITE_POLICY: z.enum(WRITE_POLICIES).default('deny'),
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
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (parsed.success) return parsed.data;

  const problems = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(config)'}: ${i.message}`);
  throw new ConfigError(`Invalid configuration:\n${problems.join('\n')}`);
}

/** Thrown only by {@link loadConfig}. Never carries a credential value — only variable names. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}
