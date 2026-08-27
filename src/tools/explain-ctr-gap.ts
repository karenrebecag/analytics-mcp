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
import { buildCtrCurve, expectedCtr } from '../seo/ctr-curve.js';
import { fetchSearchRows } from './seo-opportunities.js';

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
      suggestion: underperforming
        ? 'Rewrite the title and description to match what someone searching that topic wants. The ranking is fine; the invitation is not.'
        : 'To grow this page, aim at the ranking rather than the wording.',
    });
  });
}
