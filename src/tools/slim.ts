/**
 * slim.ts — trims bytes from every served tool schema that no model reads: the `$schema` URI and
 * the safe-integer `maximum`/`minimum` zod emits for `.int()`. Applied by wrapping each schema's
 * standard-schema JSON converter, so validation and handler types are untouched.
 */
import type { McpServer } from '@modelcontextprotocol/server';

const SAFE = Number.MAX_SAFE_INTEGER;

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$schema' || ((k === 'maximum' || k === 'minimum') && Math.abs(v as number) === SAFE)) continue;
    out[k] = strip(v);
  }
  return out;
}

function slim<T extends object>(schema: T): T {
  return new Proxy(schema, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop !== '~standard') return value;
      const std = value as { jsonSchema: Record<'input' | 'output', (o: unknown) => unknown> };
      return { ...std, jsonSchema: { input: (o: unknown) => strip(std.jsonSchema.input(o)), output: (o: unknown) => strip(std.jsonSchema.output(o)) } };
    },
  });
}

/** Wrap `server.registerTool` so every tool registered afterwards serves slimmed schemas. */
export function slimToolSchemas(server: McpServer): void {
  const register = server.registerTool.bind(server) as (name: string, config: Record<string, unknown>, cb: unknown) => unknown;
  (server as { registerTool: unknown }).registerTool = (name: string, config: Record<string, unknown>, cb: unknown) =>
    register(name, {
      ...config,
      ...(config.inputSchema ? { inputSchema: slim(config.inputSchema as object) } : {}),
      ...(config.outputSchema ? { outputSchema: slim(config.outputSchema as object) } : {}),
    }, cb);
}
