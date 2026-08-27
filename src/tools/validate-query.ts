/**
 * validate_query — dry-run a query and report what will not work.
 *
 * Advisory only: it never blocks query(). It exists so a caller learns about
 * a silently truncated range or an unsupported metric before reading numbers
 * that quietly leave data out.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getSite, loadSites } from '../config/sites.js';
import { jsonResult, runTool } from '../core/tool-result.js';
import {
  SOURCE_ROW_CAPS,
  isCanonicalMetric,
  sourceSupports,
  sourcesFor,
} from '../semantics/knowledge.js';
import { allSources } from '../sources/registry.js';
import { SOURCE_IDS, type SourceId } from '../sources/types.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be yyyy-mm-dd');

export const validateQuerySchema = z.object({
  site: z.string().min(1),
  range: z.object({ start: isoDate, end: isoDate }).strict(),
  granularity: z.enum(['day', 'week', 'month', 'total']),
  metrics: z.array(z.string().min(1)).min(1),
  dimensions: z.array(z.string().min(1)).optional(),
  sources: z.array(z.enum(SOURCE_IDS)).optional(),
});

type Args = z.infer<typeof validateQuerySchema>;
type Level = 'error' | 'warning' | 'info';

interface Issue {
  level: Level;
  code: string;
  message: string;
}

function daysBetween(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.floor((b - a) / 86_400_000) + 1;
}

export async function handleValidateQuery(args: Args): Promise<CallToolResult> {
  return runTool(async () => {
    const env = process.env;
    const issues: Issue[] = [];

    const site = getSite(loadSites(env), args.site);
    const requested = args.sources ?? [...SOURCE_IDS];
    const targets = allSources()
      .filter(
        (source) =>
          requested.includes(source.id) &&
          source.isConfigured(env) &&
          site.sources[source.id] !== undefined,
      )
      .map((source) => source.id);

    if (targets.length === 0) {
      issues.push({
        level: 'error',
        code: 'no-sources',
        message: `No source is both configured and bound to '${args.site}'. The query would return nothing.`,
      });
    }

    const span = daysBetween(args.range.start, args.range.end);
    if (!Number.isFinite(span) || span <= 0) {
      issues.push({
        level: 'error',
        code: 'bad-range',
        message: 'The end date must not fall before the start date.',
      });
    }

    for (const metric of args.metrics) {
      if (!isCanonicalMetric(metric)) {
        issues.push({
          level: 'error',
          code: 'unknown-metric',
          message: `'${metric}' is not a metric this server knows. Call get_schema to see the list.`,
        });
        continue;
      }
      const covering = targets.filter((id) => sourceSupports(metric, id));
      if (covering.length === 0) {
        const elsewhere = sourcesFor(metric);
        issues.push({
          level: 'error',
          code: 'metric-unavailable',
          message: `No source bound to this site reports '${metric}'. It comes from: ${elsewhere.join(', ') || 'no source'}.`,
        });
      } else if (covering.length < targets.length) {
        const silent = targets.filter((id) => !sourceSupports(metric, id));
        issues.push({
          level: 'info',
          code: 'partial-coverage',
          message: `'${metric}' will come from ${covering.join(', ')} only — ${silent.join(', ')} does not report it.`,
        });
      }
    }

    if (args.granularity === 'day' && Number.isFinite(span)) {
      for (const id of targets) {
        const cap = SOURCE_ROW_CAPS[id as SourceId];
        if (cap.cap > 0 && span > cap.cap) {
          issues.push({
            level: 'warning',
            code: 'range-truncated',
            message: `${span} days requested day by day, but ${cap.note} Results from ${id} will be incomplete.`,
          });
        }
      }
    }

    if (
      targets.includes('cloudflare') &&
      args.metrics.includes('sessions') &&
      args.metrics.includes('visitors')
    ) {
      issues.push({
        level: 'warning',
        code: 'cloudflare-shared-metric',
        message:
          'Cloudflare reports one number for both visits and people, so its sessions and visitors will be identical. Comparing them tells you nothing.',
      });
    }

    if (targets.includes('vercel') && (args.dimensions?.length ?? 0) > 1) {
      issues.push({
        level: 'warning',
        code: 'vercel-single-dimension',
        message: `Vercel applies only the first breakdown ('${args.dimensions?.[0]}'); the rest are ignored for that source.`,
      });
    }

    const hasSearchMetric = args.metrics.some((m) =>
      ['clicks', 'impressions', 'ctr', 'position'].includes(m),
    );
    const hasSiteMetric = args.metrics.some((m) =>
      ['pageviews', 'sessions', 'visitors'].includes(m),
    );
    if (hasSearchMetric && hasSiteMetric) {
      issues.push({
        level: 'info',
        code: 'mixed-universes',
        message:
          'This mixes Google Search numbers with on-site numbers. They measure different things and should not be added together or compared directly.',
      });
    }

    return jsonResult({
      valid: !issues.some((issue) => issue.level === 'error'),
      targets,
      issues,
      note: 'Advisory only — query() runs regardless of what this reports.',
    });
  });
}
