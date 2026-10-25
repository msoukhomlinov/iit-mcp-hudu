/** Pins the fixed SDK client options (formerly env knobs): removing one would leave every other test green. */
import { describe, expect, it, vi } from 'vitest';

const captured: Record<string, unknown>[] = [];

vi.mock('node-hudu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node-hudu')>();
  class SpyClient extends actual.HuduClient {
    constructor(options: Record<string, unknown>) {
      captured.push(options);
      super(options as never);
    }
  }
  return { ...actual, HuduClient: SpyClient };
});

const { connect } = await import('../helpers/mcp-session.js');

describe('fixed SDK client options', () => {
  it('every client is built with the agent profile, recommended cache, 429 cooldown and a 30 s deadline', async () => {
    const session = await connect();
    await session.close();
    expect(captured.length).toBeGreaterThan(0);
    for (const options of captured) {
      expect(options).toMatchObject({ profile: 'agent', cache: 'recommended', timeoutMs: 30000, cooldown: { enabled: true } });
      // The body-index text budget follows the process heap (#51), so every client carries one.
      const search = options.search as { maxIndexTextBytes?: number } | undefined;
      expect(search?.maxIndexTextBytes).toBeGreaterThanOrEqual(8 * 1024 * 1024);
      expect(search?.maxIndexTextBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    }
  });
});
