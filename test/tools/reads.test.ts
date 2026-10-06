/**
 * reads.test.ts — the read tools' resource policy: `hudu_resolve_any` honours the deployment's
 * searchable set and sanitizes a resolve auth failure — and `hudu_get_company_context` honours
 * `HUDU_SECRET_READS=deny`. Pairs with `src/tools/reads.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from '../helpers/mcp-session.js';
import { companyContextHudu, credentialFree, PLAINTEXT, SAFE_ROW } from '../helpers/company-context-fixture.js';

afterEach(() => vi.unstubAllGlobals());

describe('hudu_resolve_any resource policy', () => {
  it('advertises exactly the resources the deployment declared, not the whole SDK set', async () => {
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['companies', 'users'] });
    const tool = (await session.list()).find((t) => t.name === 'hudu_resolve_any');
    expect(tool!.inputSchema.properties.opts.properties.resources.items.enum).toEqual(['companies', 'users']);
    await session.close();
  });

  it('refuses a resource the deployment excluded, before any request', async () => {
    // The credential cannot read asset_passwords, so the deployment removed it. A model asking for
    // it must be refused without a Hudu request — the alternative is the leaked auth error.
    const session = await connect(undefined, { HUDU_SEARCH_RESOURCES: ['companies'] });
    const result = await session.call('hudu_resolve_any', { identifier: { id: 1 }, opts: { resources: ['asset_passwords'] } });
    expect(result.isError).toBe(true);
    expect(session.urls).toEqual([]);
    await session.close();
  });

  it('does not query an excluded resource when the caller omits resources', async () => {
    // The SDK default fan-out is all eight. A deployment narrowed to companies must not have the
    // omitted-argument path quietly reach a resource this credential cannot read.
    const session = await connect(() => Response.json({ id: 1, name: 'Acme' }), { HUDU_SEARCH_RESOURCES: ['companies'] });
    const result = await session.call('hudu_resolve_any', { identifier: { id: 1 } });
    expect(result.isError).toBeUndefined();
    expect(session.urls.some((u) => u.includes('/companies'))).toBe(true);
    for (const excluded of ['asset_passwords', 'password_folders', 'articles', 'assets', 'users', 'groups', 'websites']) {
      expect(session.urls.some((u) => u.includes(excluded)), excluded).toBe(false);
    }
    await session.close();
  });

  it('answers a resolve credential refusal with the clean UNAUTHORIZED 401, like the search and read tools', async () => {
    // The live defect: Hudu answers the excluded/unauthorized resource with 401 "Bad credentials".
    // resolveAny does not isolate per-resource failures — the auth error is THROWN, so the fixed
    // envelope (code, httpStatus, stable message) is the only text that may cross the boundary.
    // that refusal is UNAUTHORIZED, not UNAVAILABLE.
    const session = await connect(
      () => new Response(JSON.stringify({ error: 'Bad credentials' }), { status: 401, headers: { 'content-type': 'application/json' } }),
      { HUDU_SEARCH_RESOURCES: ['companies', 'asset_passwords'] },
    );
    const result = await session.call('hudu_resolve_any', { identifier: { id: 1 }, opts: { resources: ['asset_passwords'] } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: true, code: 'UNAUTHORIZED', httpStatus: 401, message: 'Bad credentials' });
    await session.close();
  });
});

describe('hudu_get_company_context secret-read policy', () => {
  // The SDK lists the company's asset_passwords on every context read and returns them raw under
  // expand; companies.getContext is not a credential operation, so the read assertion never fires.
  for (const expand of [true, false]) {
    it(`strips credential fields under deny (expand: ${expand})`, async () => {
      const session = await connect(companyContextHudu, { HUDU_SECRET_READS: 'deny' });
      const result = await session.call('hudu_get_company_context', { id: 1, opts: { limit: 25, expand } });
      expect(result.isError, JSON.stringify(result)).toBeUndefined();
      // The leg is reached: Hudu handed the server a secret, and the server kept it.
      expect(session.urls.some((u) => u.includes('/asset_passwords'))).toBe(true);
      expect(credentialFree(result)).toBe(true);
      expect(result.structuredContent.context.assetPasswords).toEqual([SAFE_ROW]);
      await session.close();
    });
  }

  it('never logs credential contents', async () => {
    const session = await connect(companyContextHudu, { HUDU_SECRET_READS: 'deny' });
    await session.call('hudu_get_company_context', { id: 1, opts: { expand: true } });
    expect(JSON.stringify(session.logs)).not.toContain(PLAINTEXT);
    await session.close();
  });

  it('applies both deny redactions to one expanded context', async () => {
    // Password rows and an asset's Password custom field reach the same expand result through
    // different legs; each redaction must survive the other being applied to that result.
    const FIELD_SECRET = 'asset-field-secret-never-returned';
    const session = await connect(
      (url) => {
        const path = new URL(url).pathname;
        if (path.endsWith('/asset_layouts/9')) {
          return Response.json({ asset_layout: { id: 9, name: 'Server', fields: [{ id: 90, label: 'Admin PW', field_type: 'Password' }] } });
        }
        if (path.endsWith('/assets')) {
          return Response.json({ assets: [{ id: 3, company_id: 1, asset_layout_id: 9, name: 'srv', fields: [{ id: 300, label: 'Admin PW', value: FIELD_SECRET, position: 1 }] }] });
        }
        return companyContextHudu(url);
      },
      { HUDU_SECRET_READS: 'deny' },
    );
    const result = await session.call('hudu_get_company_context', { id: 1, opts: { limit: 25, expand: true } });
    expect(result.isError, JSON.stringify(result)).toBeUndefined();
    expect(credentialFree(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(FIELD_SECRET);
    expect(result.structuredContent.context.assetPasswords).toEqual([SAFE_ROW]);
    expect(result.structuredContent.context.assets[0].fields[0].label).toBe('Admin PW');
    await session.close();
  });

  it('keeps SDK masking when the deployment permits credential resources', async () => {
    // Resource access is permitted; plaintext reveal remains disabled.
    const session = await connect(companyContextHudu, { HUDU_SECRET_READS: 'allow' });
    const result = await session.call('hudu_get_company_context', { id: 1, opts: { expand: true } });
    expect(result.structuredContent.context.assetPasswords[0].password).toBe('[REDACTED]');
    await session.close();
  });
});

describe('context read failures', () => {
  const cases = [
    { tool: 'hudu_get_company_context', args: { id: 22 } },
    { tool: 'hudu_get_asset_context', args: { identifier: 22 } },
    { tool: 'hudu_get_article_context', args: { id: 22 } },
  ];

  it.each(cases)('$tool answers an upstream credential refusal with UNAUTHORIZED 401', async ({ tool, args }) => {
    const session = await connect(() => Response.json({ error: 'Bad credentials' }, { status: 401 }));
    try {
      const result = await session.call(tool, { ...args, opts: { expand: true } });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({ error: true, code: 'UNAUTHORIZED', httpStatus: 401, message: 'Bad credentials' });
    } finally {
      await session.close();
    }
  });

  it.each(cases)('$tool still returns successful context', async ({ tool, args }) => {
    const session = await connect((url) =>
      new URL(url).pathname.endsWith('/22')
        ? Response.json({ id: 22, name: 'Example', company_id: 22 })
        : Response.json(new URL(url).pathname.endsWith('/assets') ? [{ id: 22, name: 'Example', company_id: 22 }] : []),
    );
    try {
      const result = await session.call(tool, { ...args, opts: { expand: true } });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent.context).toBeDefined();
      const spec = (await session.list()).find((entry) => entry.name === tool);
      expect(spec!.description).toContain('refused credential answers UNAUTHORIZED');
    } finally {
      await session.close();
    }
  });

  it.each(cases)('$tool preserves non-auth diagnostics', async ({ tool, args }) => {
    const session = await connect(() => Response.json({ error: 'Invalid request' }, { status: 422 }));
    try {
      const result = await session.call(tool, args);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ httpStatus: 422 });
      expect(JSON.parse(result.content[0].text).code).not.toBe('UNAVAILABLE');
    } finally {
      await session.close();
    }
  });

  it.each([false, true])('company context reports a password-resource 401 as UNAUTHORIZED with expand=%s', async (expand) => {
    // the accepted scope-401 wrinkle: Hudu 401s a
    // key without password_access on asset_passwords exactly like a bad key, so this scope-only
    // refusal is indistinguishable and is reported UNAUTHORIZED, not UNAVAILABLE.
    const session = await connect((url) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/asset_passwords')) return Response.json({ error: 'Bad credentials' }, { status: 401 });
      if (path.endsWith('/companies/22')) return Response.json({ id: 22, name: 'Example', company_id: 22 });
      return Response.json([]);
    }, { HUDU_SEARCH_RESOURCES: ['articles', 'assets', 'companies', 'users', 'groups', 'websites'] });
    try {
      const result = await session.call('hudu_get_company_context', { id: 22, opts: { limit: 25, expand } });
      expect(session.urls.some((url) => new URL(url).pathname.endsWith('/asset_passwords'))).toBe(true);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({ error: true, code: 'UNAUTHORIZED', httpStatus: 401, message: 'Bad credentials' });
    } finally {
      await session.close();
    }
  });
});
