/**
 * explain_discrepancy — is the gap between two trackers normal?
 *
 * Deterministic and pure: it compares the observed gap against codified
 * criterion and reports. It never guesses. When no criterion exists for a
 * pair it says so, rather than inventing a range.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getSite, loadSites } from '../config/sites.js';
import { jsonResult, runTool } from '../core/tool-result.js';
import {
  comparabilityBlocker,
  expectationFor,
  metricSemantics,
  type CloudflareMode,
} from '../semantics/knowledge.js';
import { SOURCE_IDS, type SiteExpectation } from '../sources/types.js';

export const explainDiscrepancySchema = z.object({
  metric: z.string().min(1).describe('Canonical metric, e.g. pageviews.'),
  sourceA: z.enum(SOURCE_IDS),
  sourceB: z.enum(SOURCE_IDS),
  valueA: z.number(),
  valueB: z.number(),
  site: z.string().min(1).optional().describe('Applies this site expectations when configured.'),
});

type Args = z.infer<typeof explainDiscrepancySchema>;

/** Cloudflare answers from a different dataset when an account id is present. */
export function cloudflareMode(env: Record<string, string | undefined>): CloudflareMode {
  return env.CLOUDFLARE_ACCOUNT_ID?.trim() ? 'rum' : 'edge';
}

function siteOverride(
  expectations: SiteExpectation[] | undefined,
  args: Args,
): SiteExpectation | undefined {
  return expectations?.find(
    (e) =>
      e.metric === args.metric &&
      ((e.sourceA === args.sourceA && e.sourceB === args.sourceB) ||
        (e.sourceA === args.sourceB && e.sourceB === args.sourceA)),
  );
}

export async function handleExplainDiscrepancy(args: Args): Promise<CallToolResult> {
  return runTool(async () => {
    const env = process.env;
    const semantics = metricSemantics(args.metric);
    const blocker = comparabilityBlocker(args.metric, args.sourceA, args.sourceB);

    const denominator = Math.max(Math.abs(args.valueA), Math.abs(args.valueB));
    const actualRatio = denominator === 0 ? 0 : Math.abs(args.valueA - args.valueB) / denominator;

    const base = {
      metric: args.metric,
      businessMeaning: semantics?.businessMeaning,
      values: { [args.sourceA]: args.valueA, [args.sourceB]: args.valueB },
      actualGapPct: Math.round(actualRatio * 100),
    };

    if (blocker) {
      return jsonResult({
        ...base,
        isNormal: null,
        reason: blocker,
        suggestion: 'Compare the same metric across two sources that both report it.',
      });
    }

    const override = args.site
      ? siteOverride(getSite(loadSites(env), args.site).expectations, args)
      : undefined;
    const generic = expectationFor(args.metric, args.sourceA, args.sourceB, cloudflareMode(env));
    const expected = override
      ? {
          maxGapPct: Math.round(override.maxRatio * 100),
          reason: override.reason ?? 'Expectation configured for this site.',
          basis: 'site-configured' as const,
        }
      : generic
        ? {
            maxGapPct: Math.round(generic.maxRatio * 100),
            reason: generic.reason,
            basis: 'generic-mechanism' as const,
          }
        : undefined;

    if (!expected) {
      return jsonResult({
        ...base,
        isNormal: null,
        expected: null,
        reason: `No criterion is recorded for ${args.metric} between ${args.sourceA} and ${args.sourceB}.`,
        suggestion:
          'Treat the gap as unexplained rather than normal. Record a site expectation once you know what normal looks like here.',
      });
    }

    const isNormal = base.actualGapPct <= expected.maxGapPct;
    const higher =
      args.valueA === args.valueB ? null : args.valueA > args.valueB ? args.sourceA : args.sourceB;

    return jsonResult({
      ...base,
      isNormal,
      expected,
      higherSource: higher,
      reason: isNormal
        ? `A gap of up to ${expected.maxGapPct}% is expected here. ${expected.reason}`
        : `The gap is wider than the ${expected.maxGapPct}% these two normally differ by. ${expected.reason}`,
      suggestion: isNormal
        ? 'Nothing to fix. Pick one source as the number you report and stay with it.'
        : 'Check whether tracking is missing from some pages, whether a filter changed, or whether one source stopped receiving data partway through the period.',
    });
  });
}
