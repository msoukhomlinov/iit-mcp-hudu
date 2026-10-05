/**
 * tools.test.ts — the barrel's own contract: the catalogue plan the public entry point was built
 * against. Pairs with `src/tools.ts`; the per-module surfaces live under `test/tools/`.
 */
import { describe, expect, it } from 'vitest';
import { CATALOG_PLAN_HASH } from 'node-hudu/mcp';
import { BUILT_AGAINST_PLAN_HASH } from '../src/tools.js';

describe('SDK drift', () => {
  it('was built against the installed catalogue plan', () => {
    // If this fails, the SDK upgrade changed the projected operation set: re-read the catalogue,
    // re-check the 19 tools against it, then move the constant. Never move it to make CI green.
    expect(CATALOG_PLAN_HASH).toBe(BUILT_AGAINST_PLAN_HASH);
  });
});
