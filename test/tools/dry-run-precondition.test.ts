/**
 * dry-run-precondition.test.ts — regression gate for the node-hudu 0.24.0 plain-path dry-run
 * precondition (node-hudu#43, node-hudu PR #129; this repo 0.11.0). A plain-path (non-Markdown,
 * block-HTML-body) articles.update dry run carrying opts.expectedUpdatedAt now issues the guard's
 * GET and reports a `precondition` check; a stale revision returns wouldApply: false instead of
 * the 0.23.0 zero-request wouldApply: true preview. This test FAILS against the 0.23.0 install
 * and pins the behaviour change the dependency bump makes live.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from '../helpers/mcp-session.js';

afterEach(() => vi.unstubAllGlobals());

const ACTUAL = '2026-10-28T00:00:00.000Z';
const stored = () =>
  Response.json({ id: 5, name: 'Router config', slug: 'router-config', updated_at: ACTUAL, content: '<p>old body</p>' });

describe('hudu_write dry-run expectedUpdatedAt precondition (node-hudu#43, node-hudu 0.24.0)', () => {
  it('a stale plain-path dry run fetches the record and reports wouldApply:false with the precondition detail', async () => {
    const session = await connect(stored);
    try {
      const result = await session.call('hudu_write', {
        operation: 'articles.update',
        input: { id: 5, data: { content: '<p>new body</p>' }, opts: { expectedUpdatedAt: '2026-10-01T00:00:00.000Z' } },
      });
      expect(result.isError, JSON.stringify(result)).toBeUndefined();
      expect(result.structuredContent.simulated).toBe(true);
      // 0.23.0 issued ZERO requests here; 0.24.0 proves the revision with exactly one GET.
      expect(session.urls).toHaveLength(1);
      expect(session.methods[0]).toBe('GET');
      expect(session.urls[0]).toContain('/articles/5');
      expect(session.methods).not.toContain('PUT');
      const report = result.structuredContent.result as { wouldApply?: boolean; checks?: { name?: string; ok?: boolean; detail?: string }[]; target?: { name?: string; updated_at?: string } };
      expect(report.wouldApply).toBe(false);
      const pre = (report.checks ?? []).find((c) => c.name === 'precondition');
      expect(pre, JSON.stringify(report)).toBeDefined();
      expect(pre!.ok).toBe(false);
      expect(pre!.detail).toContain('differs');
      // The report names the current record it fetched.
      expect(report.target?.name).toBe('Router config');
      expect(report.target?.updated_at).toBe(ACTUAL);
    } finally {
      await session.close();
    }
  });

  it('a matching plain-path dry run fetches the record and reports wouldApply:true', async () => {
    const session = await connect(stored);
    try {
      const result = await session.call('hudu_write', {
        operation: 'articles.update',
        input: { id: 5, data: { content: '<p>new body</p>' }, opts: { expectedUpdatedAt: ACTUAL } },
      });
      expect(result.isError, JSON.stringify(result)).toBeUndefined();
      expect(result.structuredContent.simulated).toBe(true);
      expect(session.urls).toHaveLength(1);
      expect(session.methods).not.toContain('PUT');
      const report = result.structuredContent.result as { wouldApply?: boolean; checks?: { name?: string; ok?: boolean; detail?: string }[] };
      expect(report.wouldApply).toBe(true);
      const pre = (report.checks ?? []).find((c) => c.name === 'precondition');
      expect(pre, JSON.stringify(report)).toBeDefined();
      expect(pre!.ok).toBe(true);
      expect(pre!.detail).toContain('matches');
    } finally {
      await session.close();
    }
  });

  it('a plain-path dry run without expectedUpdatedAt stays zero-request (unchanged from 0.23.0)', async () => {
    const session = await connect(stored);
    try {
      const result = await session.call('hudu_write', {
        operation: 'articles.update',
        input: { id: 5, data: { content: '<p>new body</p>' } },
      });
      expect(result.isError, JSON.stringify(result)).toBeUndefined();
      expect(result.structuredContent.simulated).toBe(true);
      expect(session.urls).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
