import { describe, it, expect } from 'vitest';
import { readHuduBase, readHuduKey, HUDU_BASE_URL_HEADER, HUDU_KEY_HEADER } from '../src/auth.js';

describe('readHuduKey', () => {
  it('reads the per-request key from its own header', () => {
    expect(readHuduKey({ [HUDU_KEY_HEADER]: 'caller-key' })).toBe('caller-key');
  });

  it('does not read the removed legacy x-mcp-token header as a Hudu key', () => {
    // The shared-secret gate is gone; a stale client that still sends the header must not have it
    // mistaken for a credential.
    expect(readHuduKey({ 'x-mcp-token': 'caller-key' })).toBeUndefined();
  });

  it('treats a duplicated header as absent', () => {
    expect(readHuduKey({ [HUDU_KEY_HEADER]: ['a', 'b'] })).toBeUndefined();
  });

  it('returns undefined when absent', () => {
    expect(readHuduKey({})).toBeUndefined();
  });
});

describe('readHuduBase', () => {
  it('reads the per-request base URL from its own header', () => {
    expect(readHuduBase({ [HUDU_BASE_URL_HEADER]: 'https://hudu.example.com' })).toBe('https://hudu.example.com');
  });

  it('does not read the key header as a base URL', () => {
    // The two headers are not interchangeable.
    expect(readHuduBase({ [HUDU_KEY_HEADER]: 'https://hudu.example.com' })).toBeUndefined();
  });

  it('treats a duplicated header as absent', () => {
    // Two different presented origins is a malformed request; picking one invites smuggling bugs.
    expect(readHuduBase({ [HUDU_BASE_URL_HEADER]: ['https://a.example.com', 'https://b.example.com'] })).toBeUndefined();
  });

  it('returns undefined when absent', () => {
    expect(readHuduBase({})).toBeUndefined();
  });
});
