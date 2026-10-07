/**
 * http.ts — the remote transport: streamable HTTP.
 *
 * This is the path remote MCP clients use. Many clients speak streamable HTTP only
 * (one POST endpoint), so this transport is not optional for that consumer. The per-caller Hudu key
 * in `X-Hudu-Api-Key` — together with the origin in `X-Hudu-Base-Url` — is what the tools use to
 * reach Hudu, unless the optional `HUDU_API_KEY` / `HUDU_BASE_URL` defaults fill them in — see
 * `src/auth.ts` and `resolveHuduClient`.
 * The transport boundary is the network: the listener must stay on a private, unpublished network.
 *
 * A request with no Hudu key is allowed through so the SDK can serve `initialize`/`tools/list` for
 * a catalog sync; it resolves to a credential-less client that fails closed on any tool call, so
 * no caller borrows an identity.
 *
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { HUDU_BASE_URL_HEADER, HUDU_KEY_HEADER } from './auth.js';
import { runDoctor, type DoctorReport } from './doctor.js';

/** The headers that carry per-request scope, and so must never be read from a duplicated pair. */
const CREDENTIAL_HEADERS = new Set([HUDU_KEY_HEADER, HUDU_BASE_URL_HEADER]);

/** A fetch-shaped MCP handler, as returned by the SDK's `createMcpHandler`. */
export interface FetchHandler {
  fetch(request: Request): Promise<Response>;
}

/** Liveness path. Answered before authentication so a container healthcheck needs no credential. */
export const HEALTH_PATH = '/healthz';

/**
 * The zero-wire credential preflight route.
 *
 * Same trust model as {@link HEALTH_PATH}: answered before the MCP handler, never authenticated,
 * and never touching Hudu. It reports the shape of the SERVER-HELD credential only — the caller's
 * own per-request key is checked at the tool boundary, one request at a time, and is deliberately
 * not echoed back to the caller that sent it. Reporting shape facts (a length, a two-character
 * prefix, anomaly names) about the server's own environment is therefore not a disclosure: the
 * caller that can reach this listener is the operator who set that environment.
 */
export const DOCTOR_PATH = '/doctor';

/**
 * Build the fetch-level request handler: health, doctor, then MCP.
 *
 * Split out from the listener so the request path is testable without binding a port.
 *
 * `doctor` is a builder, not a constant, so the route reports THIS process's parsed config and so
 * the route itself stays Hudu-free: nothing is read until a request arrives.
 */
export function createFetchHandler(mcp: FetchHandler, doctor?: () => DoctorReport) {
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Liveness only. It must not touch Hudu — see the Dockerfile HEALTHCHECK note.
    if (url.pathname === HEALTH_PATH) {
      return Response.json({ status: 'ok' });
    }

    // Credential shape, still no Hudu. `dialed: 0` is a property of the implementation (see
    // `src/doctor.ts`, which holds no client), not a counter that a bug could leave at zero.
    if (url.pathname === DOCTOR_PATH && doctor !== undefined) {
      return Response.json(doctor());
    }

    // No check for the Hudu key: a request with no key is let through so the SDK can answer
    // `initialize`/`tools/list`, which never reach Hudu and which clients need to sync the tool
    // catalog. The per-request factory resolves such a request to a client that holds no credential
    // and throws before any Hudu request is built, so every tool call fails closed and no caller
    // borrows an identity.
    return mcp.fetch(request);
  };
}

/** Node has no fetch-shaped HTTP server; this is the smallest bridge to one. */
export async function toWebRequest(req: IncomingMessage, port: number): Promise<Request> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `localhost:${port}`}`);
  const headers = new Headers();
  // Iterate `headersDistinct`, not `headers`. Node has already joined a duplicated custom header
  // with ", " in `req.headers`, so by the time a `Headers` bag was built the two values would look
  // like one well-formed credential and pass a non-blank check. The distinct view keeps them apart
  // so a credential presented twice can be treated as absent — see `readSingleHeader`.
  for (const [name, values] of Object.entries(req.headersDistinct)) {
    if (values === undefined || values.length === 0) continue;
    if (values.length > 1) {
      // A credential presented more than once is malformed. Drop it rather than trust one value,
      // which is the rule `readSingleHeader` applies to an array. Non-credential duplicates keep
      // Node's combining behaviour.
      if (CREDENTIAL_HEADERS.has(name)) continue;
      for (const one of values) headers.append(name, one);
      continue;
    }
    // `values.length` is exactly 1 here (empty was skipped, greater-than-one handled above).
    headers.set(name, values[0]!);
  }
  if (req.method === 'GET' || req.method === 'HEAD') return new Request(url, { method: req.method, headers });
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  return new Request(url, { method: req.method, headers, body: Buffer.concat(chunks).toString('utf8') });
}

/**
 * Stream a web Response into the Node response — incrementally, never buffered.
 *
 * Buffering would deliver nothing to the client until the upstream body closed, hanging any
 * long-lived or incremental body.
 */
export async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (response.body === null || res.req.method === 'HEAD') {
    res.end();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>), res);
  } catch {
    // Status and headers are already on the wire; pipeline has destroyed both ends.
  }
}

/**
 * Bind the listener. `mcp` is supplied by the caller so this module never builds tools itself.
 *
 * `exit` is a parameter only so a test can watch a listen failure without killing the test runner.
 */
export function startHttpServer(
  config: Config,
  mcp: FetchHandler,
  log: Logger,
  exit: (code: number) => void = process.exit,
): Server {
  const handle = createFetchHandler(mcp, () => runDoctor(config));
  const server = createServer((req, res) => {
    void toWebRequest(req, config.PORT)
      .then(handle)
      .then((response) => send(res, response))
      .catch((err: unknown) => {
        // Never echo the error to the caller: it can carry internal detail.
        log.error('request failed', { err: err instanceof Error ? err.message : String(err) });
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end('internal error');
        } else {
          res.destroy();
        }
      });
  });
  // Without a listener here, a bind failure (EADDRINUSE, EACCES on a privileged port) is an
  // unhandled 'error' event and Node rethrows it as a raw stack trace. It is the same class of boot
  // failure as an invalid config: name the problem, exit non-zero, so an orchestrator sees a failed
  // container rather than a healthy-but-useless one.
  server.on('error', (err: Error) => {
    log.error('listen failed', { port: config.PORT, err: err.message });
    exit(1);
  });
  server.listen(config.PORT, () => log.info('listening', { port: config.PORT, transport: 'http' }));
  return server;
}
