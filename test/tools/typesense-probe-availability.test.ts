/**
 * typesense-probe-availability.test.ts — the TWO questions the probe asks, kept apart (owner review).
 *
 * "Is the operation built into this SDK version?" comes from the capability registry (plain data).
 * "Does this client's policy permit it right now?" comes from membership on `operations`. A policy
 * can permit what a build lacks and a build can carry what a policy omits, so one check cannot stand
 * for both — and their failure codes must differ, or a reader cannot tell which question failed.
 *
 * The registry is mocked here ONLY to make the "built" half reachable on 0.20.0, where the probe does
 * not exist yet; the mocked record is the plain data the real registry returns for a built operation.
 * Nothing else about node-hudu is stubbed, and the real 0.20.0 behaviour (NOT_IMPLEMENTED end to end)
 * is asserted in typesense-tier.test.ts without this mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';

const registry = vi.hoisted(() => ({ built: false }));

vi.mock('node-hudu/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node-hudu/capabilities')>();
  return {
    ...actual,
    getCapability: (key: string) =>
      key === 'operations.probeBodySearch'
        ? registry.built
          ? ({ name: key, effect: 'read', dependsOn: [], flags: [] } as never)
          : undefined
        : actual.getCapability(key as never),
  };
});

const { probeTypesense } = await import('../../src/tools/typesense-probe.js');
const { registerReadTools } = await import('../../src/tools/reads.js');
type McpServer = Parameters<typeof registerReadTools>[0];

const TYPESENSE = {
  HUDU_TYPESENSE_URL: 'https://typesense.example.com',
  HUDU_TYPESENSE_API_KEY: 'test-key-not-real',
} as const;
const config = loadConfig({ HUDU_BASE_URL: 'https://hudu.example.com', HUDU_API_KEY: 'k-123', ...TYPESENSE });
const host = (operations?: unknown) => ({ operations }) as unknown as Parameters<typeof probeTypesense>[0];

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  registry.built = false;
});

describe('probeTypesense — not built into this SDK version', () => {
  it('reports NOT_IMPLEMENTED and dials nothing, even when a policy would permit it', async () => {
    let dialed = 0;
    const report = await probeTypesense(
      host({
        probeBodySearch: async () => {
          dialed += 1;
          return { configured: true, collections: [], reachable: true, probeMs: 1 };
        },
      }),
      config,
    );
    expect(dialed).toBe(0);
    expect(report).toEqual({
      configured: true,
      reachable: false,
      collections: ['articles', 'assets'],
      probeMs: expect.any(Number),
      error: { code: 'NOT_IMPLEMENTED', message: 'this SDK version has no operations.probeBodySearch' },
    });
  });
});

describe('probeTypesense — built, but this client policy does not permit it', () => {
  beforeEach(() => {
    registry.built = true;
  });

  it('reports POLICY_DENIED and dials nothing when the member is absent', async () => {
    for (const operations of [undefined, {}]) {
      const report = await probeTypesense(host(operations), config);
      expect(report).toEqual({
        configured: true,
        reachable: false,
        collections: ['articles', 'assets'],
        probeMs: expect.any(Number),
        error: { code: 'POLICY_DENIED', message: 'this client policy does not permit operations.probeBodySearch' },
      });
    }
  });

  it('is not fooled by the fabricating proxy, which answers any name with a callable', async () => {
    let called = 0;
    const fabricating = new Proxy(
      {},
      {
        get: () => () => {
          called += 1;
          throw Object.assign(new Error('unknown operation'), { code: 'POLICY_DENIED' });
        },
      },
    );
    const report = await probeTypesense(host(fabricating), config);
    expect(called).toBe(0);
    expect(report.error).toEqual({
      code: 'POLICY_DENIED',
      message: 'this client policy does not permit operations.probeBodySearch',
    });
    expect(report.reachable).toBe(false);
  });
});

describe('probeTypesense — built and permitted', () => {
  beforeEach(() => {
    registry.built = true;
  });

  const permitted = (impl: () => Promise<unknown>) => host({ probeBodySearch: impl });

  it('maps the agreed 0.21.0 result, with exactly its four keys and no error', async () => {
    const report = await probeTypesense(
      permitted(async () => ({ configured: true, collections: ['arts', 'assets'], reachable: true, probeMs: 12 })),
      config,
    );
    expect(report).toEqual({ configured: true, reachable: true, collections: ['arts', 'assets'], probeMs: 12 });
    expect(Object.keys(report).sort()).toEqual(['collections', 'configured', 'probeMs', 'reachable']);
  });

  it('keeps a transport failure named as such, never as a refusal', async () => {
    const report = await probeTypesense(
      permitted(async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'TYPESENSE_UNAVAILABLE' });
      }),
      config,
    );
    expect(report).toEqual({
      configured: true,
      reachable: false,
      collections: ['articles', 'assets'],
      probeMs: expect.any(Number),
      error: { code: 'TYPESENSE_UNAVAILABLE', message: 'the probe request failed' },
    });
    expect(JSON.stringify(report)).not.toContain(TYPESENSE.HUDU_TYPESENSE_API_KEY);
  });

  it('still says "not permitted" when the policy refuses the call itself', async () => {
    const report = await probeTypesense(
      permitted(async () => {
        throw Object.assign(new Error('denied'), { code: 'POLICY_DENIED' });
      }),
      config,
    );
    expect(report.error).toEqual({
      code: 'POLICY_DENIED',
      message: 'this client policy does not permit operations.probeBodySearch',
    });
  });
});

describe('hudu_get_api_info publishes the same distinction', () => {
  /** Drive the registered handler with a fake client, so the report is asserted where a caller sees it. */
  function apiInfo(operations: Record<string, unknown>) {
    let handler!: (args: Record<string, unknown>) => Promise<unknown>;
    const server = {
      registerTool: (name: string, _spec: unknown, h: (args: Record<string, unknown>) => Promise<unknown>) => {
        if (name === 'hudu_get_api_info') handler = h;
      },
    } as unknown as McpServer;
    registerReadTools(server, {
      hudu: { apiInfo: { resolve: async () => ({ version: 'as-test', date: '2026-01-01' }) }, operations },
      huduOrigin: 'https://hudu.example.com',
      config,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      ops: {},
      searchableResources: ['articles', 'assets'],
      defaultSearchScope: ['articles', 'assets'],
      bodySearchable: true,
      typesenseConfigured: true,
      toolDefaultTier: 'typesense',
      searchTierIsPolicy: false,
    } as never);
    return handler;
  }

  it('reports POLICY_DENIED when the build has it and the policy does not permit it', async () => {
    registry.built = true;
    const result = (await apiInfo({})({})) as { structuredContent: Record<string, unknown> };
    expect(result.structuredContent.typesense).toMatchObject({
      configured: true,
      reachable: false,
      error: { code: 'POLICY_DENIED', message: 'this client policy does not permit operations.probeBodySearch' },
    });
  });

  it('reports NOT_IMPLEMENTED when the build does not have it, whatever the policy says', async () => {
    registry.built = false;
    const result = (await apiInfo({ probeBodySearch: async () => ({}) })({})) as { structuredContent: Record<string, unknown> };
    expect(result.structuredContent.typesense).toMatchObject({
      configured: true,
      reachable: false,
      error: { code: 'NOT_IMPLEMENTED', message: 'this SDK version has no operations.probeBodySearch' },
    });
  });
});
