/**
 * article-loss.ts — Markdown article reads, and the signal that one is incomplete.
 *
 * Reads return article bodies as Markdown (node-hudu 0.14 dialect); anything Markdown cannot
 * express (an inline <svg>, say) would come back as plain text with no signal, because the SDK keeps
 * loss reporting out of the converter and documents `diffArticleRoundTrip` as the one vocabulary.
 *
 * So the read is made ONCE with `format: 'html'` forced, and the conversion the SDK's own
 * `projectContent` would have done (`htmlToMarkdown`) is done here instead, next to the diff of the
 * stored HTML against `markdownToHtml(htmlToMarkdown(html))`. Always one wire request: no second
 * dispatch, no cache or TTL dependence, no extra 429/cooldown exposure, no read-twice race. Only
 * `impact: 'content'` findings count (presentation-only changes are not loss); the constructs the
 * dialect models (callouts, accordions, task lists, Mermaid) round-trip clean. A caller's own
 * `opts.format: 'html'` is honoured untouched. A conversion failure (empty output, over the size
 * cap) throws the same error the SDK's conversion threw.
 */
import { diffArticleRoundTrip } from 'node-hudu';
import { htmlToMarkdown, markdownToHtml } from 'node-hudu/content';

/** The reads whose article body is converted, and where `content` sits in the SDK result. */
const CONTENT_PATHS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  'articles.get': [['content']],
  // resolve answers the record itself; the `{ value }` envelope is the helper form of the same read.
  'articles.resolve': [['content'], ['value', 'content']],
  'articles.getContext': [['article', 'content']],
};

export const MARKDOWN_READ_OPERATIONS: ReadonlySet<string> = new Set(Object.keys(CONTENT_PATHS));

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Whether the caller asked for HTML itself (then the read is returned as is, with no flag). */
export const callerWantsHtml = (input: unknown): boolean => isObject(input) && isObject(input.opts) && input.opts.format === 'html';

/** `input` with `opts.format` forced to 'html', merged over the caller's own opts. */
export function forceHtml(input: Record<string, unknown>): Record<string, unknown> {
  return { ...input, opts: { ...(isObject(input.opts) ? input.opts : {}), format: 'html' } };
}

const convert = (node: unknown, path: readonly string[], codes: Set<string>): unknown => {
  if (!isObject(node)) return node;
  const [key, ...rest] = path;
  const value = node[key!];
  if (rest.length === 0) {
    if (typeof value !== 'string') return node;
    const markdown = htmlToMarkdown(value);
    for (const f of diffArticleRoundTrip(value, markdownToHtml(markdown))) if (f.impact === 'content') codes.add(f.code);
    return { ...node, [key!]: markdown };
  }
  const inner = convert(value, rest, codes);
  return inner === value ? node : { ...node, [key!]: inner };
};

/** The Markdown result for `operation` from its stored-HTML result, plus the content-loss codes (empty when lossless). */
export function projectMarkdown(operation: string, htmlResult: unknown): { result: unknown; codes: string[] } {
  const paths = CONTENT_PATHS[operation];
  if (paths === undefined) return { result: htmlResult, codes: [] };
  const codes = new Set<string>();
  const result = paths.reduce((node, path) => convert(node, path, codes), htmlResult);
  return { result, codes: [...codes].sort() };
}

/** The one short sentence appended to the result text when a read lost content. */
export const lossyNote = (codes: readonly string[]): string =>
  ` markdown_lossy: true (${codes.join(', ')}): the Markdown body is incomplete; fetch the stored HTML with hudu_fetch_many {items:[{resource:"articles", id}]} to see all of it.`;
