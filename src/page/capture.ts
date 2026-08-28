/**
 * Records how a site's pages looked, but only when they changed.
 *
 * That last clause is what makes this a change log rather than a time series.
 * A daily snapshot of a page that nobody edited is 364 identical rows a year
 * and one that matters; writing only on a moved hash inverts that, and the
 * question "when did this change" becomes a read instead of a diff.
 *
 * It also buys idempotence, which is not optional here: Vercel documents cron
 * delivery as best effort — a run can be missed AND the same run can be
 * delivered twice — and it never retries a failure. A duplicate run has to be a
 * no-op. This one is.
 */
import { getCacheStore } from '../core/cache/index.js';
import { getHistoryStore } from '../core/history/index.js';
import type { HistoryStore } from '../core/history/types.js';
import { getSite, loadSites } from '../config/sites.js';
import { fetchSearchRows } from '../tools/seo-opportunities.js';
import { allowedHostsForSite } from './allowlist.js';
import { fetchPageSnapshot } from './fetch.js';
import type { PageFacts } from './types.js';

const DEFAULT_PAGES = 50;
const DEFAULT_LOOKBACK_DAYS = 28;
/** Being gentle with an origin that is yours does not stop it being an origin. */
const DELAY_BETWEEN_PAGES_MS = 200;
const LOCK_TTL_SEC = 600;

export function historyKey(siteId: string, url: string): string {
  return `page:${siteId}:${url}`;
}

export interface CaptureFailure {
  page: string;
  reason: string;
}

export interface CaptureSummary {
  site: string;
  pagesConsidered: number;
  changed: number;
  unchanged: number;
  failures: CaptureFailure[];
  /** Set when nothing ran, with the reason a human can act on. */
  skipped?: string;
}

export interface CaptureOptions {
  pages?: number;
  lookbackDays?: number;
  now?: () => Date;
  delayMs?: number;
  history?: HistoryStore | null;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function captureSite(
  siteId: string,
  opts: CaptureOptions = {},
): Promise<CaptureSummary> {
  const history = opts.history !== undefined ? opts.history : getHistoryStore();
  const empty: CaptureSummary = {
    site: siteId,
    pagesConsidered: 0,
    changed: 0,
    unchanged: 0,
    failures: [],
  };
  if (!history) {
    return { ...empty, skipped: 'No history store is configured, so nothing can be recorded.' };
  }

  const site = getSite(loadSites(), siteId);
  const binding = site.sources.gsc;
  if (!binding) {
    return {
      ...empty,
      skipped: `Site '${siteId}' has no Search Console binding, so there is no list of pages worth capturing.`,
    };
  }

  const now = opts.now ?? (() => new Date());
  const end = now();
  const start = new Date(end.getTime() - (opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS) * 86_400_000);
  const rows = await fetchSearchRows(siteId, binding, { start: isoDay(start), end: isoDay(end) });

  const pages = [...rows]
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, opts.pages ?? DEFAULT_PAGES);

  const hosts = allowedHostsForSite(site);
  const summary: CaptureSummary = { ...empty, pagesConsidered: pages.length };
  const delayMs = opts.delayMs ?? DELAY_BETWEEN_PAGES_MS;

  for (const [index, row] of pages.entries()) {
    if (index > 0 && delayMs > 0) await sleep(delayMs);
    try {
      const facts = await fetchPageSnapshot(row.page, hosts, { now });
      const key = historyKey(siteId, row.page);
      const at = new Date(facts.fetchedAt).getTime();
      const previous = await history.latestBefore(key, at);
      if (previous && (JSON.parse(previous.value) as PageFacts).contentHash === facts.contentHash) {
        summary.unchanged += 1;
        continue;
      }
      await history.append(key, at, JSON.stringify(facts));
      summary.changed += 1;
    } catch (err) {
      // One dead URL must not abort the run, the same way
      // SalesforceATFX_mcp's cache-prewarm refuses to fail a boot.
      summary.failures.push({
        page: row.page,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

/**
 * Claims the right to run. Vercel warns that a slow cron can overlap with its
 * own next invocation; the lock expires so a crashed run cannot block the next
 * one forever.
 */
export async function acquireCaptureLock(token: string): Promise<boolean> {
  return getCacheStore().setIfAbsent('lock:capture', token, LOCK_TTL_SEC);
}

export async function captureAllSites(opts: CaptureOptions = {}): Promise<CaptureSummary[]> {
  const results: CaptureSummary[] = [];
  for (const site of loadSites()) {
    try {
      results.push(await captureSite(site.id, opts));
    } catch (err) {
      results.push({
        site: site.id,
        pagesConsidered: 0,
        changed: 0,
        unchanged: 0,
        failures: [],
        skipped: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
