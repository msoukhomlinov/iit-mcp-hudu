/**
 * article-loss.ts — tells the agent when a Markdown article read is incomplete.
 *
 * Reads return article bodies as Markdown (node-hudu 0.14 dialect); anything Markdown cannot
 * express (an inline <svg>, say) comes back as plain text with no signal from the SDK, which keeps
 * loss reporting out of the converter on purpose and documents `diffArticleRoundTrip` as the one
 * vocabulary. This runs that pattern: the stored HTML versus the HTML the Markdown would write
 * back. Only `impact: 'content'` findings count (presentation-only changes are not loss), and the
 * Hudu constructs the dialect models (callouts, accordions, task lists, Mermaid) round-trip clean.
 */
import { diffArticleRoundTrip } from 'node-hudu';
import { markdownToHtml } from 'node-hudu/content';

/** Reads whose article bodies are converted to Markdown by `contentFormat: 'markdown'`. */
export const MARKDOWN_READ_OPERATIONS: ReadonlySet<string> = new Set(['articles.get', 'articles.getContext', 'articles.resolve']);

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

/** Content-loss finding codes between a Markdown-format result and the same read's stored-HTML result. */
export function markdownLossCodes(markdown: unknown, html: unknown): string[] {
  const codes = new Set<string>();
  const walk = (md: unknown, stored: unknown): void => {
    if (Array.isArray(stored) && Array.isArray(md)) {
      stored.forEach((item, i) => walk(md[i], item));
    } else if (isObject(stored) && isObject(md)) {
      for (const [key, value] of Object.entries(stored)) {
        const counterpart = md[key];
        if (key === 'content' && typeof value === 'string' && typeof counterpart === 'string') {
          for (const f of diffArticleRoundTrip(value, markdownToHtml(counterpart))) if (f.impact === 'content') codes.add(f.code);
        } else {
          walk(counterpart, value);
        }
      }
    }
  };
  walk(markdown, html);
  return [...codes].sort();
}

/**
 * Loss codes for one read: fetch the stored-HTML twin and diff. The twin is a second dispatch of
 * the same read (the SDK client cache serves it without another request); if it fails the signal is
 * simply absent, never an error on a read that itself succeeded.
 */
export async function markdownLossFor(fetchHtml: () => Promise<unknown>, markdown: unknown): Promise<string[]> {
  try {
    return markdownLossCodes(markdown, await fetchHtml());
  } catch {
    return [];
  }
}

/** The one short sentence appended to the result text when a read lost content. */
export const lossyNote = (codes: readonly string[]): string =>
  ` markdown_lossy: true (${codes.join(', ')}): the Markdown body is incomplete; fetch the stored HTML with hudu_fetch_many {resource:"articles", id} to see all of it.`;
