/**
 * boot-log.test.ts — what an UNSET deployment prints at boot, byte for byte.
 *
 * The tier's promise is that an operator who never heard of Typesense sees no change: same tool
 * surface, same behaviour, same boot output. This test pins the output of a real process, because a
 * unit test of `describeTypesense` alone would pass while `main` still emitted a line for it.
 *
 * A configured deployment is asserted in the same place: it gains its one state line and nothing
 * else moves, so the line cannot silently spread into the unset path later.
 */
import { spawnSync } from 'node:child_process';

const BASE = {
  HUDU_BASE_URL: 'https://hudu.example.com',
  HUDU_API_KEY: 'k-123',
  MCP_TRANSPORT: 'stdio',
  LOG_LEVEL: 'info',
};

/** The exact boot lines this server printed before the Typesense tier existed. */
const FROZEN = [
  {
    level: 'info',
    msg: 'effective write policy: no write tools registered',
    read_only: false,
    requested: 'deny',
    effective: 'deny',
    tools_registered: [],
  },
  { level: 'info', msg: 'serving', transport: 'stdio' },
];

function bootLines(env: Record<string, string>): { stderr: string; lines: Record<string, unknown>[] } {
  // stdin closed immediately: a stdio server exits instead of waiting for a session.
  const run = spawnSync('node', ['--import', 'tsx', 'src/main.ts'], {
    env: { PATH: process.env.PATH ?? '', ...env },
    input: '',
    encoding: 'utf8',
    timeout: 120_000,
  });
  const stderr = run.stderr ?? '';
  const lines = stderr
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    // The timestamp is the only field allowed to differ between runs.
    .map((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      delete parsed.ts;
      return parsed;
    });
  return { stderr, lines };
}

describe('boot log — an unset Typesense deployment is byte-identical', () => {
  it('prints exactly the lines it printed before the tier existed', () => {
    const { lines } = bootLines(BASE);
    expect(lines).toEqual(FROZEN);
  });
});

describe('boot log — a configured deployment says so, once', () => {
  it('adds its one state line between the policy line and the transport line', () => {
    const { stderr, lines } = bootLines({
      ...BASE,
      HUDU_TYPESENSE_URL: 'https://typesense.example.com',
      HUDU_TYPESENSE_API_KEY: 'test-key-not-real',
    });
    expect(lines).toEqual([
      FROZEN[0],
      { level: 'info', msg: 'typesense: enabled (collections articles, assets)' },
      FROZEN[1],
    ]);
    // The key and the endpoint never reach the log, in any rendering.
    expect(stderr).not.toContain('test-key-not-real');
    expect(stderr).not.toContain('typesense.example.com');
  });
});
