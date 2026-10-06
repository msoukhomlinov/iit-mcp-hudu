/** Governor, policy and confidentiality integration tests for src/tools/dispatch.ts. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITY_NAMES, getCapability } from 'node-hudu/capabilities';
import { connect } from '../helpers/mcp-session.js';
import { companyContextHudu, credentialFree, SAFE_ROW, PASSWORD_ROW, PLAINTEXT, OTP_SEED } from '../helpers/company-context-fixture.js';

afterEach(() => vi.unstubAllGlobals());

describe('dispatcher effect boundaries', () => {
  it('refuses wrong-effect operations through write and delete tools before any request', async () => {
    const session = await connect(undefined, { HUDU_WRITE_POLICY: 'all' });
    try {
      for (const [tool, operation, input] of [
        ['hudu_write', 'companies.delete', { id: 1 }],
        ['hudu_write', 'companies.get', { id: 1 }],
        ['hudu_delete', 'companies.update', { id: 1, data: { name: 'renamed' } }],
      ] as const) {
        const result = await session.call(tool, { operation, input, dry_run: false, confirm: operation });
        expect(result.isError, `${tool}: ${operation}`).toBe(true);
        expect(result.content[0].text).toContain('Invalid');
        expect(session.urls).toEqual([]);
      }
    } finally {
      await session.close();
    }
  });
});

describe('hudu_read governor', () => {
  it('refuses a destructive operation with no confirmation flag, before any request', async () => {
    const session = await connect();
    const result = await session.call('hudu_delete', { operation: 'companies.delete', input: { id: 1 }, dry_run: false });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('CONFIG_ERROR');
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('turns a mutating call with no dry_run into a dry run rather than a write', async () => {
    const session = await connect();
    const result = await session.call('hudu_write', { operation: 'companies.update', input: { id: 1, data: { name: 'renamed' } } });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.simulated).toBe(true);
    // The proof it was simulated is not the flag but the absence of a request.
    expect(session.urls).toEqual([]);
    await session.close();
  });
});

describe('hudu_read write policy', () => {
  const deny = { HUDU_WRITE_POLICY: 'deny' } as const;

  it('deny refuses a write before any request, with POLICY_DENIED', async () => {
    const session = await connect(undefined, deny);
    const result = await session.call('hudu_write', { operation: 'companies.update', input: { id: 1, data: { name: 'renamed' } }, dry_run: false });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('POLICY_DENIED');
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('deny refuses a destructive operation before any request, with POLICY_DENIED', async () => {
    const session = await connect(undefined, deny);
    // A correct `confirm` is irrelevant: the policy refuses strictly before the governor sees it.
    const result = await session.call('hudu_delete', { operation: 'companies.delete', input: { id: 1 }, dry_run: false, confirm: 'companies.delete' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('POLICY_DENIED');
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('deny still allows a read through hudu_read', async () => {
    const session = await connect(() => Response.json({ version: '2.45.1' }), deny);
    const result = await session.call('hudu_read', { operation: 'api_info.get' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.operation).toBe('api_info.get');
    // The proof the read actually ran is the request, not merely the absence of an error.
    expect(session.urls).toHaveLength(1);
    await session.close();
  });

  it('allow_list permits a listed key and refuses an unlisted one', async () => {
    const session = await connect(undefined, { HUDU_WRITE_POLICY: 'allow_list', HUDU_WRITE_ALLOW: ['articles.update'] });
    const permitted = await session.call('hudu_write', { operation: 'articles.update', input: { id: 1, data: { name: 'renamed' } } });
    expect(permitted.isError).toBeUndefined();
    expect(permitted.structuredContent.simulated).toBe(true);
    expect(session.urls).toEqual([]); // the dry run is the governor's, not a request

    const refused = await session.call('hudu_delete', { operation: 'companies.delete', input: { id: 1 }, dry_run: false });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0].text).code).toBe('POLICY_DENIED');
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('logs exactly one refusal line and issues no request, never logging the input bag', async () => {
    const session = await connect(undefined, deny);
    await session.call('hudu_write', { operation: 'assets.create', input: { companyId: 1, data: { password: 'hunter2' } }, dry_run: false });
    const refusals = session.logs.filter((l) => l.msg === 'hudu_read / hudu_write / hudu_delete refused by write policy');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ operation: 'assets.create', effect: 'write', policy: 'deny' });
    expect(session.urls).toEqual([]);
    // The refusal line must never carry the operation input bag: it can hold a credential.
    expect(JSON.stringify(session.logs)).not.toContain('hunter2');
    await session.close();
  });

  it('refuses a credential read through hudu_read even when the write policy is all', async () => {
    const session = await connect(undefined, { HUDU_WRITE_POLICY: 'all' });
    const refused = await session.call('hudu_read', { operation: 'asset_passwords.get', input: { id: 1 } });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0].text).code).toBe('POLICY_DENIED');
    expect(session.urls).toEqual([]);
    const refusals = session.logs.filter((l) => l.msg === 'credential read refused by secret-read policy');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ operation: 'asset_passwords.get', policy: 'deny' });
    await session.close();
  });

});

describe('hudu_read fetchMany policy', () => {
  it('refuses a credential-resource item before any request, with POLICY_DENIED', async () => {
    // The bypass the 0.12.0 upgrade would otherwise open: operations.fetchMany is not itself a
    // secret operation, so only the item-level check closes the gap.
    const session = await connect(undefined, { HUDU_WRITE_POLICY: 'all' });
    const refused = await session.call('hudu_read', {
      operation: 'operations.fetchMany',
      input: { items: [{ resource: 'asset_passwords', id: 1 }] },
    });
    expect(refused.isError).toBe(true);
    const body = JSON.parse(refused.content[0].text);
    expect(body.code).toBe('POLICY_DENIED');
    expect(body.message).toContain('asset_passwords.get');
    expect(session.urls).toEqual([]);
    const refusals = session.logs.filter((l) => l.msg === 'credential read refused by secret-read policy');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ operation: 'asset_passwords.get', policy: 'deny' });
    // The refusal line must never carry the input bag: an item names the record being read.
    await session.close();
  });

  it('refuses a credential item anywhere in a mixed batch, still before any request', async () => {
    const session = await connect(undefined, { HUDU_WRITE_POLICY: 'all' });
    const refused = await session.call('hudu_read', {
      operation: 'operations.fetchMany',
      input: { items: [{ resource: 'articles', id: 1 }, { resource: 'password_folders', id: 2 }] },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0].text).code).toBe('POLICY_DENIED');
    // Not merely "the first item was fine": the whole batch is refused and nothing is dialed.
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('answers a credential batch under HUDU_SECRET_READS=allow, issuing both reads', async () => {
    const session = await connect(() => Response.json({ id: 1, name: 'record' }), { HUDU_SECRET_READS: 'allow' });
    const result = await session.call('hudu_read', {
      operation: 'operations.fetchMany',
      input: { items: [{ resource: 'asset_passwords', id: 1 }, { resource: 'password_folders', id: 2 }] },
    });
    expect(result.isError).toBeUndefined();
    expect(session.urls).toHaveLength(2);
    await session.close();
  });

  it('does not search-scope the batch: a single-record read the single-read path permits is permitted', async () => {
    // companies is not in the narrowed search set, but hudu_read companies.get is not search-scoped —
    // the batch must not be more restrictive than the single read it collapses.
    const session = await connect(() => Response.json({ id: 1, name: 'record' }), { HUDU_SEARCH_RESOURCES: ['articles'] });
    const result = await session.call('hudu_read', {
      operation: 'operations.fetchMany',
      input: { items: [{ resource: 'companies', id: 1 }] },
    });
    expect(result.isError).toBeUndefined();
    expect(session.urls).toHaveLength(1);
    await session.close();
  });

  it('leaves a malformed items container to the SDK closed contract, before any request', async () => {
    const session = await connect(undefined, { HUDU_WRITE_POLICY: 'all' });
    const refused = await session.call('hudu_read', {
      operation: 'operations.fetchMany',
      input: { items: 'not-an-array' },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0].text).code).toBe('CONFIG_ERROR');
    expect(session.urls).toEqual([]);
    await session.close();
  });

});

describe('hudu_read search policy', () => {
  it('refuses a scope the deployment excluded, before any request', async () => {
    // The narrowed hudu_search schema must not be bypassable through the raw operation.
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['articles', 'assets'] });
    const result = await session.call('hudu_read', {
      operation: 'operations.searchKnowledge',
      input: { query: 'reset', opts: { scope: ['asset_passwords'], tier: 'vendor' } },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('CONFIG_ERROR');
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('answers a fully-refused search scope with the clean UNAUTHORIZED 401, like the tool', async () => {
    // Reached through the escape hatch: a key Hudu refuses on every scope resource is
    // a credential failure, not a 0-match answer — the narrowed hudu_search behaviour must not be
    // bypassable into the old false success.
    const session = await connect((url) =>
      url.includes('/asset_passwords')
        ? new Response(JSON.stringify({ error: 'Bad credentials' }), { status: 401, headers: { 'content-type': 'application/json' } })
        : Response.json([]),
    );
    const result = await session.call('hudu_read', {
      operation: 'operations.searchKnowledge',
      input: { query: 'reset', opts: { scope: ['asset_passwords'], tier: 'vendor', limit: 1, snippetChars: 0 } },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ error: true, code: 'UNAUTHORIZED', status: 401, message: 'Bad credentials' });
    await session.close();
  });

  it('keeps a partial search answer sanitized when another scope resource answered', async () => {
    // The corner that stays on the invoke path too: the credential works for the rest of
    // the scope, so the call is a real answer and the refused resource is collapsed, not echoed.
    const session = await connect((url) =>
      url.includes('/asset_passwords')
        ? new Response(JSON.stringify({ error: 'Bad credentials' }), { status: 401, headers: { 'content-type': 'application/json' } })
        : Response.json([]),
    );
    const result = await session.call('hudu_read', {
      operation: 'operations.searchKnowledge',
      input: { query: 'reset', opts: { scope: ['articles', 'asset_passwords'], tier: 'vendor', limit: 1, snippetChars: 0 } },
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('Bad credentials');
    expect(JSON.stringify(result)).not.toContain('UNAUTHORIZED');
    expect(result.structuredContent.result.meta.failed).toEqual([
      { resource: 'asset_passwords', code: 'UNAVAILABLE', message: 'Resource unavailable to this deployment; it returned no results.' },
    ]);
    await session.close();
  });

  it('refuses the corpus-wide index tier through invoke when the corpus is excluded', async () => {
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['articles'] });
    const result = await session.call('hudu_read', {
      operation: 'operations.searchKnowledge',
      input: { query: 'reset', opts: { scope: ['articles'], tier: 'index' } },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('CONFIG_ERROR');
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('resolves an omitted scope to the deployment default, never the SDK default', async () => {
    const session = await connect(() => Response.json([]), { HUDU_SEARCH_RESOURCES: ['articles'] });
    const result = await session.call('hudu_read', {
      operation: 'operations.searchKnowledge',
      input: { query: 'reset', opts: { tier: 'vendor' } },
    });
    expect(result.isError).toBeUndefined();
    expect(session.urls.some((u) => u.includes('/articles'))).toBe(true);
    expect(session.urls.some((u) => u.includes('/assets'))).toBe(false);
    await session.close();
  });

  it('forces the vendor tier when an invoke caller omits it and the corpus is excluded', async () => {
    // The SDK's "auto" default warms the corpus-wide index on a cold client, which would request
    // the excluded endpoint. An omitted tier must not reach the SDK as "auto".
    const session = await connect(() => Response.json([]), { HUDU_SEARCH_RESOURCES: ['articles'] });
    const result = await session.call('hudu_read', {
      operation: 'operations.searchKnowledge',
      input: { query: 'reset', opts: {} },
    });
    expect(result.isError).toBeUndefined();
    expect(session.urls.some((u) => u.includes('/articles'))).toBe(true);
    expect(session.urls.some((u) => u.includes('/assets'))).toBe(false);
    await session.close();
  });

  it('leaves a non-array scope invalid so the SDK refuses it before any request', async () => {
    // Treating a malformed scope as "omitted" would silently substitute a valid one and search a
    // different resource set than the caller asked for.
    const session = await connect(() => Response.json([]), { HUDU_SEARCH_RESOURCES: ['articles', 'assets'] });
    const result = await session.call('hudu_read', {
      operation: 'operations.searchKnowledge',
      input: { query: 'reset', opts: { scope: 'asset_passwords', tier: 'vendor' } },
    });
    expect(result.isError).toBe(true);
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('leaves a non-object opts container invalid so the SDK refuses it before any request', async () => {
    const session = await connect(() => Response.json([]), { HUDU_SEARCH_RESOURCES: ['articles', 'assets'] });
    const result = await session.call('hudu_read', {
      operation: 'operations.searchKnowledge',
      input: { query: 'reset', opts: null },
    });
    expect(result.isError).toBe(true);
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('refuses a nested operations.invoke that would bypass the search policy', async () => {
    // operations.invoke is an unclassified dispatcher, excluded from every effect-specific tool.
    // Refuse nesting even under write policy "all" so it cannot bypass the search policy.
    const session = await connect(undefined, { HUDU_WRITE_POLICY: 'all' });
    const result = await session.call('hudu_read', {
      operation: 'operations.invoke',
      dry_run: false,
      input: { operation: 'operations.searchKnowledge', input: { query: 'reset', opts: { scope: ['asset_passwords'] } }, opts: { dryRun: false } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid');
    expect(session.urls).toEqual([]);
    await session.close();
  });
});

describe('hudu_read resolve policy', () => {
  it('refuses a resource the deployment excluded, before any request', async () => {
    // The narrowed hudu_resolve_any schema must not be bypassable through the raw operation.
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['companies'] });
    const result = await session.call('hudu_read', {
      operation: 'operations.resolveAny',
      input: { identifier: { id: 1 }, opts: { resources: ['asset_passwords'] } },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('CONFIG_ERROR');
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('resolves an omitted resource list to the deployment set, never the SDK full eight', async () => {
    const session = await connect(() => Response.json({ id: 1, name: 'Acme' }), { HUDU_SEARCH_RESOURCES: ['companies'] });
    const result = await session.call('hudu_read', {
      operation: 'operations.resolveAny',
      input: { identifier: { id: 1 } },
    });
    expect(result.isError).toBeUndefined();
    expect(session.urls.some((u) => u.includes('/companies'))).toBe(true);
    expect(session.urls.some((u) => u.includes('asset_passwords'))).toBe(false);
    await session.close();
  });

  it('answers a resolve credential refusal with the clean UNAUTHORIZED 401, like the search and read tools', async () => {
    // a 401-shaped refusal on the resolve path is
    // reported UNAUTHORIZED, the same envelope every other tool answers. Accepted wrinkle: Hudu
    // 401s a key without password_access on asset_passwords exactly like a bad key, so that
    // missing permission reads UNAUTHORIZED too — pinned here on purpose.
    const session = await connect(
      () => new Response(JSON.stringify({ error: 'Bad credentials' }), { status: 401, headers: { 'content-type': 'application/json' } }),
      { HUDU_SEARCH_RESOURCES: ['companies', 'asset_passwords'] },
    );
    const result = await session.call('hudu_read', {
      operation: 'operations.resolveAny',
      input: { identifier: { id: 1 }, opts: { resources: ['asset_passwords'] } },
    });
    expect(result.isError).toBe(true);
    // The envelope is fixed, not echoed: the vendor 401 body never crosses the boundary.
    expect(JSON.parse(result.content[0].text)).toEqual({ error: true, code: 'UNAUTHORIZED', status: 401, message: 'Bad credentials' });
    await session.close();
  });

  it('leaves a non-array resource list invalid so the SDK refuses it before any request', async () => {
    const session = await connect(() => Response.json({ id: 1, name: 'Acme' }), { HUDU_SEARCH_RESOURCES: ['companies'] });
    const result = await session.call('hudu_read', {
      operation: 'operations.resolveAny',
      input: { identifier: { id: 1 }, opts: { resources: 'asset_passwords' } },
    });
    expect(result.isError).toBe(true);
    expect(session.urls).toEqual([]);
    await session.close();
  });
});

describe('hudu_read companies.getContext secret-read policy', () => {
  // Same leak as the curated tool, reached by registry key instead of tool name.
  for (const expand of [true, false]) {
    it(`strips credential fields under deny (expand: ${expand})`, async () => {
      const session = await connect(companyContextHudu, { HUDU_SECRET_READS: 'deny' });
      const result = await session.call('hudu_read', { operation: 'companies.getContext', input: { id: 1, opts: { limit: 25, expand } } });
      expect(result.isError, JSON.stringify(result)).toBeUndefined();
      expect(session.urls.some((u) => u.includes('/asset_passwords'))).toBe(true);
      expect(credentialFree(result)).toBe(true);
      expect(result.structuredContent.result.assetPasswords).toEqual([SAFE_ROW]);
      await session.close();
    });
  }
});

describe('hudu_read context failures', () => {
  it.each([
    { operation: 'companies.getContext', input: { id: 22, opts: { expand: true } } },
    { operation: 'assets.getContext', input: { identifier: 22, opts: { expand: true } } },
    { operation: 'articles.getContext', input: { id: 22, opts: { expand: true } } },
  ])('answers $operation credential refusals with the clean UNAUTHORIZED 401, like the curated tool', async ({ operation, input }) => {
    // a 401-shaped refusal on a *.getContext path
    // is reported UNAUTHORIZED, the same envelope every other tool answers.
    const session = await connect(() => Response.json({ error: 'Bad credentials' }, { status: 401 }));
    try {
      const result = await session.call('hudu_read', { operation, input });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({ error: true, code: 'UNAUTHORIZED', status: 401, message: 'Bad credentials' });
    } finally {
      await session.close();
    }
  });
});

const secret = 'synthetic-confidential-invoke-probe';
const asset = { id: 5, company_id: 1, asset_layout_id: 7, name: 'server', fields: [
  { label: 'Password', value: secret }, { label: 'Private', value: secret }, { label: 'Hostname', value: 'safe.example' },
] };
function hudu(url: string): Response {
  const path = new URL(url).pathname;
  if (path.endsWith('/asset_layouts/7')) return Response.json({ asset_layout: { id: 7, fields: [
    { label: 'Password', field_type: 'Password' }, { label: 'Private', field_type: 'ConfidentialText' },
    { label: 'Hostname', field_type: 'Text' },
  ] } });
  if (path.endsWith('/assets/5')) return Response.json({ asset });
  if (path.endsWith('/assets')) return Response.json({ assets: [asset] });
  if (path.endsWith('/expirations') || path.endsWith('/relations')) return Response.json([]);
  return companyContextHudu(url);
}

describe('invoke confidentiality boundary', () => {
  it('refuses expanded credential cross-search before a request under secret deny', async () => {
    const session = await connect(() => Response.json({ asset_passwords: [PASSWORD_ROW] }));
    try {
      const result = await session.call('hudu_read', { operation: 'operations.searchAcrossResources',
        input: { query: 'admin', opts: { resources: ['asset_passwords'], expand: true } } });
      expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
      expect(JSON.stringify(result)).not.toContain(OTP_SEED);
      expect(result.isError).toBe(true);
      expect(session.urls).toEqual([]);
    } finally { await session.close(); }
  });

  it('enforces the search resource restriction even when secrets are allowed', async () => {
    const session = await connect(() => Response.json({ asset_passwords: [PASSWORD_ROW] }),
      { HUDU_SECRET_READS: 'allow', HUDU_SEARCH_RESOURCES: ['assets'] });
    try {
      const result = await session.call('hudu_read', { operation: 'operations.searchAcrossResources',
        input: { query: 'admin', opts: { resources: ['asset_passwords'], expand: true } } });
      expect(result.isError).toBe(true);
      expect(session.urls).toEqual([]);
    } finally { await session.close(); }
  });

  it.each([
    ['assets.get', { companyId: 1, id: 5 }],
    ['assets.search', { query: 'server', opts: { expand: true } }],
    ['assets.getContext', { identifier: { id: 5, companyId: 1 }, opts: { expand: true } }],
    ['companies.getContext', { id: 1, opts: { expand: true } }],
    ['operations.searchAcrossResources', { query: 'server', opts: { resources: ['assets'], expand: true } }],
  ])('redacts confidential fields through %s', async (operation, input) => {
    const session = await connect(hudu);
    try {
      const result = await session.call('hudu_read', { operation, input });
      expect(result.isError, JSON.stringify(result)).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).toContain('server');
      expect(JSON.stringify(session.logs)).not.toContain(secret);
    } finally { await session.close(); }
  });
});

it('refuses every non-read capability under deny without any request', async () => {
  const session = await connect(undefined, { HUDU_WRITE_POLICY: 'deny' });
  try {
    for (const operation of CAPABILITY_NAMES) {
      if (getCapability(operation)?.effect === 'read') continue;
      const result = await session.call('hudu_read', { operation });
      expect(result.isError, operation).toBe(true);
      expect(session.urls, operation).toEqual([]);
    }
  } finally { await session.close(); }
});

it('keeps the SDK streaming list refusal before any request', async () => {
  const session = await connect();
  try {
    const result = await session.call('hudu_read', { operation: 'assets.list', input: { companyId: 1 } });
    expect(result.isError).toBe(true);
    expect(session.urls).toEqual([]);
  } finally { await session.close(); }
});

it('defaults cross-search to permitted resources without credential endpoints', async () => {
  const session = await connect(hudu, { HUDU_SEARCH_RESOURCES: ['assets', 'asset_passwords'] });
  try {
    const result = await session.call('hudu_read', { operation: 'operations.searchAcrossResources',
      input: { query: 'server', opts: { expand: true } } });
    expect(result.isError).toBeUndefined();
    expect(session.urls.some((url) => url.includes('/asset_passwords'))).toBe(false);
    expect(session.urls.some((url) => url.includes('/assets'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
  } finally { await session.close(); }
});

it.each([null, [], 'assets', { resources: null }, { resources: 'assets' }, { resources: [null] }])(
  'rejects malformed cross-search options without requests: %j', async (opts) => {
    const session = await connect();
    try {
      const result = await session.call('hudu_read', { operation: 'operations.searchAcrossResources', input: { query: 'server', opts } });
      expect(result.isError).toBe(true);
      expect(session.urls).toEqual([]);
    } finally { await session.close(); }
  });

it('answers an isolated cross-search refused on every resource with UNAUTHORIZED', async () => {
  const session = await connect(() => Response.json({ error: 'Bad credentials' }, { status: 401 }));
  try {
    const result = await session.call('hudu_read', { operation: 'operations.searchAcrossResources',
      input: { query: 'server', opts: { resources: ['assets'], isolateErrors: true } } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ error: true, code: 'UNAUTHORIZED', status: 401, message: 'Bad credentials' });
  } finally { await session.close(); }
});

it('sanitizes isolated cross-search auth failures when another resource answered', async () => {
  const session = await connect((url) =>
    url.includes('/assets') ? Response.json({ error: 'Bad credentials' }, { status: 401 }) : Response.json([]));
  try {
    const result = await session.call('hudu_read', { operation: 'operations.searchAcrossResources',
      input: { query: 'server', opts: { resources: ['assets', 'articles'], isolateErrors: true } } });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.result.errors[0].code).toBe('UNAVAILABLE');
    expect(JSON.stringify(result)).not.toContain('Bad credentials');
  } finally { await session.close(); }
});

it('never dispatches a destructive operation through hudu_write even with confirmation', async () => {
  const session = await connect();
  try {
    for (const operation of CAPABILITY_NAMES.filter((key) => getCapability(key)?.effect === 'destructive')) {
      expect((await session.call('hudu_write', { operation, input: { id: 1 }, dry_run: false, confirm: operation })).isError, operation).toBe(true);
    }
    expect(session.urls).toEqual([]);
  } finally { await session.close(); }
});

it('executes only allow-listed writes and preserves dry-run and confirmation guards', async () => {
  const session = await connect(() => Response.json({ company: { id: 1, name: 'renamed' } }),
    { HUDU_WRITE_POLICY: 'allow_list', HUDU_WRITE_ALLOW: ['companies.update', 'companies.delete'] });
  try {
    const write = await session.call('hudu_write', { operation: 'companies.update', input: { id: 1, data: { name: 'renamed' } }, dry_run: false });
    expect(write.isError, JSON.stringify(write)).toBeUndefined();
    expect(session.urls).toHaveLength(1);
    const remove = await session.call('hudu_delete', { operation: 'companies.delete', input: { id: 1 }, dry_run: false, confirm: 'companies.delete' });
    expect(remove.isError, JSON.stringify(remove)).toBeUndefined();
    expect(session.urls).toHaveLength(2);
    const denied = await session.call('hudu_write', { operation: 'articles.update', input: { id: 1, data: { name: 'no' } }, dry_run: false });
    expect(denied.isError).toBe(true);
    expect(session.urls).toHaveLength(2);
  } finally { await session.close(); }
});

it('the SDK read client rejects every mutation even when the MCP enum is bypassed', async () => {
  const { HuduClient } = await import('node-hudu');
  const { dispatchOperation, META_TOOLS } = await import('node-hudu/mcp');
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const client = new HuduClient({ baseUrl: 'https://hudu.invalid', apiKey: 'synthetic', mode: 'read' });
  for (const effect of ['write', 'destructive'] as const) {
    const spec = META_TOOLS.find((tool) => tool.name === (effect === 'write' ? 'hudu_write' : 'hudu_delete'))!;
    for (const operation of spec.inputSchema.fields.operation!.enum!) {
      await expect(dispatchOperation(client, effect, operation, {}, { dryRun: false, confirm: operation }), operation)
        .rejects.toMatchObject({ code: 'POLICY_DENIED' });
    }
  }
  expect(fetch).not.toHaveBeenCalled();
});
