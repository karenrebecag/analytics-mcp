import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { CANONICAL_METRICS } from '../src/core/normalize.js';
import {
  EXPECTED_DISCREPANCY,
  METRIC_SEMANTICS,
  comparabilityBlocker,
  expectationFor,
  sourcesFor,
} from '../src/semantics/knowledge.js';
import { renderMetricsDocument, renderSiteMetricsDocument } from '../src/resources/index.js';
import { handleExplainDiscrepancy } from '../src/tools/explain-discrepancy.js';
import { handleValidateQuery } from '../src/tools/validate-query.js';
import { setSourcesForTests } from '../src/sources/registry.js';
import type { AnalyticsSource, SourceId } from '../src/sources/types.js';

const SITES = JSON.stringify([
  {
    id: 'demo',
    name: 'Demo site',
    sources: { ga4: { propertyId: '111' }, cloudflare: { zoneId: 'z1' } },
    expectations: [
      {
        metric: 'pageviews',
        sourceA: 'ga4',
        sourceB: 'cloudflare',
        maxRatio: 0.05,
        reason: 'Measured here.',
      },
    ],
  },
]);

function stubSource(id: SourceId): AnalyticsSource {
  return {
    id,
    authKind: 'http-api',
    isConfigured: () => true,
    schema: async () => [],
    query: async () => ({ source: id, timezone: 'UTC', rows: [] }),
    queryRaw: async () => ({}),
  } as AnalyticsSource;
}

function payload(result: { content: Array<{ text?: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text ?? '{}');
}

beforeEach(() => {
  process.env.SITES_CONFIG = SITES;
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct';
  setSourcesForTests([stubSource('ga4'), stubSource('cloudflare')]);
});

afterEach(() => {
  delete process.env.SITES_CONFIG;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  setSourcesForTests(null);
});

describe('knowledge coverage matches normalize', () => {
  it('documents every canonical metric', () => {
    for (const metric of CANONICAL_METRICS) {
      expect(METRIC_SEMANTICS[metric]).toBeDefined();
      expect(METRIC_SEMANTICS[metric].businessMeaning.length).toBeGreaterThan(40);
    }
  });

  it('documents only source pairs that both report the metric', () => {
    for (const key of Object.keys(EXPECTED_DISCREPANCY)) {
      const [metric, a, b] = key.split(':') as [string, SourceId, SourceId];
      expect(sourcesFor(metric)).toContain(a);
      expect(sourcesFor(metric)).toContain(b);
    }
  });

  it('reports position as lower-is-better', () => {
    expect(METRIC_SEMANTICS.position.higherIsBetter).toBe(false);
    expect(METRIC_SEMANTICS.pageviews.higherIsBetter).toBe(true);
  });

  it('widens the cloudflare expectation in edge mode', () => {
    const rum = expectationFor('pageviews', 'ga4', 'cloudflare', 'rum');
    const edge = expectationFor('pageviews', 'ga4', 'cloudflare', 'edge');
    expect(edge!.maxRatio).toBeGreaterThan(rum!.maxRatio);
  });

  it('blocks same-source and unsupported comparisons', () => {
    expect(comparabilityBlocker('pageviews', 'ga4', 'ga4')).toMatch(/same source/i);
    expect(comparabilityBlocker('pageviews', 'ga4', 'gsc')).toMatch(/does not report/i);
    expect(comparabilityBlocker('pageviews', 'ga4', 'cloudflare')).toBeUndefined();
  });
});

describe('explain_discrepancy', () => {
  it('calls a gap inside the expected range normal', async () => {
    const out = payload(
      await handleExplainDiscrepancy({
        metric: 'pageviews',
        sourceA: 'ga4',
        sourceB: 'cloudflare',
        valueA: 1000,
        valueB: 1100,
      }),
    );
    expect(out.isNormal).toBe(true);
    expect(out.actualGapPct).toBe(9);
    expect(out.businessMeaning).toMatch(/opened/i);
  });

  it('flags a gap wider than expected', async () => {
    const out = payload(
      await handleExplainDiscrepancy({
        metric: 'pageviews',
        sourceA: 'ga4',
        sourceB: 'cloudflare',
        valueA: 100,
        valueB: 900,
      }),
    );
    expect(out.isNormal).toBe(false);
    expect(out.higherSource).toBe('cloudflare');
  });

  it('refuses to judge a pair where one source does not report the metric', async () => {
    const out = payload(
      await handleExplainDiscrepancy({
        metric: 'sessions',
        sourceA: 'ga4',
        sourceB: 'vercel',
        valueA: 10,
        valueB: 90,
      }),
    );
    expect(out.isNormal).toBeNull();
    expect(String(out.reason)).toMatch(/does not report/i);
  });

  // Every currently-supported pair has a recorded expectation, so the
  // no-criterion branch is reached through the lookup rather than the tool.
  // The guarantee under test is that an unrecorded pair yields nothing to
  // report — never a fabricated range.
  it('has no expectation to offer for an unrecorded pair', () => {
    expect(expectationFor('pageviews', 'ga4', 'gsc')).toBeUndefined();
    expect(expectationFor('position', 'gsc', 'ga4')).toBeUndefined();
  });

  it('lets a site expectation override the generic one', async () => {
    const out = payload(
      await handleExplainDiscrepancy({
        metric: 'pageviews',
        sourceA: 'ga4',
        sourceB: 'cloudflare',
        valueA: 1000,
        valueB: 1100,
        site: 'demo',
      }),
    );
    expect((out.expected as { basis: string }).basis).toBe('site-configured');
    expect(out.isNormal).toBe(false);
  });
});

describe('validate_query', () => {
  it('accepts a query the site can answer', async () => {
    const out = payload(
      await handleValidateQuery({
        site: 'demo',
        range: { start: '2026-08-01', end: '2026-08-07' },
        granularity: 'day',
        metrics: ['pageviews'],
      }),
    );
    expect(out.valid).toBe(true);
  });

  it('errors on a metric no bound source reports', async () => {
    const out = payload(
      await handleValidateQuery({
        site: 'demo',
        range: { start: '2026-08-01', end: '2026-08-07' },
        granularity: 'day',
        metrics: ['clicks'],
      }),
    );
    expect(out.valid).toBe(false);
    expect(JSON.stringify(out.issues)).toMatch(/metric-unavailable/);
  });

  it('warns when a daily range exceeds the cloudflare row cap', async () => {
    const out = payload(
      await handleValidateQuery({
        site: 'demo',
        range: { start: '2026-01-01', end: '2026-08-01' },
        granularity: 'day',
        metrics: ['pageviews'],
      }),
    );
    expect(JSON.stringify(out.issues)).toMatch(/range-truncated/);
  });

  it('warns that cloudflare sessions and visitors are the same number', async () => {
    const out = payload(
      await handleValidateQuery({
        site: 'demo',
        range: { start: '2026-08-01', end: '2026-08-07' },
        granularity: 'total',
        metrics: ['sessions', 'visitors'],
      }),
    );
    expect(JSON.stringify(out.issues)).toMatch(/cloudflare-shared-metric/);
  });
});

describe('metrics resource', () => {
  it('renders criterion plus the audience note', () => {
    const doc = JSON.parse(renderMetricsDocument());
    expect(doc.note).toMatch(/no analytics background/i);
    expect(doc.metrics.pageviews.businessMeaning).toBeTruthy();
    expect(JSON.stringify(doc.howToRead)).toMatch(/never zero traffic/i);
  });

  it('renders site expectations when configured', () => {
    const doc = JSON.parse(renderSiteMetricsDocument('demo'));
    expect(doc.site.id).toBe('demo');
    expect(doc.siteExpectations).toHaveLength(1);
  });
});
