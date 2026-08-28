/**
 * Turns HTML into the handful of facts that decide whether a search result is
 * worth clicking. Pure, and deliberately parser-free: SPEC §1 freezes the
 * dependency list, so this is a tolerant scanner over the <head> region rather
 * than a DOM library.
 *
 * The rule that keeps it honest: anything this scanner cannot read with
 * confidence stays undefined. A wrong title is worse than no title, because a
 * wrong one produces a confident verdict about a page that is fine.
 */
import { createHash } from 'node:crypto';
import type { PageFacts } from './types.js';

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
};

/** Unknown entities are left alone: decoding a guess would corrupt the text. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENTITIES[m] ?? m);
}

function clean(text: string): string {
  return decodeEntities(text.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tag)) !== null) {
    out[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return out;
}

function metaContent(head: string, key: 'name' | 'property', value: string): string | undefined {
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    if (attrs[key]?.toLowerCase() === value && typeof attrs.content === 'string') {
      const content = attrs.content.trim();
      if (content) return content;
    }
  }
  return undefined;
}

export interface TransportFacts {
  url: string;
  status: number;
  fetchedAt: string;
  redirectTo?: string;
  bodyTruncated?: boolean;
}

export function extractPageFacts(html: string, transport: TransportFacts): PageFacts {
  const headEnd = html.search(/<\/head\s*>/i);
  const headTruncated = headEnd === -1;
  const head = headTruncated ? html : html.slice(0, headEnd);

  const titleMatch = head.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = titleMatch ? clean(titleMatch[1]) || undefined : undefined;

  const metaDescription = metaContent(head, 'name', 'description');
  const robotsMeta = metaContent(head, 'name', 'robots');
  const ogTitle = metaContent(head, 'property', 'og:title');
  const ogDescription = metaContent(head, 'property', 'og:description');

  let canonical: string | undefined;
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    if (attrs.rel?.toLowerCase().split(/\s+/).includes('canonical') && attrs.href?.trim()) {
      canonical = attrs.href.trim();
      break;
    }
  }

  const h1s = (html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi) ?? [])
    .map((tag) => clean(tag.replace(/^<h1\b[^>]*>/i, '').replace(/<\/h1\s*>$/i, '')))
    .filter((text) => text.length > 0);

  const facts: Omit<PageFacts, 'contentHash'> = {
    url: transport.url,
    fetchedAt: transport.fetchedAt,
    status: transport.status,
    ...(transport.redirectTo ? { redirectTo: transport.redirectTo } : {}),
    ...(title ? { title, titleLength: title.length } : {}),
    ...(metaDescription ? { metaDescription, metaDescriptionLength: metaDescription.length } : {}),
    ...(canonical ? { canonical } : {}),
    h1s,
    ...(robotsMeta ? { robotsMeta } : {}),
    ...(ogTitle ? { ogTitle } : {}),
    ...(ogDescription ? { ogDescription } : {}),
    headTruncated,
    bodyTruncated: transport.bodyTruncated ?? false,
  };

  return { ...facts, contentHash: hashFacts(facts) };
}

/**
 * Hashes what the page SAYS, never the bytes it shipped. Raw HTML moves on
 * every deploy — build ids, nonces, cache busters — so hashing it would record
 * a "change" daily and bury the two or three that matter.
 *
 * url and fetchedAt are excluded (one is the key, the other always differs);
 * status and redirectTo are included, because a ranking page that starts
 * returning 404 is exactly the change worth waking up for.
 */
export function hashFacts(facts: Omit<PageFacts, 'contentHash'>): string {
  const normalized = [
    facts.status,
    facts.redirectTo ?? null,
    facts.title ?? null,
    facts.metaDescription ?? null,
    facts.canonical ?? null,
    facts.h1s,
    facts.robotsMeta ?? null,
    facts.ogTitle ?? null,
    facts.ogDescription ?? null,
  ];
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
