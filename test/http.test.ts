import { afterEach, describe, it, expect, vi } from 'vitest';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createFetchHandler, startHttpServer, HEALTH_PATH, type FetchHandler } from '../src/http.js';
import { createLogger } from '../src/logger.js';
import { loadConfig } from '../src/config.js';
import { HUDU_BASE_URL_HEADER, HUDU_KEY_HEADER, headerRecord, readHuduBase, readHuduKey } from '../src/auth.js';
import { createMcpServerFactory } from '../src/tools.js';

const HUDU_KEY = 'the-callers-own-hudu-key';
// No HUDU_API_KEY and no HUDU_BASE_URL defaults: the caller supplies both per request. There is
// no token gate: the transport boundary is the private, unpublished network.
const config = loadConfig({ MCP_TRANSPORT: 'http', HUDU_ALLOW_ANY_BASE_HOST: 'true' });

const silent = createLogger('error', () => {});

function fakeMcp(): FetchHandler & { calls: number } {
  const h = {
    calls: 0,
    fetch: async () => {
      h.calls++;
      return Response.json({ reached: true });
    },
  };
  return h;
}

const post = (headers: Record<string, string> = {}) =>
  new Request('http://localhost:8787/mcp', {
    method: 'POST',
    headers: { [HUDU_KEY_HEADER]: HUDU_KEY, ...headers },
    body: '{}',
  });

describe('HTTP pass-through', () => {
  it('lets a request with a Hudu key through to MCP', async () => {
    const mcp = fakeMcp();
    const res = await createFetchHandler(mcp)(post());
    expect(res.status).toBe(200);
    expect(mcp.calls).toBe(1);
  });

  it('lets a key-less request through to MCP, so the catalog can sync', async () => {
    // The server holds no Hudu key under http. A request with no key must still reach MCP so the
    // SDK can answer `initialize`/`tools/list`; the per-request factory resolves it to a
    // credential-less client that fails closed on every tool call (see tools.test.ts).
    const mcp = fakeMcp();
    const request = new Request('http://localhost:8787/mcp', { method: 'POST', body: '{}' });
    const res = await createFetchHandler(mcp)(request);
    expect(res.status).toBe(200);
    expect(mcp.calls).toBe(1);
  });

  it('lets a blank Hudu credential through to MCP', async () => {
    // A whitespace-only key is not a credential; the factory treats it like absence and fails closed.
    const mcp = fakeMcp();
    const res = await createFetchHandler(mcp)(post({ [HUDU_KEY_HEADER]: '   ' }));
    expect(res.status).toBe(200);
    expect(mcp.calls).toBe(1);
  });

  it('ignores a legacy x-mcp-token header: identical behaviour to not sending it', async () => {
    // The shared-secret gate is gone; a stale client that still sends the header must get the same
    // answer as one that does not — no 401 regression.
    const mcp = fakeMcp();
    const res = await createFetchHandler(mcp)(post({ 'x-mcp-token': 'stale-legacy-secret' }));
    expect(res.status).toBe(200);
    expect(mcp.calls).toBe(1);
  });

  it('answers health without reaching MCP', async () => {
    const mcp = fakeMcp();
    const res = await createFetchHandler(mcp)(new Request(`http://localhost:8787${HEALTH_PATH}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(mcp.calls).toBe(0);
  });

  it('health does not call Hudu', async () => {
    // A healthcheck that depends on Hudu turns an upstream outage into a container crash loop.
    const spy = vi.spyOn(globalThis, 'fetch');
    await createFetchHandler(fakeMcp())(new Request(`http://localhost:8787${HEALTH_PATH}`));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('HTTP listener', () => {
  it('reports a listen failure through the logger and exits non-zero', async () => {
    // Port 0 lets the OS pick, so the collision below is the one this test caused and not a
    // stray process on a fixed port.
    const held = startHttpServer({ ...config, PORT: 0 }, fakeMcp(), silent);
    await once(held, 'listening');
    const port = (held.address() as AddressInfo).port;

    const lines: string[] = [];
    const codes: number[] = [];
    const clash = startHttpServer(
      { ...config, PORT: port },
      fakeMcp(),
      createLogger('error', (l) => lines.push(l)),
      (code) => codes.push(code),
    );
    await once(clash, 'error');

    expect(lines.join('\n')).toContain('listen failed');
    expect(codes).toEqual([1]);
    held.close();
  });
});

describe('duplicate credential headers over a real listener', () => {
  /**
   * Send a request with `headers` through `toWebRequest`, exactly as the listener does.
   *
   * `fetch`'s Headers cannot express a duplicated header, so this uses the Node client, whose
   * `setHeader(name, [a, b])` emits the header twice — the case Node then joins with ", ".
   */
  async function send(
    extra: Record<string, string | [string, string]>,
    cfg = config,
  ): Promise<{ status: number; received: unknown }> {
    let received: unknown;
    const mcp: FetchHandler = {
      fetch: async (request) => {
        received = { hudu: readHuduKey(headerRecord(request.headers)), base: readHuduBase(headerRecord(request.headers)) };
        return Response.json({ reached: true });
      },
    };
    const server = startHttpServer({ ...cfg, PORT: 0 }, mcp, silent);
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ port, path: '/mcp', method: 'POST' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      for (const [name, value] of Object.entries(extra)) req.setHeader(name, value);
      req.end('{}');
    });
    server.close();
    return { status, received };
  }

  it('treats a duplicated X-Hudu-Api-Key as absent rather than a joined value', async () => {
    // The server holds no Hudu key, so a duplicated key is not a credential: the factory falls
    // back to the credential-less parent. The point is that it is NOT read as "key-a, key-b".
    const { status, received } = await send({ [HUDU_KEY_HEADER]: ['key-a', 'key-b'] });
    expect(status).toBe(200);
    expect((received as { hudu: unknown }).hudu).toBeUndefined();
  });

  it('treats a duplicated X-Hudu-Api-Key as absent on a key-less request, too', async () => {
    const { status, received } = await send({ [HUDU_KEY_HEADER]: ['key-a', 'key-b'] });
    expect(status).toBe(200);
    expect((received as { hudu: unknown }).hudu).toBeUndefined();
  });

  it('treats a duplicated X-Hudu-Base-Url as absent, exactly as with the key', async () => {
    // The base URL joins CREDENTIAL_HEADERS, so a duplicated pair is dropped rather than combined
    // — a request that presents two origins is malformed, and picking one invites smuggling bugs.
    const { status, received } = await send({
      [HUDU_BASE_URL_HEADER]: ['https://origin-a.example.com', 'https://origin-b.example.com'],
    });
    expect(status).toBe(200);
    expect((received as { base: unknown }).base).toBeUndefined();
  });

  it('preserves a single-valued X-Hudu-Api-Key through the transport', async () => {
    const { status, received } = await send({ [HUDU_KEY_HEADER]: 'key-a' });
    expect(status).toBe(200);
    expect((received as { hudu: unknown }).hudu).toBe('key-a');
  });
});

describe('HTTP end-to-end', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The real gate in front of the real MCP handler and tool factory; Hudu is stubbed at fetch. */
  function realHandler() {
    const mcp = createMcpHandler(createMcpServerFactory(config, silent));
    return createFetchHandler(mcp);
  }

  function rpc(method: string, params: Record<string, unknown>, headers: Record<string, string> = {}) {
    return new Request('http://localhost:8787/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  }

  /** The single JSON-RPC message in an SSE or JSON response body. */
  async function message(res: Response): Promise<any> {
    const text = await res.text();
    const data = text.split('\n').find((line) => line.startsWith('data: '));
    return JSON.parse(data === undefined ? text : data.slice('data: '.length));
  }

  function stubHudu() {
    const keys: (string | null)[] = [];
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      urls.push(String(url));
      keys.push(new Headers(init?.headers).get('x-api-key'));
      return Response.json({ version: '2.45.1', date: '2026-01-01' });
    });
    return { keys, urls };
  }

  it('serves a key-less tools/list with 200 and no Hudu request, with no base-url header either', async () => {
    // Catalog sync sends neither header: the origin is only required when a call would reach Hudu.
    const { keys, urls } = stubHudu();
    const res = await realHandler()(rpc('tools/list', {}));
    expect(res.status).toBe(200);
    expect((await message(res)).result.tools).toHaveLength(19);
    expect(keys).toEqual([]);
    expect(urls).toEqual([]);
  });

  it('fails a key-less tool call closed with zero Hudu requests', async () => {
    const { keys, urls } = stubHudu();
    const res = await realHandler()(rpc('tools/call', { name: 'hudu_get_api_info', arguments: {} }));
    expect((await message(res)).result.isError).toBe(true);
    expect(keys).toEqual([]);
    expect(urls).toEqual([]);
  });

  it('fails a key-bearing, base-less tool call closed with zero Hudu requests, naming the header', async () => {
    // A key without an origin is the mirror of a key-less request: let through for the catalog,
    // then fail closed on every tool call — and the error names the missing header so the caller
    // knows what to fix.
    const { keys, urls } = stubHudu();
    const res = await realHandler()(rpc('tools/call', { name: 'hudu_get_api_info', arguments: {} }, { [HUDU_KEY_HEADER]: HUDU_KEY }));
    const reply = await message(res);
    expect(reply.result.isError).toBe(true);
    expect(JSON.stringify(reply.result)).toContain('x-hudu-base-url');
    expect(keys).toEqual([]);
    expect(urls).toEqual([]);
  });

  it('reaches Hudu at the caller-supplied origin with the caller’s own key', async () => {
    const { keys, urls } = stubHudu();
    const res = await realHandler()(rpc('tools/call', { name: 'hudu_get_api_info', arguments: {} }, {
      [HUDU_KEY_HEADER]: HUDU_KEY,
      [HUDU_BASE_URL_HEADER]: 'https://hudu.example.com',
    }));
    const reply = await message(res);
    expect(reply.result.isError).toBeUndefined();
    expect(reply.result.structuredContent.record.version).toBe('2.45.1');
    expect(keys).toEqual([HUDU_KEY]);
    // The origin is the caller's, not a server-held one: every Hudu request goes there.
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toMatch(/^https:\/\/hudu\.example\.com\//);
  });

  it('resolves the same key at two origins to two distinct clients, each dialed at its own origin', async () => {
    // A key-only cache would have answered the second call from the first origin's client.
    const { urls } = stubHudu();
    const handler = realHandler();
    const a = await message(
      await handler(rpc('tools/call', { name: 'hudu_get_api_info', arguments: {} }, {
        [HUDU_KEY_HEADER]: HUDU_KEY,
        [HUDU_BASE_URL_HEADER]: 'https://origin-a.example.com',
      })),
    );
    const b = await message(
      await handler(rpc('tools/call', { name: 'hudu_get_api_info', arguments: {} }, {
        [HUDU_KEY_HEADER]: HUDU_KEY,
        [HUDU_BASE_URL_HEADER]: 'https://origin-b.example.com',
      })),
    );
    expect(a.result.isError).toBeUndefined();
    expect(b.result.isError).toBeUndefined();
    expect(urls.filter((u) => u.startsWith('https://origin-a.example.com'))).toHaveLength(1);
    expect(urls.filter((u) => u.startsWith('https://origin-b.example.com'))).toHaveLength(1);
  });

  it('still serves a legacy client that sends x-mcp-token: the header is ignored', async () => {
    const { keys } = stubHudu();
    const res = await realHandler()(rpc('tools/call', { name: 'hudu_get_api_info', arguments: {} }, {
      [HUDU_KEY_HEADER]: HUDU_KEY,
      [HUDU_BASE_URL_HEADER]: 'https://hudu.example.com',
      'x-mcp-token': 'stale-legacy-header',
    }));
    const reply = await message(res);
    expect(reply.result.isError).toBeUndefined();
    expect(keys).toEqual([HUDU_KEY]);
  });
});
