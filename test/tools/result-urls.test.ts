import { describe, expect, it } from 'vitest';
import { normalizeResultUrls } from '../../src/tools/result-urls.js';

const origin = 'https://hudu.example:8443';

describe('normalizeResultUrls', () => {
  it('copies nested objects and lists while normalizing documented URL fields only', () => {
    const record = Object.freeze({ knowledge_base_url: '/kba?company_id=1', url: '/companies/1#docs',
      notes: '/kba?company_id=1', custom_url: '/custom', website: 'https://external.example',
      full_url: 'https://external.example/existing', passwords_url: '/passwords', asset_url: '/assets/2',
      share_url: '/share', download_url: '/download', image_url: '/image', login_url: '/login' });
    const input = Object.freeze({ rows: Object.freeze([record]), nested: Object.freeze({ record }), count: 1, empty: null });
    const output = normalizeResultUrls(input, origin) as typeof input;
    expect(output).not.toBe(input);
    expect(output.rows[0]).not.toBe(record);
    expect(output.rows[0]).toMatchObject({
      knowledge_base_url: `${origin}/kba?company_id=1`, url: `${origin}/companies/1#docs`,
      notes: record.notes, custom_url: record.custom_url, website: record.website, full_url: record.full_url,
      passwords_url: `${origin}/passwords`, asset_url: `${origin}/assets/2`, share_url: `${origin}/share`,
      download_url: `${origin}/download`, image_url: `${origin}/image`, login_url: `${origin}/login`,
    });
    expect(output.nested.record).toEqual(output.rows[0]);
    expect(record.knowledge_base_url).toBe('/kba?company_id=1');
  });

  it.each(['//evil.example/x', '/\\evil.example/x', '\\evil.example/x', '/x\ny', '/x\ty', '/x\0y',
    '/x\u007fy', '/with space', ' /x', '/bad%', '/bad%zz', '/%2fevil', '/%5cevil', '/%0aevil',
    'relative/path', '?query', '#fragment', '', 'https://other.example/x', 'javascript:alert(1)'])(
    'leaves unsafe or non-root-relative value %j unchanged', (url) => {
      expect(normalizeResultUrls({ url }, origin)).toEqual({ url });
    },
  );

  it.each([undefined, '', 'not-a-url', 'https://hudu.example/path', 'file:///tmp',
    'https://user:pass@hudu.example', 'https://hudu.example/'])(
    'does not normalize without a canonical HTTP(S) origin (%j)', (base) => {
      expect(normalizeResultUrls({ url: '/kba' }, base)).toEqual({ url: '/kba' });
    },
  );

  it('handles null/non-string fields and valid percent-encoded paths', () => {
    expect(normalizeResultUrls({ url: null, full_url: 4, rows: [{ url: '/kb/hello%20world?q=a&b=c#section' }] }, origin))
      .toEqual({ url: null, full_url: 4, rows: [{ url: `${origin}/kb/hello%20world?q=a&b=c#section` }] });
  });
});
