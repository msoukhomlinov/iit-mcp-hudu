/**
 * tools/search-policy.ts — the deployment's search resource policy and the failure sanitizers.
 */
import { SEARCH_RESOURCES, configError } from 'node-hudu/mcp';
import { assertSecretReadPermitted, CREDENTIAL_RESOURCES, secretReadsPermitted } from '../policy.js';
import type { Config } from '../config.js';
import type { ToolContext } from './context.js';

/**
 * The backing operation `hudu_search` wraps.
 *
 * `hudu_read / hudu_write / hudu_delete` reaches this key directly, so it must honour the same resource scope and failure
 * sanitization as the tool — otherwise the narrowed schema is bypassable.
 */
export const SEARCH_KNOWLEDGE_OPERATION = 'operations.searchKnowledge';

/**
 * The backing operation `hudu_resolve_any` wraps.
 *
 * The other cross-resource read. `hudu_read / hudu_write / hudu_delete` reaches this key directly, so it must honour the
 * same resource scope and failure sanitization as the tool — otherwise the narrowed
 * `hudu_resolve_any` schema is bypassable the same way `hudu_search` was.
 */
export const RESOLVE_ANY_OPERATION = 'operations.resolveAny';

/** The SDK's searchable set, in the order it publishes it. Derived, never hand-copied. */
export const SDK_SEARCHABLE: string[] = SEARCH_RESOURCES.searchable.map((r) => r.resource);

/** The SDK's default search scope, stated in prose so the description matches the SDK. */
export const DEFAULT_SEARCH_SCOPE = ['articles', 'assets'];

/**
 * The resources this deployment may search: its declared list, or the SDK's full searchable set.
 *
 * Read by `registerTools` (the tool's resource enum and default scope) AND by the HTTP prewarm, so a
 * narrowed deployment never indexes or queries a resource its credential cannot read just because
 * that call forgot the policy.
 */
export function effectiveSearchResources(config: Config): string[] {
  return config.HUDU_SEARCH_RESOURCES ?? SDK_SEARCHABLE;
}

/**
 * The scope an omitted `resources` argument resolves to.
 *
 * The SDK's default is articles+assets; if the deployment narrowed that away, the default must not
 * quietly query an excluded resource. Intersect, and fall back to the whole declared set when the
 * intersection is empty.
 */
export function effectiveDefaultSearchScope(searchable: readonly string[]): string[] {
  const intersected = DEFAULT_SEARCH_SCOPE.filter((resource) => searchable.includes(resource));
  return intersected.length ? intersected : [...searchable];
}

/**
 * Failure codes that mean the deployment's credential cannot read the resource.
 *
 * Hudu answers `401` with a bare "Bad credentials" when an API key's user lacks a resource
 * permission, which is a statement about THIS deployment's credential — not something an MCP
 * caller needs or should see.
 */
export const AUTH_FAILURE_CODES = new Set(['UNAUTHORIZED', 'FORBIDDEN', 'AUTH_FAILED', 'BAD_CREDENTIALS']);

/**
 * Reduce a search's per-resource failures before they reach a model.
 *
 * A failure entry is useful — the caller learns one source returned nothing — but the upstream
 * `message` is not, and for an auth failure it names the credential's missing scope. Keep the
 * resource and a stable code; collapse auth failures to `UNAVAILABLE` with a fixed message so the
 * tool never reports which resource this deployment's key is not allowed to read.
 */
export function sanitizeSearchFailures(failures: unknown): Array<{ resource?: string; code: string; message: string }> {
  if (!Array.isArray(failures)) return [];
  return failures.map((entry) => {
    const failure = (entry ?? {}) as { resource?: unknown; code?: unknown };
    const resource = typeof failure.resource === 'string' ? failure.resource : undefined;
    const code = typeof failure.code === 'string' ? failure.code : undefined;
    const unavailable = code !== undefined && AUTH_FAILURE_CODES.has(code.toUpperCase());
    return {
      ...(resource === undefined ? {} : { resource }),
      code: unavailable ? 'UNAVAILABLE' : (code ?? 'FAILED'),
      message: unavailable
        ? 'Resource unavailable to this deployment; it returned no results.'
        : 'Resource read failed; it returned no results.',
    };
  });
}

/**
 * Whether the credential itself was refused for the whole call, rather than one resource failing.
 *
 * Hudu answers `401` "Bad credentials" for a bad key AND for a key that lacks one resource's
 * permission, and the engine isolates per-resource failures instead of throwing — so a bad key
 * otherwise reaches the caller as a fully "successful" 0-hit result whose `meta.failed` carries
 * auth-coded entries. Every other tool answers that refusal as a clean `UNAUTHORIZED`, and
 * `hudu_search` must too: when EVERY vendor resource the search asked for was refused
 * with an auth code, the credential is the problem, not an empty corpus.
 *
 * The two guard clauses keep the call honest in the corners:
 * - `hits` non-empty: the credential demonstrably answered through the body index, so a uniform
 *   upstream 401 is a vendor anomaly to REPORT (the sanitized failures), not a credential
 *   verdict to declare over real results;
 * - the `index` entry of `failed` is the background build's own failure, not a scope resource:
 *   it is excluded from the refusal set, so a scope that answered never reads as refused because
 *   its build 401'd.
 *
 * A scope where one resource was refused and another answered is a real (partial) answer: its
 * failures stay sanitized (`UNAVAILABLE` collapse) and the call keeps its results. `AUTH_ERROR`
 * (no credential was ever presented, the keyless fail-closed path) is not an upstream refusal and
 * is deliberately not matched.
 *
 * Two Hudu behaviours blur the verdict. A company-scoped key gets a filtered 200 on list endpoints,
 * never a 401, so it never trips this. And a key without `password_access` gets the same 401
 * "Bad credentials" on `asset_passwords` and `password_folders` as a bad key does: if those are the
 * only resources searched, that missing permission is reported as `UNAUTHORIZED`.
 */
export function credentialRefused(meta: { resources?: unknown; failed?: unknown; errors?: unknown } | null | undefined, hits: unknown): boolean {
  if (Array.isArray(hits) && hits.length > 0) return false;
  const scope = Array.isArray(meta?.resources)
    ? (meta.resources as readonly unknown[]).filter((resource): resource is string => typeof resource === 'string')
    : [];
  if (scope.length === 0) return false;
  const raw: readonly unknown[] = Array.isArray(meta?.failed) ? (meta.failed as readonly unknown[]) : Array.isArray(meta?.errors) ? (meta.errors as readonly unknown[]) : [];
  const refused = new Set<string>();
  for (const entry of raw) {
    const failure = (entry ?? {}) as { resource?: unknown; code?: unknown };
    const code = typeof failure.code === 'string' ? failure.code.toUpperCase() : '';
    const resource = typeof failure.resource === 'string' ? failure.resource : undefined;
    if (code !== '' && AUTH_FAILURE_CODES.has(code) && resource !== undefined && resource !== 'index') {
      refused.add(resource);
    }
  }
  return scope.every((resource) => refused.has(resource));
}

/**
 * Collapse a background index-build failure the same way per-resource failures are collapsed.
 *
 * The SDK records the raw build error in `meta.index.lastBuildError` (and in `meta.errors`); on a
 * 401 it names the credential's missing scope. Sanitizing `errors`/`failed` alone would leave the
 * nested copy untouched, so the whole `index` block is passed through the same reducer.
 */
export function sanitizeIndexMeta<T>(index: T): T {
  if (index === null || typeof index !== 'object') return index;
  const raw = (index as { lastBuildError?: unknown }).lastBuildError;
  if (raw === null || raw === undefined) return index;
  return { ...(index as Record<string, unknown>), lastBuildError: sanitizeSearchFailures([raw])[0] ?? null } as T;
}

/**
 * The search policy applied to a raw `hudu_read / hudu_write / hudu_delete` of `operations.searchKnowledge`.
 *
 * `hudu_read / hudu_write / hudu_delete` reaches the search helper directly, so without this it would bypass the narrowed
 * `hudu_search` schema: a caller could name an excluded resource and receive Hudu's own
 * `UNAUTHORIZED / Bad credentials` for it. Validate the requested scope and the index tier against
 * the deployment's effective set BEFORE any request, and return the bag with an omitted scope
 * resolved to the deployment default rather than the SDK's articles+assets.
 */
export function applySearchPolicyToInvoke(ctx: ToolContext, input: Record<string, unknown>): Record<string, unknown> {
  const { searchableResources, defaultSearchScope, indexSearchable } = ctx;
  const raw = input.opts;
  // Only `undefined` selects defaults. A non-object container (null, array, string, …) is left
  // untouched so the SDK's inputSchema refuses it before any request, rather than being replaced
  // with a valid object and searching resources the caller never named.
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) return input;
  const opts = (raw ?? {}) as Record<string, unknown>;
  // Only `undefined` selects the deployment default. Any other non-array value is left untouched
  // so the SDK's own inputSchema validation refuses it before any request — never silently
  // replaced with a valid scope, which would change which resources are searched.
  const scope = opts.scope === undefined ? defaultSearchScope : opts.scope;
  if (Array.isArray(scope)) {
    const excluded = scope.filter((r): r is string => typeof r === 'string' && !searchableResources.includes(r));
    if (excluded.length) {
      throw configError(
        `hudu_read / hudu_write / hudu_delete: operations.searchKnowledge scope ${JSON.stringify(excluded)} is excluded by HUDU_SEARCH_RESOURCES; this deployment may search: ${searchableResources.join(', ')}. Use hudu_search, which applies the same policy.`,
      );
    }
  }
  if (!indexSearchable) {
    if (opts.tier === 'index' || opts.tier === 'auto' || opts.refresh === true) {
      throw configError(
        'hudu_read / hudu_write / hudu_delete: the body index is unavailable because HUDU_SEARCH_RESOURCES excludes articles or assets; its walk is corpus-wide. Use tier:"vendor" without refresh, or restore the corpus resources.',
      );
    }
    // The SDK's default tier is "auto", which on a cold client starts a background corpus-wide
    // index warm and requests the excluded endpoint. An omitted tier becomes "vendor".
    const tier = opts.tier === undefined ? { tier: 'vendor' } : {};
    return { ...input, opts: { ...opts, scope, ...tier } };
  }
  return { ...input, opts: { ...opts, scope } };
}

/**
 * The search policy applied to a raw `hudu_read / hudu_write / hudu_delete` of `operations.resolveAny`.
 *
 * The sibling escape hatch to `applySearchPolicyToInvoke`: `hudu_read / hudu_write / hudu_delete` reaches the resolve
 * helper directly, so without this a caller could name an excluded resource and receive Hudu's
 * own `UNAUTHORIZED / Bad credentials` for it — the same leak the tool itself closes.
 * Validate the requested resource list against the deployment's effective set BEFORE any request,
 * and resolve an omitted list to the deployment's searchable set rather than the SDK's full eight.
 */
export function applyResolvePolicyToInvoke(ctx: ToolContext, input: Record<string, unknown>): Record<string, unknown> {
  const { searchableResources } = ctx;
  const raw = input.opts;
  // Only `undefined` selects defaults. A non-object container (null, array, string, …) is left
  // untouched so the SDK's inputSchema refuses it before any request, rather than being replaced
  // with a valid object and resolving against resources the caller never named.
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) return input;
  const opts = (raw ?? {}) as Record<string, unknown>;
  // Only `undefined` selects the deployment default. Any other non-array value is left untouched
  // so the SDK's own inputSchema validation refuses it before any request — never silently
  // replaced with a valid set, which would change which resources are resolved.
  const resources = opts.resources === undefined ? searchableResources : opts.resources;
  if (Array.isArray(resources)) {
    const excluded = resources.filter((r): r is string => typeof r === 'string' && !searchableResources.includes(r));
    if (excluded.length) {
      throw configError(
        `hudu_read / hudu_write / hudu_delete: operations.resolveAny resources ${JSON.stringify(excluded)} are excluded by HUDU_SEARCH_RESOURCES; this deployment may resolve: ${searchableResources.join(', ')}. Use hudu_resolve_any, which applies the same policy.`,
      );
    }
  }
  return { ...input, opts: { ...opts, resources } };
}

/**
 * The backing operation the `hudu_read` batch read dispatches: `operations.fetchMany`.
 *
 * The escape hatch that reaches per-resource single reads directly, by ITEM instead of by
 * operation key. Each item of the batch executes as the single read it names, so the batch must
 * honour the same deployment authorities the single read does — otherwise the policy is
 * bypassable by naming the resource in an item where the operation key would have been refused.
 */
export const FETCH_MANY_OPERATION = 'operations.fetchMany';

/**
 * The deployment authority applied to a raw `hudu_read / hudu_write / hudu_delete` of
 * `operations.fetchMany`.
 *
 * The secret-read policy is keyed by OPERATION: `operations.fetchMany` is not itself a secret
 * operation, so the dispatcher's generic assert passes it — and every item then executes as the
 * single read it names. Without this, `hudu_read` of
 * `operations.fetchMany` with an `asset_passwords` item returns a credential read under
 * `HUDU_SECRET_READS=deny`, exactly the deny this module exists to keep (the record's
 * `dependsOn` includes `asset_passwords.get` and `password_folders.get`).
 *
 * The check runs BEFORE any request, per item, and issues the same `POLICY_DENIED` refusal a
 * direct `asset_passwords.get` issues. The bag is never logged: an item names the very record
 * being read.
 *
 * Deliberately NOT search-scoped: a fetchMany item is a single-record READ, and `hudu_read` of the
 * same resource is not scoped to `HUDU_SEARCH_RESOURCES` — that policy governs SEARCH fan-outs,
 * and 15 of the batch's 22 resources are not searchable at all. Scoping the batch to the search
 * set would refuse reads the single-read path permits.
 *
 * Item-shape validation stays SDK-owned: a malformed `items` (missing, not an array, a non-object
 * item, a resource outside the 22-resource enum) is left untouched so the record's closed input
 * contract refuses it before any request.
 */
export function applyFetchManyPolicyToInvoke(ctx: ToolContext, input: Record<string, unknown>): Record<string, unknown> {
  const { items } = input;
  if (!Array.isArray(items)) return input;
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue; // SDK schema rejects malformed items.
    const resource = (item as { resource?: unknown }).resource;
    if (typeof resource !== 'string') continue;
    assertSecretReadPermitted(`${resource}.get`, ctx.config, ctx.log);
  }
  return input;
}

/** Cross-resource expansion must enforce both resource scope and credential-read authority. */
export const SEARCH_ACROSS_OPERATION = 'operations.searchAcrossResources';
/** Shared by invoke defaults and discovery so both expose the same permitted resource set. */
export function effectiveAcrossResources(ctx: ToolContext): string[] {
  return ctx.searchableResources.filter((resource) =>
    secretReadsPermitted(ctx.config) || !(CREDENTIAL_RESOURCES as readonly string[]).includes(resource));
}

export function applyAcrossPolicyToInvoke(ctx: ToolContext, input: Record<string, unknown>): Record<string, unknown> {
  const raw = input.opts;
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) return input;
  const opts = (raw ?? {}) as Record<string, unknown>;
  const defaults = effectiveAcrossResources(ctx);
  const resources = opts.resources === undefined ? defaults : opts.resources;
  if (Array.isArray(resources)) {
    for (const resource of resources) {
      if (typeof resource !== 'string') continue; // SDK schema rejects malformed entries.
      assertSecretReadPermitted(`${resource}.search`, ctx.config, ctx.log);
      if (!ctx.searchableResources.includes(resource)) {
        throw configError(`hudu_read / hudu_write / hudu_delete: ${SEARCH_ACROSS_OPERATION} resource ${resource} is excluded by HUDU_SEARCH_RESOURCES.`);
      }
    }
  }
  return { ...input, opts: { ...opts, resources } };
}
