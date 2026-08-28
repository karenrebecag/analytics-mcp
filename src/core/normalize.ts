import type { QueryResult, SourceId } from '../sources/types.js';

export const CANONICAL_METRICS = [
  'pageviews',
  'sessions',
  'visitors',
  'clicks',
  'impressions',
  'ctr',
  'position',
] as const;

export type CanonicalMetric = (typeof CANONICAL_METRICS)[number];

/** Preferred native name sent to the adapter. */
const NATIVE: Record<SourceId, Partial<Record<CanonicalMetric, string>>> = {
  ga4: { pageviews: 'screenPageViews', sessions: 'sessions', visitors: 'totalUsers' },
  cloudflare: { pageviews: 'pageviews', sessions: 'visits', visitors: 'visits' },
  vercel: { pageviews: 'pageviews', visitors: 'visitors' },
  gsc: { clicks: 'clicks', impressions: 'impressions', ctr: 'ctr', position: 'position' },
};

/** Extra native columns that still fold into a canonical (CF HTTP vs RUM). */
const NATIVE_ALIASES: Record<SourceId, Record<string, CanonicalMetric>> = {
  ga4: { screenPageViews: 'pageviews', sessions: 'sessions', totalUsers: 'visitors' },
  cloudflare: {
    pageviews: 'pageviews',
    requests: 'pageviews',
    visits: 'visitors',
    uniques: 'visitors',
  },
  vercel: { pageviews: 'pageviews', visitors: 'visitors' },
  gsc: { clicks: 'clicks', impressions: 'impressions', ctr: 'ctr', position: 'position' },
};

export function toNative(source: SourceId, canonical: string): string | undefined {
  if (!isCanonical(canonical)) return undefined;
  return NATIVE[source][canonical];
}

export function toCanonical(source: SourceId, native: string): CanonicalMetric | undefined {
  return NATIVE_ALIASES[source][native];
}

export function isCanonical(name: string): name is CanonicalMetric {
  return (CANONICAL_METRICS as readonly string[]).includes(name);
}

export function planSourceMetrics(
  source: SourceId,
  requested: string[],
): { native: string[]; warnings: string[] } {
  const native: string[] = [];
  const warnings: string[] = [];
  for (const metric of requested) {
    const mapped = toNative(source, metric);
    if (!mapped) {
      warnings.push(`unknown metric '${metric}' for ${source}`);
      continue;
    }
    if (!native.includes(mapped)) native.push(mapped);
  }
  return { native, warnings };
}

export function canonicalizeRows(
  source: SourceId,
  rows: Array<Record<string, string | number>>,
  requested: string[],
): Array<Record<string, string | number>> {
  return rows.map((row) => {
    const out: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(row)) {
      const canonical = toCanonical(source, key);
      if (canonical && requested.includes(canonical)) out[canonical] = value;
      else if (!toCanonical(source, key)) out[key] = value;
    }
    for (const metric of requested) {
      if (metric in out) continue;
      const native = toNative(source, metric);
      if (native && native in row) out[metric] = row[native];
      else {
        const alias = Object.entries(NATIVE_ALIASES[source]).find(
          ([, canonical]) => canonical === metric,
        );
        if (alias && alias[0] in row) out[metric] = row[alias[0]];
      }
    }
    return out;
  });
}

/**
 * Two sources reporting in different timezones do not share a "today": one may
 * be five hours into the day while the other is ten. Comparing them over a
 * range that includes today measures the clock as much as the tracking, and a
 * gap that looks alarming can be pure artefact.
 */
export function partialDayCaveat(
  results: QueryResult[],
  rangeEnd: string,
  now: Date = new Date(),
): string | null {
  const zones = [...new Set(results.map((r) => r.timezone))];
  if (zones.length < 2) return null;
  if (rangeEnd < now.toISOString().slice(0, 10)) return null;
  return (
    `This range includes today and these sources report in different timezones (${zones.join(', ')}), ` +
    'so their day started at different moments and covers a different number of hours. ' +
    'Part of any gap above is the clock, not the tracking — compare complete past days to judge.'
  );
}

/** Compare the same canonical metric across sources. Timezones are reported, never converted. */
export function discrepancyNotes(results: QueryResult[]): string[] {
  const notes: string[] = [];
  for (const metric of CANONICAL_METRICS) {
    const series: Array<{ source: SourceId; value: number }> = [];
    for (const result of results) {
      const value = metricTotal(result, metric);
      if (value !== undefined) series.push({ source: result.source, value });
    }
    if (series.length < 2) continue;
    for (let i = 0; i < series.length; i++) {
      for (let j = i + 1; j < series.length; j++) {
        const a = series[i];
        const b = series[j];
        const denom = Math.max(Math.abs(a.value), Math.abs(b.value));
        if (denom === 0) continue;
        const pct = Math.round((Math.abs(a.value - b.value) / denom) * 100);
        notes.push(
          `${a.source}.${metric}=${a.value} vs ${b.source}.${metric}=${b.value} (Δ ${pct}%)`,
        );
      }
    }
  }
  return notes;
}

function metricTotal(result: QueryResult, metric: string): number | undefined {
  let sum = 0;
  let found = false;
  for (const row of result.rows) {
    const value = row[metric];
    if (typeof value === 'number' && Number.isFinite(value)) {
      sum += value;
      found = true;
    }
  }
  return found ? sum : undefined;
}
