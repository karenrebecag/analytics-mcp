/**
 * seo_opportunities — where the cheapest wins are, measured in missed clicks.
 *
 * Reads Search Console page rows through the existing adapter: no raw calls,
 * no new credentials, no third-party keyword source.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getSite, loadSites } from '../config/sites.js';
import { jsonResult, runTool } from '../core/tool-result.js';
import { buildCtrCurve, curvePoints, type SearchRow } from '../seo/ctr-curve.js';
import { ctrGaps, decayed, strikingDistance } from '../seo/opportunities.js';
import { getSource } from '../sources/registry.js';
import type { BindingFor, DateRange } from '../sources/types.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be yyyy-mm-dd');
const rangeSchema = z.object({ start: isoDate, end: isoDate }).strict();

export const seoOpportunitiesSchema = z.object({
  site: z.string().min(1),
  range: rangeSchema,
  previousRange: rangeSchema
    .optional()
    .describe('Enables the decay list. Without it, decay is reported as unavailable.'),
  limit: z.number().int().positive().max(50).optional(),
  kinds: z
    .array(z.enum(['ctr-gap', 'striking-distance', 'decay']))
    .optional()
    .describe('Defaults to all.'),
});

type Args = z.infer<typeof seoOpportunitiesSchema>;

/** Search Console page rows for one period, via the adapter. */
export async function fetchSearchRows(
  siteId: string,
  binding: BindingFor<'gsc'>,
  range: DateRange,
): Promise<SearchRow[]> {
  const result = await getSource('gsc').query(
    {
      siteId,
      range,
      granularity: 'total',
      metrics: ['clicks', 'impressions', 'position'],
      dimensions: ['page'],
    },
    binding,
  );
  return result.rows
    .map((row) => ({
      page: String(row.page ?? ''),
      clicks: Number(row.clicks ?? 0),
      impressions: Number(row.impressions ?? 0),
      position: Number(row.position ?? 0),
    }))
    .filter((row) => row.page !== '');
}

export async function handleSeoOpportunities(args: Args): Promise<CallToolResult> {
  return runTool(async () => {
    const site = getSite(loadSites(), args.site);
    const binding = site.sources.gsc;
    if (!binding) {
      throw new Error(
        `Site '${args.site}' has no Search Console binding — SEO opportunities need it.`,
      );
    }

    const rows = await fetchSearchRows(args.site, binding, args.range);
    const curve = buildCtrCurve(rows);
    const limit = args.limit ?? 10;
    const kinds = args.kinds ?? ['ctr-gap', 'striking-distance', 'decay'];
    const out: Record<string, unknown> = {
      site: args.site,
      range: args.range,
      pagesAnalysed: rows.length,
      ctrCurve: {
        note: "Measured from this site's own results, not an industry benchmark.",
        points: curvePoints(curve).map((p) => ({
          position: p.position,
          ctr: Number(p.ctr.toFixed(4)),
          impressions: p.impressions,
        })),
      },
    };

    if (kinds.includes('ctr-gap')) {
      const gaps = ctrGaps(rows, curve);
      out.ctrGap = {
        meaning:
          'These pages already rank. People see them and do not click, so the fix is the title and description, not the ranking.',
        found: gaps.length,
        items: gaps.slice(0, limit),
      };
    }

    if (kinds.includes('striking-distance')) {
      const striking = strikingDistance(rows);
      out.strikingDistance = {
        meaning:
          'These sit just outside the places that get clicked. Improving them is usually cheaper than writing new pages, because the audience is already seeing them.',
        found: striking.length,
        items: striking.slice(0, limit),
      };
    }

    if (kinds.includes('decay')) {
      if (!args.previousRange) {
        out.decay = {
          available: false,
          reason:
            'Pass previousRange to compare two periods. Without it there is nothing to compare against, and a trend would be guesswork.',
        };
      } else {
        const previous = await fetchSearchRows(args.site, binding, args.previousRange);
        const losses = decayed(rows, previous);
        out.decay = {
          available: true,
          comparedWith: args.previousRange,
          meaning: 'Pages that lost ground between the two periods.',
          found: losses.length,
          items: losses.slice(0, limit),
        };
      }
    }

    return jsonResult(out);
  });
}
