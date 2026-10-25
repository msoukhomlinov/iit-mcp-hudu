/**
 * article-loss.ts — the signal that a Markdown article read is incomplete.
 *
 * Since node-hudu 0.17 a Markdown read reports its own loss: the SDK attaches `content_loss` (the
 * `ROUNDTRIP_*` findings with `impact: 'content'`) to the article record when the stored body does
 * not survive HTML -> Markdown -> HTML, and returns an empty body plus `ROUNDTRIP_BODY_EMPTY`
 * instead of throwing when nothing converts. This lifts those codes out of the result into the
 * tool's `markdown_lossy` fields and drops the per-record findings, so the result shape is the
 * same as before. A caller's own `opts.format: 'html'` gets no `content_loss`, hence no flag.
 */

/** The reads whose article body is converted, and where the article record sits in the SDK result. */
const RECORD_PATHS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  'articles.get': [[]],
  // resolve answers the record itself; the `{ value }` envelope is the helper form of the same read.
  'articles.resolve': [[], ['value']],
  'articles.getContext': [['article']],
  // The SDK reports getSection loss for the WHOLE body (the loss may sit in another section).
  'articles.getSection': [[]],
};

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const take = (node: unknown, path: readonly string[], codes: Set<string>): unknown => {
  if (!isObject(node)) return node;
  const [key, ...rest] = path;
  if (key === undefined) {
    if (!Array.isArray(node.content_loss)) return node;
    for (const f of node.content_loss as { code?: unknown }[]) if (typeof f?.code === 'string') codes.add(f.code);
    const record = { ...node };
    delete record.content_loss;
    return record;
  }
  const inner = take(node[key], rest, codes);
  return inner === node[key] ? node : { ...node, [key]: inner };
};

/** `result` without the SDK's `content_loss`, plus its codes (empty when the read lost nothing). */
export function takeContentLoss(operation: string, result: unknown): { result: unknown; codes: string[] } {
  const paths = RECORD_PATHS[operation];
  if (paths === undefined) return { result, codes: [] };
  const codes = new Set<string>();
  const stripped = paths.reduce((node, path) => take(node, path, codes), result);
  return { result: stripped, codes: [...codes].sort() };
}

/**
 * The recovery hint every discovery surface for an article body read must carry: where the stored
 * HTML is. It rides the RESULT text of a lossy read ({@link lossyNote}) and the
 * `hudu_describe_operation` text of the article reads, so a caller that never triggered a loss can
 * still learn the recovery before it needs it.
 */
export const FETCH_MANY_RECOVERY_HINT =
  'A markdown_lossy read is incomplete: fetch the stored HTML with hudu_fetch_many {items:[{resource:"articles", id}]} to see all of it.';

/** The operations whose article body is converted from stored HTML to Markdown. */
export const ARTICLE_BODY_READS: ReadonlySet<string> = new Set(Object.keys(RECORD_PATHS));

/** The one short sentence appended to the result text when a read lost content. */
export const lossyNote = (codes: readonly string[], operation?: string): string =>
  ` markdown_lossy: true (${codes.join(', ')}): ${operation === 'articles.getSection' ? 'the Markdown read of this article is incomplete (the loss may be in another section)' : 'the Markdown body is incomplete'}; fetch the stored HTML with hudu_fetch_many {items:[{resource:"articles", id}]} to see all of it.`;
