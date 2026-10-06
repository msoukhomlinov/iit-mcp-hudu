/**
 * mcp-session.ts — the shared MCP-session harness for the tool-contract tests.
 *
 * The session is driven through `serveStdio`'s `transport` option: a fake Transport takes the place
 * of process stdio, so every assertion is made against what actually crosses the wire —
 * protocol-converted JSON Schema, real `tools/call` dispatch — rather than against the zod objects
 * we happened to hand the SDK. Hudu itself is stubbed at `globalThis.fetch`; no test reaches a
 * tenant, and the default stub fails loudly if one tries.
 */
import type { McpServerFactory } from '@modelcontextprotocol/server';
import { vi } from 'vitest';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Config } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { HUDU_BASE_URL_HEADER, HUDU_KEY_HEADER } from '../../src/auth.js';
import { createMcpServerFactory } from '../../src/tools.js';

/** Distinctive enough that a leak into any response is unmistakable. */
export const API_KEY = 'super-secret-key-never-logged';

export const config: Config = {
  HUDU_BASE_URL: 'https://hudu.invalid',
  HUDU_API_KEY: API_KEY,
  MCP_TRANSPORT: 'stdio',
  PORT: 8787,
  LOG_LEVEL: 'error',
  // `all` is today's behaviour, so every pre-existing governor assertion keeps describing the
  // `all` path; the policy tests override it per-session.
  HUDU_READ_ONLY: false,
  HUDU_WRITE_POLICY: 'all',
  HUDU_WRITE_ALLOW: [],
  HUDU_SECRET_READS: 'deny',
  // The 0.12.0 preset knobs at their defaults (see src/config.ts); per-session tests
  // override them.
  HUDU_CACHE_PRESET: 'recommended',
  HUDU_COOLDOWN: 'on',
  HUDU_TIMEOUT_MS: 30000,
};

export type Json = Record<string, any>;

export interface Session {
  list(): Promise<Json[]>;
  call(name: string, args: Json): Promise<Json>;
  /** Every URL the SDK actually requested. A write that slipped the governor would show up here. */
  urls: string[];
  /** Every log line the server wrote, as parsed JSON — the audit hook's output lands here. */
  logs: Json[];
  close(): Promise<void>;
}

/**
 * Open an MCP session over a fake transport and complete the handshake.
 *
 * @param respond stands in for Hudu. The default refuses: a test that reaches the network has a bug
 *   in the test, not a passing case.
 * @param override per-session config overrides (the write policy, mostly).
 */
export async function connect(respond?: (url: string) => Response, override: Partial<Config> = {}): Promise<Session> {
  const sent: Json[] = [];
  const transport: any = { async start() {}, async close() {}, async send(m: Json) { sent.push(m); } };
  // Captured rather than written: the audit hook is asserted below, and a test suite that prints
  // one line per stubbed Hudu request buries its own failures.
  const logs: Json[] = [];
  const log = createLogger('info', (line) => logs.push(JSON.parse(line)));
  const handle = serveStdio(createMcpServerFactory({ ...config, ...override }, log), { transport });

  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: unknown) => {
    urls.push(String(url));
    if (respond === undefined) throw new Error('unexpected network call');
    return respond(String(url));
  });

  let id = 0;
  async function rpc(method: string, params: Json): Promise<Json> {
    const mine = ++id;
    await transport.onmessage({ jsonrpc: '2.0', id: mine, method, params });
    // The handler answers asynchronously; poll for our reply rather than guessing a sleep.
    for (let i = 0; i < 500 && !sent.find((m) => m.id === mine); i++) await new Promise((r) => setTimeout(r, 5));
    const reply = sent.find((m) => m.id === mine);
    if (reply === undefined) throw new Error(`no reply to ${method}`);
    return reply;
  }

  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  await transport.onmessage({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return {
    list: async () => (await rpc('tools/list', {})).result.tools,
    call: async (name, args) => {
      const reply = await rpc('tools/call', { name, arguments: args });
      return reply.result ?? reply.error;
    },
    urls,
    logs,
    close: () => handle.close(),
  };
}

/**
 * Open an MCP session under the `http` transport. Under `http` the server holds no Hudu key AND no
 * Hudu origin: the caller supplies both per request, in the `x-hudu-api-key` and
 * `x-hudu-base-url` headers, and the SDK builds a client scoped to the (origin, credential) pair.
 * This drives the factory directly with a request context, which is exactly what
 * `createMcpHandler` does.
 *
 * @param apiKey the per-request key; a key-less request carries no `x-hudu-api-key` header at all,
 *   which is what a client's catalog sync sends.
 * @param respond stands in for Hudu; it receives the `x-api-key` the SDK presented.
 * @param logs an optional collector for the server's log lines.
 * @param override per-session config overrides.
 * @param base the per-request Hudu origin, sent as `x-hudu-base-url`. Defaults to the stdio
 *   fixture's origin so existing keyed sessions keep hitting the same stubbed URLs; pass
 *   `null` to send no header at all (`undefined` would just select the default).
 */
export async function connectForRequest(
  apiKey: string | undefined,
  respond: (key: string | null) => Response,
  logs: Json[] = [],
  override: Partial<Config> = {},
  base: string | null = 'https://hudu.invalid',
  factory?: McpServerFactory,
): Promise<Session> {
  // Under `http` the server holds no Hudu config at all: the origin and the credential arrive per
  // request, so both env-derived values must be dropped from the (stdio-shaped) fixture.
  const httpConfig: Config = {
    ...config,
    MCP_TRANSPORT: 'http',
    HUDU_API_KEY: undefined,
    HUDU_BASE_URL: undefined,
    ...override,
  };
  const sent: Json[] = [];
  const transport: any = { async start() {}, async close() {}, async send(m: Json) { sent.push(m); } };
  const log = createLogger('info', (line) => logs.push(JSON.parse(line)));
  const server = (factory ?? createMcpServerFactory(httpConfig, log))({
    era: 'modern',
    requestInfo: new Request('http://localhost:8787/mcp', {
      method: 'POST',
      headers: {
        ...(apiKey === undefined ? {} : { [HUDU_KEY_HEADER]: apiKey }),
        ...(base === null ? {} : { [HUDU_BASE_URL_HEADER]: base }),
      },
      body: '{}',
    }),
  });
  await server.connect(transport);
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    urls.push(String(url));
    const key = new Headers(init?.headers).get('x-api-key');
    return respond(key);
  });

  let id = 0;
  async function rpc(method: string, params: Json): Promise<Json> {
    const mine = ++id;
    await transport.onmessage({ jsonrpc: '2.0', id: mine, method, params });
    for (let i = 0; i < 500 && !sent.find((m) => m.id === mine); i++) await new Promise((r) => setTimeout(r, 5));
    const reply = sent.find((m) => m.id === mine);
    if (reply === undefined) throw new Error(`no reply to ${method}`);
    return reply;
  }
  await rpc('initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  await transport.onmessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return {
    list: async () => (await rpc('tools/list', {})).result.tools,
    call: async (name, args) => {
      const reply = await rpc('tools/call', { name, arguments: args });
      return reply.result ?? reply.error;
    },
    urls,
    logs,
    close: () => server.close(),
  };
}
