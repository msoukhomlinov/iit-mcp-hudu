/**
 * article-write-summary.ts — the committed article write answers with a summary, not the stored
 * record (issue #63).
 *
 * A committed `hudu_write` on an article used to return the FULL stored record, body included:
 * 13 real-session writes echoed 324,044 chars of stored HTML. The body is one call away
 * whenever it is wanted (`articles.get` with `opts.format: 'html'`, or `hudu_fetch_many`), so
 * the three article writes — `articles.create`, `articles.update`, `articles.patchSection` —
 * answer with a fixed summary: identity fields, a `content_match` verdict on the body that was
 * sent, and byte counts.
 *
 * For create/update `content_match` is EXACT: it compares the stored body to the body the SDK
 * would have sent at the pinned node-hudu 0.23.0 — verbatim when the body opens with block HTML
 * or the caller set `opts.format: 'html'` (in both cases the SDK's withContentFormat leaves the
 * format unset or keeps it as given, so the body is stored as sent), otherwise `markdownToHtml`
 * of the Markdown (the SDK's markdown path converts with the same pinned converter before the
 * PUT). Hudu rewrites inline image `src` to `/public_photo/<slug>` on store, so a body whose
 * images moved is the expected `false`; `element_deltas` then names the stored-minus-sent
 * opening-tag counts. For `articles.patchSection` the write response holds only the post-patch
 * record (the SDK fetches, patches and converts internally and its opts are closed), so
 * `content_match` is a documented WEAKER presence check: the converted section sits inside the
 * stored body. It is valid in all three modes — replace, append, prepend — because the sent
 * block is stored in the document.
 *
 * Deliberate scope: dry runs and every operation other than these three writes keep the full
 * record the dispatchers have always returned (follow-up).
 */
import { markdownToHtml } from 'node-hudu/content';

/**
 * Mirrors node-hudu 0.23.0 (dist/chunk-4QFSLNP7.js, withContentFormat): a body opening with one
 * of these tags is stored as sent and the SDK leaves the content format unset for it.
 */
const BLOCK_HTML = /^\s*(?:<(?:p|div|h[1-6]|table|ul|ol|pre|blockquote|hr)\b|<details[^>]*mce-accordion)/i;

/** The three operations whose committed write answers with the summary. */
const ARTICLE_WRITES: ReadonlySet<string> = new Set(['articles.create', 'articles.update', 'articles.patchSection']);

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Stored-minus-sent opening-tag counts; present only when `content_match` is false. */
export interface ElementDeltas {
  table: number;
  pre: number;
  a: number;
  img: number;
}

/**
 * A committed article-write result shrunk to its summary. The stored body is left out on
 * purpose: it comes back from `articles.get` with `opts.format: 'html'`.
 */
export interface ArticleWriteSummary {
  id: unknown;
  name: unknown;
  slug: unknown;
  updated_at: unknown;
  url: unknown;
  /** UTF-8 bytes of the stored body. */
  stored_bytes: number;
  /** Exact verdict for create/update; the weaker presence check for patchSection. */
  content_match?: boolean;
  /** UTF-8 bytes of the sent body (create/update body writes only). */
  sent_bytes?: number;
  /** Only when `content_match` is false (create/update only). */
  element_deltas?: ElementDeltas;
}

/**
 * Opening-tag counts behind `element_deltas`. Escaped `&lt;tag&gt;` inside code does not match
 * the raw tag regexes — that is correct: it is not an element.
 */
const OPENING_TAGS: ReadonlyArray<readonly [keyof ElementDeltas, RegExp]> = [
  ['table', /<table[\s>]/gi],
  ['pre', /<pre[\s>]/gi],
  ['a', /<a[\s>]/gi],
  ['img', /<img[\s>]/gi],
];

const countOpeningTags = (html: string): ElementDeltas => {
  const out: ElementDeltas = { table: 0, pre: 0, a: 0, img: 0 };
  for (const [key, re] of OPENING_TAGS) out[key] = html.match(re)?.length ?? 0;
  return out;
};

/**
 * The summary of a committed article write, or `undefined` when the result is not a summary
 * target: the operation is not one of the three article writes, or the result is not a plain
 * object whose `content` is a string (unexpected shape) — the result then stays unchanged:
 * never throw, never hide.
 */
export function summarizeArticleWrite(operation: string, result: unknown, bag: unknown): ArticleWriteSummary | undefined {
  if (!ARTICLE_WRITES.has(operation)) return undefined;
  if (!isObject(result) || typeof result.content !== 'string') return undefined;
  const stored = result.content;
  const b = isObject(bag) ? bag : {};
  const summary: ArticleWriteSummary = {
    id: result.id,
    name: result.name,
    slug: result.slug,
    updated_at: result.updated_at,
    url: result.url,
    stored_bytes: Buffer.byteLength(stored, 'utf8'),
  };
  if (operation === 'articles.patchSection') {
    const patch = isObject(b.patch) ? b.patch : {};
    // markdownToHtml throws on empty input; an empty patch carries no block, so it is present
    // by definition.
    const markdown = typeof patch.markdown === 'string' ? patch.markdown : '';
    summary.content_match = stored.includes(markdown === '' ? '' : markdownToHtml(markdown));
    return summary;
  }
  const data = isObject(b.data) ? b.data : {};
  const content = data.content;
  if (typeof content !== 'string' || content === '') {
    // No body sent (a field-only update): nothing to compare, so no content_match and no
    // sent bytes.
    return summary;
  }
  const opts = isObject(b.opts) ? b.opts : {};
  // markdownToHtml throws only on empty input (excluded above), and the SDK has already converted
  // this same string with this same pinned converter to run the write, so this cannot fail.
  const sentHtml = opts.format === 'html' || BLOCK_HTML.test(content) ? content : markdownToHtml(content);
  summary.content_match = stored === sentHtml;
  summary.sent_bytes = Buffer.byteLength(sentHtml, 'utf8');
  if (!summary.content_match) {
    const sent = countOpeningTags(sentHtml);
    const kept = countOpeningTags(stored);
    summary.element_deltas = {
      table: kept.table - sent.table,
      pre: kept.pre - sent.pre,
      a: kept.a - sent.a,
      img: kept.img - sent.img,
    };
  }
  return summary;
}
