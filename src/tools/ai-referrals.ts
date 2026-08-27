/**
 * ai_referrals — how much traffic AI assistants actually send.
 *
 * The honest half of "GEO". Whether an assistant cites you is not something
 * any API reports, and Search Console folds AI Overview appearances into
 * ordinary impressions — so this measures arrivals, and says so every time.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getSite, loadSites } from '../config/sites.js';
import { jsonResult, runTool } from '../core/tool-result.js';
import { AI_REFERRAL_CAVEAT, matchAssistant } from '../seo/ai-sources.js';
import { getSource } from '../sources/registry.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be yyyy-mm-dd');

export const aiReferralsSchema = z.object({
  site: z.string().min(1),
  range: z.object({ start: isoDate, end: isoDate }).strict(),
  granularity: z.enum(['day', 'week', 'month', 'total']).optional(),
});

export async function handleAiReferrals(
  args: z.infer<typeof aiReferralsSchema>,
): Promise<CallToolResult> {
  return runTool(async () => {
    const site = getSite(loadSites(), args.site);
    const binding = site.sources.ga4;
    if (!binding) {
      throw new Error(
        `Site '${args.site}' has no GA4 binding — assistant referrals are read from it.`,
      );
    }

    const result = await getSource('ga4').query(
      {
        siteId: args.site,
        range: args.range,
        granularity: args.granularity ?? 'total',
        metrics: ['sessions'],
        dimensions: ['sessionSource'],
      },
      binding,
    );

    const byEngine = new Map<string, number>();
    let assistantSessions = 0;
    let totalSessions = 0;
    for (const row of result.rows) {
      const sessions = Number(row.sessions ?? 0);
      totalSessions += sessions;
      const engine = matchAssistant(String(row.sessionSource ?? ''));
      if (!engine) continue;
      assistantSessions += sessions;
      byEngine.set(engine, (byEngine.get(engine) ?? 0) + sessions);
    }

    const engines = [...byEngine.entries()]
      .map(([engine, sessions]) => ({ engine, sessions }))
      .sort((a, b) => b.sessions - a.sessions);

    return jsonResult({
      site: args.site,
      range: args.range,
      timezone: result.timezone,
      whatThisMeasures: AI_REFERRAL_CAVEAT,
      assistantSessions,
      totalSessions,
      shareOfAllSessionsPct:
        totalSessions > 0 ? Number(((assistantSessions / totalSessions) * 100).toFixed(2)) : 0,
      engines,
      ...(engines.length === 0
        ? {
            note: 'No assistant referrals in this period. That means little traffic arrived this way — not that assistants ignore you.',
          }
        : {}),
    });
  });
}
