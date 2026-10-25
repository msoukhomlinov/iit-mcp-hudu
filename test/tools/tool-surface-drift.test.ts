/**
 * tool-surface-drift.test.ts — a drift gate over what `tools/list` actually serves.
 *
 * The server owns its tool titles and prose (issue #52 moved them off the SDK's curated strings),
 * so an SDK upgrade that renames a spec title or replaces a description must fail HERE rather than
 * silently change the surface a client pays for. Titles are read from the served list; descriptions
 * are compared with the server-owned prose source (`src/tools/tool-prose.ts`). The dynamic
 * `hudu_search` prose is asserted in search-prose.test.ts; this gate only requires it to be present.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { connect } from '../helpers/mcp-session.js';
import { toolDescription } from '../../src/tools/tool-prose.js';

const registered: string[] = (JSON.parse(readFileSync(new URL('../../capabilities.json', import.meta.url), 'utf8')) as {
  capabilities: { mcpPrimitive?: string; toolName?: string }[];
}).capabilities
  .filter((capability) => capability.mcpPrimitive === 'tool' && typeof capability.toolName === 'string')
  .map((capability) => capability.toolName as string);

/** Captured from a real stdio `tools/list` against the built server; the fixture IS the capture. */
const servedTitles: Record<string, string> = JSON.parse(
  readFileSync(new URL('../fixtures/served-titles.json', import.meta.url), 'utf8'),
) as Record<string, string>;

describe('served tool surface is server-owned', () => {
  it('serves exactly the registered tool names', async () => {
    const session = await connect();
    const tools = await session.list();
    await session.close();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...registered].sort());
  });

  it('pins every title to the captured fixture and every description to the server-owned prose', async () => {
    const session = await connect();
    const tools = await session.list();
    await session.close();
    for (const tool of tools) {
      expect(typeof tool.title === 'string' && tool.title.length > 0, `${tool.name}: title`).toBe(true);
      expect(tool.title, `${tool.name}: title must not fall back to the tool name`).not.toBe(tool.name);
      expect(servedTitles[tool.name], `${tool.name}: title must be captured in test/fixtures/served-titles.json`).toBeDefined();
      expect(tool.title, `${tool.name}: title must match the captured served title (regenerate the fixture from a real stdio tools/list after an intentional rename)`).toBe(servedTitles[tool.name]);
      let expected: string | null = null;
      try {
        expected = toolDescription(tool.name);
      } catch {
        expected = null;
      }
      if (expected === null) {
        expect(String(tool.description).length, `${tool.name}: description`).toBeGreaterThan(0);
      } else {
        expect(tool.description, `${tool.name}: description must be the server-owned prose`).toBe(expected);
      }
    }
  });

  it('covers every registered tool in the committed title fixture', () => {
    expect(Object.keys(servedTitles).sort()).toEqual([...registered].sort());
  });
});
