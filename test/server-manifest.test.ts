import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const json = (p: string) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));

describe('server.json', () => {
  it('sdk versionRange matches the node-hudu dependency', () => {
    expect(json('server.json').sdk.versionRange).toBe(json('package.json').dependencies['node-hudu']);
  });

  it('version matches package.json (the manifest must not drift from the release)', () => {
    expect(json('server.json').version).toBe(json('package.json').version);
  });
});
