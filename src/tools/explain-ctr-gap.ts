/**
 * explain_ctr_gap — is one page underperforming its position?
 *
 * Deterministic, like explain_discrepancy: it compares against what this site
 * earns at that position and says plainly when its own data is too thin to
 * judge, rather than importing a benchmark.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getSite, loadSites } from '../config/sites.js';
import { jsonResult, runTool } from '../core/tool-result.js';
import { getHistoryStore } from '../core/history/index.js';
import { allowedHostsForSite } from '../page/allowlist.js';
import { historyKey } from '../page/capture.js';
import { fetchPageSnapshot } from '../page/fetch.js';
import type { PageFacts, PageVerdict } from '../page/types.js';
import { pageVerdicts } from '../page/verdicts.js';
import { buildCtrCurve, expectedCtr } from '../seo/ctr-curve.js';
import type { Site } from '../sources/types.js';
import { fetchSearchRows } from './seo-opportunities.js';

interface PageContext {
  facts: PageFacts;
  verdicts: PageVerdict[];
}

/**
 * The page is evidence, not a dependency. An unreachable page degrades this
 * tool to what it did before F8 — a verdict from search data alone — rather
 * than failing a call the caller asked about search performance.
 */
async function readPageQuietly(
  site: Site,
  url: string,
): Promise<{ page?: PageContext; pageNote?: string }> {
  try {
    const facts = await fetchPageSnapshot(url, allowedHostsForSite(site));
    return { page: { facts, verdicts: pageVerdicts(facts) } };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      pageNote: `The page could not be read, so this verdict uses search data alone: ${reason}`,
    };
  }
}

/**
 * When the page was last edited, if F9 has been recording. The first entry is
 * the baseline — the day capture started — so a key holding only that has not
 * seen a change and says nothing.
 */
async function lastChangedAt(siteId: string, url: string): Promise<string | undefined> {
  const history = getHistoryStore();
  if (!history) return undefined;
  try {
    const entries = await history.range(historyKey(siteId, url), 0, Date.now());
    if (entries.length < 2) return undefined;
    return (JSON.parse(entries[entries.length - 1].value) as PageFacts).fetchedAt;
  } catch {
    // History is evidence, never a dependency.
    return undefined;
  }
}

/** Rules that change what a searcher sees before they click. */
const INVITATION_RULES = new Set([
  'title-missing',
  'title-long',
  'title-short',
  'description-missing',
  'description-long',
  'redirect',
  'status',
  'noindex',
]);

function suggestionFor(underperforming: boolean, page?: PageContext): string {
  if (!underperforming) return 'To grow this page, aim at the ranking rather than the wording.';
  const named = page?.verdicts.filter((verdict) => INVITATION_RULES.has(verdict.rule)) ?? [];
  if (named.length > 0) {
    return `The ranking is fine; the invitation is not. ${named.map((v) => v.finding).join(' ')}`;
  }
  return 'Rewrite the title and description to match what someone searching that topic wants. The ranking is fine; the invitation is not.';
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be yyyy-mm-dd');

export const explainCtrGapSchema = z.object({
  site: z.string().min(1),
  range: z.object({ start: isoDate, end: isoDate }).strict(),
  page: z.string().min(1).describe('Full URL or a distinctive part of the path.'),
});

export async function handleExplainCtrGap(
  args: z.infer<typeof explainCtrGapSchema>,
): Promise<CallToolResult> {
  return runTool(async () => {
    const site = getSite(loadSites(), args.site);
    const binding = site.sources.gsc;
    if (!binding) throw new Error(`Site '${args.site}' has no Search Console binding.`);

    const rows = await fetchSearchRows(args.site, binding, args.range);
    const needle = args.page.toLowerCase();
    const matches = rows.filter((row) => row.page.toLowerCase().includes(needle));
    if (matches.length === 0) {
      return jsonResult({
        page: args.page,
        verdict: null,
        reason: 'No search data for that page in this period. It may not rank at all yet.',
      });
    }
    const row = matches.sort((a, b) => b.impressions - a.impressions)[0];
    const actualCtr = row.impressions > 0 ? row.clicks / row.impressions : 0;
    const expectation = expectedCtr(buildCtrCurve(rows), row.position);

    const base = {
      page: row.page,
      position: row.position,
      impressions: row.impressions,
      clicks: row.clicks,
      actualCtrPct: Number((actualCtr * 100).toFixed(2)),
      positionNote: 'Lower positions are better: 1 is the top of the page.',
    };

    if (!expectation) {
      return jsonResult({
        ...base,
        verdict: null,
        reason:
          'This site does not yet have enough results around that position to say what normal looks like there. Rather than borrow an industry average that may not apply, no verdict is given.',
        suggestion: 'Come back once more pages rank near this position.',
      });
    }

    const missedClicks = Math.round(row.impressions * (expectation.ctr - actualCtr));
    const underperforming = actualCtr < expectation.ctr && missedClicks > 0;
    const { page, pageNote } = await readPageQuietly(site, row.page);
    const changedAt = await lastChangedAt(args.site, row.page);
    return jsonResult({
      ...base,
      expectedCtrPct: Number((expectation.ctr * 100).toFixed(2)),
      expectationBasis: {
        impressions: expectation.impressions,
        widened: expectation.widened,
        note: "Measured from this site's own pages at the same position.",
      },
      verdict: underperforming ? 'underperforming' : 'in line',
      missedClicks: underperforming ? missedClicks : 0,
      reason: underperforming
        ? `People see this page as often as others at the same position, but click it far less — about ${missedClicks} clicks fewer than this site normally earns there.`
        : 'It earns what this site normally earns at that position, so the click-through is not the problem.',
      ...(page ? { page } : {}),
      ...(pageNote ? { pageNote } : {}),
      ...(changedAt
        ? {
            lastChangedAt: changedAt,
            lastChangedNote:
              'This page was last recorded changing on that date. Use page_changes for what moved and what the search numbers did either side.',
          }
        : {}),
      suggestion: suggestionFor(underperforming, page),
    });
  });
}
