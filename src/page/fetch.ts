/**
 * Retrieves one page the operator has configured, and nothing else.
 *
 * Two decisions carry the weight here. Redirects are reported and never
 * followed, which removes the redirect-to-an-internal-host class of attack
 * outright and, as a side effect, turns a 301 on a ranking page into a finding
 * the report should have been carrying all along. And a non-2xx is returned as
 * a fact rather than thrown: "your ranking page returns 404" is the single most
 * valuable thing this tool can say.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import {
  assertFetchable,
  assertPublicAddress,
  type AllowedHosts,
  type HostLookup,
} from './allowlist.js';
import { extractPageFacts } from './extract.js';
import type { PageFacts } from './types.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 512 * 1024;
const USER_AGENT = 'analytics-mcp (+https://github.com/karenrebecag/analytics-mcp)';

export interface PageResponse {
  status: number;
  headers: { get(name: string): string | null };
  body?: AsyncIterable<Uint8Array> | null;
  text?: () => Promise<string>;
}

export type PageFetch = (
  url: string,
  init: {
    method: string;
    redirect: 'manual';
    headers: Record<string, string>;
    signal: AbortSignal;
  },
) => Promise<PageResponse>;

/**
 * Test seam, mirroring setCacheStoreForTests: the gates run against dist/ as a
 * real process, where passing opts through a tool call is not possible.
 */
let injectedFetch: PageFetch | null = null;
let injectedLookup: HostLookup | null = null;

export function setPageFetchForTests(impl: PageFetch | null): void {
  injectedFetch = impl;
}

export function setHostLookupForTests(impl: HostLookup | null): void {
  injectedLookup = impl;
}

const defaultLookup: HostLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export interface FetchPageOptions {
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: PageFetch;
  lookupImpl?: HostLookup;
  now?: () => Date;
}

/**
 * Reads to the byte cap. An earlier version stopped at </head> to save
 * bandwidth, which was wrong: the h1 lives in the body, so every page came back
 * with none and the h1 rules accused pages that were fine. Stopping early is
 * only safe when nothing downstream reads past the stop, and that is not a
 * property the reader can know.
 */
async function readCapped(
  res: PageResponse,
  maxBytes: number,
): Promise<{ html: string; truncated: boolean }> {
  if (!res.body) {
    const text = res.text ? await res.text() : '';
    return { html: text.slice(0, maxBytes), truncated: text.length > maxBytes };
  }
  const decoder = new TextDecoder();
  let html = '';
  let bytes = 0;
  let truncated = false;
  for await (const chunk of res.body) {
    bytes += chunk.byteLength;
    html += decoder.decode(chunk, { stream: true });
    if (bytes >= maxBytes) {
      truncated = true;
      break;
    }
  }
  return { html: html + decoder.decode(), truncated };
}

export async function fetchPageSnapshot(
  rawUrl: string,
  hosts: AllowedHosts,
  opts: FetchPageOptions = {},
): Promise<PageFacts> {
  // Before any socket is opened.
  const url = assertFetchable(rawUrl, hosts);

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = opts.now ?? (() => new Date());

  // The name is bound to this site; that does not yet mean it points outward.
  await assertPublicAddress(url.hostname, opts.lookupImpl ?? injectedLookup ?? defaultLookup);

  const fetchImpl: PageFetch =
    opts.fetchImpl ??
    injectedFetch ??
    (async (href, init) => {
      const res = await fetch(href, init);
      return {
        status: res.status,
        headers: res.headers,
        body: res.body as AsyncIterable<Uint8Array> | null,
        text: () => res.text(),
      };
    });

  let res: PageResponse;
  try {
    res = await fetchImpl(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'failed';
    throw new Error(`Fetching ${url.hostname} ${reason} after ${timeoutMs}ms.`);
  }

  const isRedirect = res.status >= 300 && res.status < 400;
  const location = isRedirect ? (res.headers.get('location') ?? undefined) : undefined;
  const read = isRedirect ? { html: '', truncated: false } : await readCapped(res, maxBytes);

  return extractPageFacts(read.html, {
    url: url.toString(),
    status: res.status,
    fetchedAt: now().toISOString(),
    bodyTruncated: read.truncated,
    ...(location ? { redirectTo: location } : {}),
  });
}
