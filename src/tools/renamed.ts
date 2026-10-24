/**
 * renamed.ts — a call to a tool name this server used to serve gets an error that names its
 * replacement, not a bare "Tool not found". Installed before any tool is registered, so it wraps
 * the SDK's `tools/call` handler through the public `setRequestHandler`; the old names are never
 * listed, so they cost no served bytes.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { configError } from 'node-hudu/mcp';
import { RENAMED_LIST_TOOLS } from './lists.js';
import { errorContent } from './results.js';

type Req = { params?: { name?: string; arguments?: Record<string, unknown> } };

export function answerRenamedTools(server: McpServer): void {
  const inner = server.server as unknown as { setRequestHandler: (method: string, handler: (req: Req, ctx: unknown) => unknown) => unknown };
  const set = inner.setRequestHandler.bind(inner);
  inner.setRequestHandler = (method, handler) =>
    set(method, method !== 'tools/call' ? handler : (req, ctx) => {
      const resource = (RENAMED_LIST_TOOLS as Record<string, string>)[req.params?.name ?? ''];
      if (resource === undefined) return handler(req, ctx);
      const filters = Object.fromEntries(Object.entries(req.params?.arguments ?? {}).filter(([k]) => !['page', 'page_size'].includes(k)));
      return errorContent(configError(
        `${req.params?.name} was replaced by hudu_list in server 0.3.0. Call hudu_list with {"resource":"${resource}","page":N,${resource === 'asset_layouts' ? '' : '"page_size":N,'}"filters":{...}}; your ${Object.keys(filters).length ? `filters (${Object.keys(filters).join(', ')}) move` : 'filters move'} inside "filters".`,
      ));
    });
}
