/**
 * Codified criterion: what each number means in business terms, how each
 * tracker arrives at it, and which gaps between trackers are structural
 * rather than problems.
 *
 * Pure data — no I/O, no env reads, no reasoning. The client LLM does the
 * reasoning; this module supplies only the facts it cannot know. Native names
 * and caps are transcribed from the F1 captures and the F2 adapters.
 *
 * Audience: every `businessMeaning` is written for someone with zero
 * analytics background who has to make a decision from the number.
 */
import { CANONICAL_METRICS, type CanonicalMetric } from '../core/normalize.js';
import type { SourceId } from '../sources/types.js';

/**
 * The Cloudflare adapter answers from two different datasets. They have
 * opposite properties, so every comparison involving Cloudflare depends on
 * which one is live (decided at runtime by CLOUDFLARE_ACCOUNT_ID).
 */
export type CloudflareMode = 'rum' | 'edge';

export interface MetricSourceSemantics {
  /** Column the adapter actually requests or returns. */
  native: string;
  /** Precise mechanism, for the model. */
  definition: string;
  /** Plain-language honesty, one idea per entry. */
  caveats: string[];
}

export interface MetricSemantics {
  canonical: CanonicalMetric;
  /** Zero-jargon: what this number tells someone making a decision. */
  businessMeaning: string;
  /** null when neither direction is inherently good. */
  higherIsBetter: boolean | null;
  sources: Partial<Record<SourceId, MetricSourceSemantics>>;
}

const GA4_BEACON =
  'Counted by JavaScript running in the visitor browser, after any cookie banner is accepted.';
const CF_RUM_BEACON =
  'Counted by the Cloudflare Web Analytics beacon, JavaScript running in the visitor browser.';
const CF_EDGE =
  'Counted by Cloudflare at the network edge, before the page loads, from raw HTTP requests.';
const VERCEL_BEACON = 'Counted by the Vercel Web Analytics script running in the visitor browser.';

const BEACON_UNDERCOUNT =
  'Misses people who block scripts or decline cookies, so it undercounts rather than overcounts.';
const EDGE_OVERCOUNT =
  'Includes bots, crawlers and non-page requests, so it usually reports several times more than a browser-based tracker.';
const CF_VISITS_SHARED =
  'Cloudflare reports one number, "visits", for both visits and people — it does not tell them apart, so treat it as an approximation of either.';

export const METRIC_SEMANTICS: Record<CanonicalMetric, MetricSemantics> = {
  pageviews: {
    canonical: 'pageviews',
    businessMeaning:
      'How many times a page on your site was opened. One person who reads three pages counts three times. Use it to see how much your content is being read overall — not how many people came.',
    higherIsBetter: true,
    sources: {
      ga4: {
        native: 'screenPageViews',
        definition: `${GA4_BEACON} Each page or screen view is one event.`,
        caveats: [BEACON_UNDERCOUNT],
      },
      cloudflare: {
        native: 'pageviews (RUM pageload events) / requests (zone HTTP)',
        definition: `In RUM mode: ${CF_RUM_BEACON} In edge mode: ${CF_EDGE}`,
        caveats: [
          'Which mode is live changes the number dramatically — the same site can read one way in RUM mode and several times higher in edge mode.',
          `In edge mode: ${EDGE_OVERCOUNT}`,
          `In RUM mode: ${BEACON_UNDERCOUNT}`,
        ],
      },
      vercel: {
        native: 'pageviews',
        definition: VERCEL_BEACON,
        caveats: [BEACON_UNDERCOUNT, 'Only covers pages served by the Vercel project.'],
      },
    },
  },
  sessions: {
    canonical: 'sessions',
    businessMeaning:
      'How many separate visits happened. One person who browses for ten minutes, leaves, and comes back tomorrow counts as two visits. Use it to see how often people come back.',
    higherIsBetter: true,
    sources: {
      ga4: {
        native: 'sessions',
        definition: `${GA4_BEACON} A visit closes after 30 minutes of inactivity.`,
        caveats: [BEACON_UNDERCOUNT],
      },
      cloudflare: {
        native: 'visits',
        definition: 'Cloudflare counts a visit as a pageload whose referrer is outside your site.',
        caveats: [
          CF_VISITS_SHARED,
          'It is not the same rule as the 30-minute inactivity window other tools use, so the two will not line up exactly.',
        ],
      },
    },
  },
  visitors: {
    canonical: 'visitors',
    businessMeaning:
      'Roughly how many different people came. Someone who visits three times in the period should count once. Use it to size your audience.',
    higherIsBetter: true,
    sources: {
      ga4: {
        native: 'totalUsers',
        definition: `${GA4_BEACON} People are told apart by a cookie in their browser.`,
        caveats: [
          BEACON_UNDERCOUNT,
          'The same person on a phone and a laptop counts twice, and clearing cookies counts again — treat it as an estimate.',
        ],
      },
      cloudflare: {
        native: 'visits / uniques',
        definition:
          'In RUM mode Cloudflare reuses its "visits" number here. In edge mode it reports unique client IPs.',
        caveats: [
          CF_VISITS_SHARED,
          'Because it does not recognise a returning person, this number is structurally higher than a tracker that does.',
        ],
      },
      vercel: {
        native: 'visitors',
        definition: `${VERCEL_BEACON} People are told apart per day.`,
        caveats: [BEACON_UNDERCOUNT],
      },
    },
  },
  clicks: {
    canonical: 'clicks',
    businessMeaning:
      'How many times someone clicked through to your site from a Google search result.',
    higherIsBetter: true,
    sources: {
      gsc: {
        native: 'clicks',
        definition: 'Reported by Google Search, counted at the search result, not on your site.',
        caveats: [
          'This is search traffic only — it says nothing about people who arrived any other way.',
        ],
      },
    },
  },
  impressions: {
    canonical: 'impressions',
    businessMeaning:
      'How many times a link to your site appeared in Google search results, whether or not anyone clicked.',
    higherIsBetter: true,
    sources: {
      gsc: {
        native: 'impressions',
        definition: 'Reported by Google Search when your result was shown.',
        caveats: [
          'An appearance far down page two still counts, so a high number does not mean people saw you.',
        ],
      },
    },
  },
  ctr: {
    canonical: 'ctr',
    businessMeaning:
      'Of the people who saw your site in Google results, the share who clicked. 0.05 means 5 out of every 100.',
    higherIsBetter: true,
    sources: {
      gsc: {
        native: 'ctr',
        definition: 'Clicks divided by impressions, as reported by Google Search.',
        caveats: [
          'It is a rate between 0 and 1, not a count — averaging it across periods or pages gives a misleading result.',
        ],
      },
    },
  },
  position: {
    canonical: 'position',
    businessMeaning:
      'Your average spot in Google results. 1 is the top of the page. This is the one number where a smaller value is better.',
    higherIsBetter: false,
    sources: {
      gsc: {
        native: 'position',
        definition: 'Average ranking of your result across the impressions counted.',
        caveats: [
          'It is an average across every search term, so a small move can hide a big change on one important term.',
        ],
      },
    },
  },
};

export interface DiscrepancyExpectation {
  /** Normal gap ceiling, as |a-b| / max(|a|,|b|). */
  maxRatio: number;
  reason: string;
  /** Replaces the above when Cloudflare is in edge mode. */
  edge?: { maxRatio: number; reason: string };
}

/**
 * Generic source-pair knowledge only. Ratios are mechanism-based rules of
 * thumb, not measurements — a site that knows its own normal gap overrides
 * them through the `expectations` block in SITES_CONFIG.
 */
export const EXPECTED_DISCREPANCY: Record<string, DiscrepancyExpectation> = {
  'pageviews:cloudflare:ga4': {
    maxRatio: 0.3,
    reason:
      'Both count in the browser, but they filter bots differently and fire at slightly different moments.',
    edge: {
      maxRatio: 0.9,
      reason:
        'Cloudflare is counting raw requests at the network edge while the other tool counts real browsers, so a gap of several times over is expected, not a fault.',
    },
  },
  'pageviews:ga4:vercel': {
    maxRatio: 0.25,
    reason:
      'Both count in the browser with similar rules; small gaps come from bot filtering and pages served outside the project.',
  },
  'pageviews:cloudflare:vercel': {
    maxRatio: 0.3,
    reason: 'Both count in the browser, with different bot filtering.',
    edge: {
      maxRatio: 0.9,
      reason:
        'Cloudflare is counting raw requests at the network edge while the other tool counts real browsers, so a gap of several times over is expected, not a fault.',
    },
  },
  'sessions:cloudflare:ga4': {
    maxRatio: 0.4,
    reason:
      'The two define a visit differently: one closes it after 30 minutes of inactivity, the other opens one whenever someone arrives from outside the site.',
  },
  'visitors:cloudflare:ga4': {
    maxRatio: 0.5,
    reason:
      'Cloudflare does not recognise a returning person, so it reports structurally more people than a tool that does.',
    edge: {
      maxRatio: 0.9,
      reason:
        'Cloudflare is counting unique network addresses at the edge, which is a different thing from people and includes bots.',
    },
  },
  'visitors:ga4:vercel': {
    maxRatio: 0.35,
    reason: 'Both count in the browser, but they group repeat visits over different windows.',
  },
  'visitors:cloudflare:vercel': {
    maxRatio: 0.5,
    reason:
      'Cloudflare does not recognise a returning person, so it reports structurally more people.',
    edge: {
      maxRatio: 0.9,
      reason:
        'Cloudflare is counting unique network addresses at the edge, which is a different thing from people.',
    },
  },
};

/** Row caps the adapters actually send. A wider range silently truncates. */
export const SOURCE_ROW_CAPS: Record<SourceId, { cap: number; note: string }> = {
  ga4: { cap: 10_000, note: 'GA4 requests at most 10000 rows per query.' },
  cloudflare: {
    cap: 40,
    note: 'Cloudflare requests at most 40 daily rows, so a day-by-day range longer than 40 days is cut short.',
  },
  vercel: { cap: 0, note: 'Vercel returns whatever the aggregate endpoint provides.' },
  gsc: { cap: 1000, note: 'Search Console requests at most 1000 rows per query.' },
};

export function metricSemantics(metric: string): MetricSemantics | undefined {
  return (METRIC_SEMANTICS as Record<string, MetricSemantics>)[metric];
}

export function isCanonicalMetric(name: string): name is CanonicalMetric {
  return (CANONICAL_METRICS as readonly string[]).includes(name);
}

export function sourceSupports(metric: string, source: SourceId): boolean {
  return Boolean(metricSemantics(metric)?.sources[source]);
}

export function sourcesFor(metric: string): SourceId[] {
  const entry = metricSemantics(metric);
  if (!entry) return [];
  return Object.keys(entry.sources) as SourceId[];
}

function pairKey(metric: string, a: SourceId, b: SourceId): string {
  return `${metric}:${[a, b].sort().join(':')}`;
}

/**
 * Generic expectation for a source pair, or undefined when none is recorded.
 * Callers must report "no criterion" rather than inventing a range.
 */
export function expectationFor(
  metric: string,
  a: SourceId,
  b: SourceId,
  cloudflareMode: CloudflareMode = 'rum',
): { maxRatio: number; reason: string } | undefined {
  const entry = EXPECTED_DISCREPANCY[pairKey(metric, a, b)];
  if (!entry) return undefined;
  const involvesCloudflare = a === 'cloudflare' || b === 'cloudflare';
  if (involvesCloudflare && cloudflareMode === 'edge' && entry.edge) {
    return { maxRatio: entry.edge.maxRatio, reason: entry.edge.reason };
  }
  return { maxRatio: entry.maxRatio, reason: entry.reason };
}

/**
 * Comparisons that cannot mean anything, whatever the numbers say.
 * Returns a plain-language explanation, or undefined when the pair is fine.
 */
export function comparabilityBlocker(metric: string, a: SourceId, b: SourceId): string | undefined {
  if (a === b) {
    return 'Both values come from the same source, so there is nothing to compare.';
  }
  const entry = metricSemantics(metric);
  if (!entry) return undefined;
  const missing = [a, b].filter((source) => !entry.sources[source]);
  if (missing.length > 0) {
    return `${missing.join(' and ')} does not report ${metric}, so the two numbers are not measuring the same thing.`;
  }
  return undefined;
}
