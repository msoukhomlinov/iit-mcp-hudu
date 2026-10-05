import { describe, expect, it } from 'vitest';
import { baseHostAllowed, originOf } from '../src/base-hosts.js';

describe('baseHostAllowed', () => {
  it('permits anything when no list is set', () => {
    expect(baseHostAllowed('http://169.254.169.254', undefined)).toBe(true);
  });

  it('matches an exact host, case-insensitively, and ignores scheme and port', () => {
    const allow = ['hudu.example.com'];
    expect(baseHostAllowed('https://HUDU.example.com:8443', allow)).toBe(true);
    expect(baseHostAllowed('https://other.example.com', allow)).toBe(false);
  });

  it('matches a *. suffix on subdomains only, not the bare domain or a lookalike', () => {
    const allow = ['*.example.com'];
    expect(baseHostAllowed('https://a.b.example.com', allow)).toBe(true);
    expect(baseHostAllowed('https://example.com', allow)).toBe(false);
    expect(baseHostAllowed('https://evilexample.com', allow)).toBe(false);
  });

  it('is not fooled by userinfo naming an allowed host', () => {
    expect(baseHostAllowed('https://hudu.example.com@evil.test', ['hudu.example.com'])).toBe(false);
  });

  it('refuses an unparsable URL when a list is set', () => {
    expect(baseHostAllowed('not a url', ['hudu.example.com'])).toBe(false);
  });
});

describe('originOf', () => {
  it('normalises, and returns undefined for garbage', () => {
    expect(originOf('https://Hudu.example.com/')).toBe('https://hudu.example.com');
    expect(originOf('nope')).toBeUndefined();
  });
});
