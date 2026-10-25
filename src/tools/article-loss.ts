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

/** The one short sentence appended to the result text when a read lost content. */
export const lossyNote = (codes: readonly string[]): string =>
  ` markdown_lossy: true (${codes.join(', ')}): the Markdown body is incomplete; fetch the stored HTML with hudu_fetch_many {items:[{resource:"articles", id}]} to see all of it.`;
