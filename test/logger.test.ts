import { describe, it, expect } from 'vitest';
import { createLogger } from '../src/logger.js';

describe('createLogger', () => {
  it('emits one JSON object per line', () => {
    const lines: string[] = [];
    createLogger('info', (l) => lines.push(l)).info('hello', { port: 8787 });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({ level: 'info', msg: 'hello', port: 8787 });
    expect(typeof parsed.ts).toBe('string');
  });

  it('drops messages below the threshold', () => {
    const lines: string[] = [];
    const log = createLogger('warn', (l) => lines.push(l));
    log.debug('no');
    log.info('no');
    log.warn('yes');
    log.error('yes');
    expect(lines).toHaveLength(2);
  });

  it('defaults to stderr, never stdout', () => {
    // On the stdio transport stdout carries the MCP protocol; a log line there breaks the session.
    const log = createLogger('info');
    expect(() => log.info('to stderr')).not.toThrow();
  });
});
