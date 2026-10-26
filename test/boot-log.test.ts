/**
 * boot-log.test.ts — what an UNSET deployment prints at boot, byte for byte.
 *
 * The tier's promise is that an operator who never heard of Typesense sees no change: same tool
 * surface, same behaviour, same boot output. This test pins the output of a real process, because a
 * unit test of `describeTypesense` alone would pass while `main` still emitted a line for it.
 *
 * The fixtures are FILES, not objects: each emitted line is compared as text after the timestamp
 * value is replaced with a placeholder, so whitespace, key order or a new field all fail. A
 * configured deployment is asserted the same way, so its one state line cannot spread into the unset
 * path later.
 *
 * To refresh a fixture deliberately: boot the server with `</dev/null` and the env below, replace
 * each `"ts":"…"` value with `"ts":"<ts>"`, and say why in the commit message.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const BASE = {
  HUDU_BASE_URL: 'https://hudu.example.com',
  HUDU_API_KEY: 'k-123',
  MCP_TRANSPORT: 'stdio',
  LOG_LEVEL: 'info',
};

const TYPESENSE = {
  HUDU_TYPESENSE_URL: 'https://typesense.example.com',
  HUDU_TYPESENSE_API_KEY: 'test-key-not-real',
};

/** Replace the timestamp VALUE only; every other byte must match the fixture. */
function normalise(stderr: string): string {
  return `${stderr
    .trim()
    .split('\n')
    .map((line) => line.replace(/"ts":"[^"]*"/, '"ts":"<ts>"'))
    .join('\n')}\n`;
}

function boot(env: Record<string, string>): { stderr: string; log: string } {
  // stdin closed immediately: a stdio server exits instead of waiting for a session.
  const run = spawnSync('node', ['--import', 'tsx', 'src/main.ts'], {
    env: { PATH: process.env.PATH ?? '', ...env },
    input: '',
    encoding: 'utf8',
    timeout: 120_000,
  });
  const stderr = run.stderr ?? '';
  return { stderr, log: normalise(stderr) };
}

describe('boot log — an unset Typesense deployment is byte-identical', () => {
  it('prints exactly the bytes it printed before the tier existed', () => {
    expect(boot(BASE).log).toBe(readFileSync(new URL('./fixtures/boot-log-unset.jsonl', import.meta.url), 'utf8'));
  });
});

describe('boot log — a configured deployment says so, once', () => {
  it('adds its one state line between the policy line and the transport line', () => {
    const { stderr, log } = boot({ ...BASE, ...TYPESENSE });
    expect(log).toBe(readFileSync(new URL('./fixtures/boot-log-typesense.jsonl', import.meta.url), 'utf8'));
    // The key and the endpoint never reach the log, in any rendering.
    expect(stderr).not.toContain('test-key-not-real');
    expect(stderr).not.toContain('typesense.example.com');
  });
});
