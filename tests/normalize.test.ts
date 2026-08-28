import { describe, expect, it } from 'vitest';
import {
  canonicalizeRows,
  discrepancyNotes,
  partialDayCaveat,
  planSourceMetrics,
  toCanonical,
  toNative,
} from '../src/core/normalize.js';
import type { QueryResult } from '../src/sources/types.js';

describe('normalize', () => {
  it('maps canonical metrics to F1 native names', () => {
    expect(toNative('ga4', 'pageviews')).toBe('screenPageViews');
    expect(toNative('ga4', 'visitors')).toBe('totalUsers');
    expect(toNative('cloudflare', 'pageviews')).toBe('pageviews');
    expect(toNative('vercel', 'visitors')).toBe('visitors');
    expect(toNative('gsc', 'clicks')).toBe('clicks');
    expect(toNative('ga4', 'clicks')).toBeUndefined();
    expect(toCanonical('ga4', 'screenPageViews')).toBe('pageviews');
  });

  it('warns on unknown metrics without dropping covered ones', () => {
    const plan = planSourceMetrics('gsc', ['pageviews', 'clicks']);
    expect(plan.native).toEqual(['clicks']);
    expect(plan.warnings).toEqual(["unknown metric 'pageviews' for gsc"]);
  });

  it('rewrites native row keys to canonical names', () => {
    const rows = canonicalizeRows(
      'ga4',
      [{ date: '20260820', screenPageViews: 120, sessions: 40 }],
      ['pageviews', 'sessions'],
    );
    expect(rows[0]).toEqual({ date: '20260820', pageviews: 120, sessions: 40 });
  });

  it('maps Cloudflare HTTP requests/uniques onto pageviews/visitors', () => {
    const rows = canonicalizeRows(
      'cloudflare',
      [{ date: '2026-08-20', requests: 1000, uniques: 200 }],
      ['pageviews', 'visitors'],
    );
    expect(rows[0]).toEqual({ date: '2026-08-20', pageviews: 1000, visitors: 200 });
  });

  it('reports percent delta for the same metric from two sources', () => {
    const results: QueryResult[] = [
      { source: 'ga4', timezone: 'UTC', rows: [{ pageviews: 100 }] },
      { source: 'vercel', timezone: 'UTC', rows: [{ pageviews: 150 }] },
    ];
    expect(discrepancyNotes(results)).toEqual([
      'ga4.pageviews=100 vs vercel.pageviews=150 (Δ 33%)',
    ]);
  });
});

describe('partial-day caveat', () => {
  const now = new Date('2026-08-28T15:00:00Z');
  const mixed = [
    { source: 'ga4' as const, timezone: 'America/Panama', rows: [] },
    { source: 'cloudflare' as const, timezone: 'UTC', rows: [] },
  ];

  it('warns when the range includes today and timezones differ', () => {
    // Cloudflare is 15 hours into the day, GA4 is 10: the gap is partly clock.
    const note = partialDayCaveat(mixed, '2026-08-28', now);
    expect(note).toContain('America/Panama');
    expect(note).toContain('UTC');
    expect(note).toMatch(/clock, not the tracking/i);
  });

  it('stays quiet for a complete past range', () => {
    expect(partialDayCaveat(mixed, '2026-08-27', now)).toBeNull();
  });

  it('stays quiet when every source shares a timezone', () => {
    const same = [
      { source: 'ga4' as const, timezone: 'UTC', rows: [] },
      { source: 'cloudflare' as const, timezone: 'UTC', rows: [] },
    ];
    expect(partialDayCaveat(same, '2026-08-28', now)).toBeNull();
  });
});
