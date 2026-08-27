import { afterEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createMemoryCache, setCacheStoreForTests } from '../src/core/cache/index.js';
import { setSourcesForTests } from '../src/sources/registry.js';
import type { AnalyticsSource, QueryResult, SourceId } from '../src/sources/types.js';
import { handleGetSchema } from '../src/tools/get-schema.js';
import { handleQuery } from '../src/tools/query.js';
import { handleQueryRaw, queryRawSchema, RAW_MAX_BYTES } from '../src/tools/query-raw.js';

const SITES = JSON.stringify([
  {
    id: 'marketing-site',
    name: 'Marketing website',
    sources: {
      ga4: { propertyId: '123456789' },
      cloudflare: { zoneId: '0123456789abcdef0123456789abcdef' },
      vercel: { projectId: 'prj_xxxxxxxxxxxxxxxxxxxx' },
      gsc: { siteUrl: 'sc-domain:example.com' },
    },
  },
]);

function textOf(result: CallToolResult): string {
  const block = result.content[0];
  if (!block || block.type !== 'text') throw new Error('expected text');
  return block.text;
}

function payloadOf(result: CallToolResult): unknown {
  return JSON.parse(textOf(result));
}

function fakeSource(
  id: SourceId,
  opts: {
    latencyMs?: number;
    hangMs?: number;
    rows?: QueryResult['rows'];
    onQuery?: () => void;
    raw?: unknown;
  } = {},
): AnalyticsSource {
  return {
    id,
    authKind: 'http-api',
    isConfigured: () => true,
    schema: async () => [{ name: 'pageviews', kind: 'metric', description: `${id} pageviews` }],
    query: async () => {
      opts.onQuery?.();
      if (opts.hangMs) await new Promise((r) => setTimeout(r, opts.hangMs));
      if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
      const nativeKey = id === 'ga4' ? 'screenPageViews' : 'pageviews';
      return {
        source: id,
        timezone: 'UTC',
        rows: opts.rows ?? [{ [nativeKey]: 10 }],
      };
    },
    queryRaw: async () => opts.raw ?? { ok: true, source: id },
  };
}

describe('query tools', () => {
  const prevSites = process.env.SITES_CONFIG;
  const prevTimeout = process.env.QUERY_SOURCE_TIMEOUT_MS;

  afterEach(() => {
    setSourcesForTests(null);
    setCacheStoreForTests(null);
    if (prevSites === undefined) delete process.env.SITES_CONFIG;
    else process.env.SITES_CONFIG = prevSites;
    if (prevTimeout === undefined) delete process.env.QUERY_SOURCE_TIMEOUT_MS;
    else process.env.QUERY_SOURCE_TIMEOUT_MS = prevTimeout;
  });

  it('query fans out, canonicalizes rows, and notes discrepancies', async () => {
    process.env.SITES_CONFIG = SITES;
    setCacheStoreForTests(createMemoryCache());
    setSourcesForTests([
      fakeSource('ga4', { rows: [{ screenPageViews: 100 }] }),
      fakeSource('vercel', { rows: [{ pageviews: 150 }] }),
    ]);
    const result = await handleQuery({
      site: 'marketing-site',
      range: { start: '2026-08-20', end: '2026-08-26' },
      granularity: 'total',
      metrics: ['pageviews'],
    });
    const payload = payloadOf(result) as {
      results: QueryResult[];
      notes: string[];
    };
    expect(payload.results.map((r) => r.rows[0]?.pageviews)).toEqual([100, 150]);
    expect(payload.notes[0]).toMatch(/Δ 33%/);
  });

  it('query keeps other sources when one metric is unknown', async () => {
    process.env.SITES_CONFIG = SITES;
    setCacheStoreForTests(createMemoryCache());
    setSourcesForTests([fakeSource('ga4'), fakeSource('gsc', { rows: [{ clicks: 12 }] })]);
    const result = await handleQuery({
      site: 'marketing-site',
      range: { start: '2026-08-20', end: '2026-08-26' },
      granularity: 'total',
      metrics: ['pageviews'],
      sources: ['ga4', 'gsc'],
    });
    const payload = payloadOf(result) as { results: QueryResult[]; errors?: unknown };
    expect(payload.errors).toBeUndefined();
    const gsc = payload.results.find((r) => r.source === 'gsc');
    expect(gsc?.warnings?.[0]).toMatch(/unknown metric 'pageviews' for gsc/);
    expect(gsc?.rows).toEqual([]);
  });

  it('query_raw schema lists valid ids', () => {
    const parsed = queryRawSchema.safeParse({
      source: 'not-a-source',
      site: 'marketing-site',
      body: {},
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toContain('ga4');
    expect(parsed.error.issues[0]?.message).toContain('gsc');
  });

  it('query_raw truncates oversized native responses', async () => {
    process.env.SITES_CONFIG = SITES;
    setSourcesForTests([fakeSource('ga4', { raw: { blob: 'x'.repeat(RAW_MAX_BYTES + 10) } })]);
    const result = await handleQueryRaw({
      source: 'ga4',
      site: 'marketing-site',
      body: { limit: 1 },
    });
    const payload = payloadOf(result) as { truncated?: boolean; note?: string };
    expect(payload.truncated).toBe(true);
    expect(payload.note).toMatch(/32768/);
  });

  it('query still returns a successful slot when the cache store throws', async () => {
    process.env.SITES_CONFIG = SITES;
    setCacheStoreForTests({
      get: async () => {
        throw new Error('cache down');
      },
      set: async () => {
        throw new Error('cache down');
      },
    });
    setSourcesForTests([fakeSource('ga4', { rows: [{ screenPageViews: 9 }] })]);
    const result = await handleQuery({
      site: 'marketing-site',
      range: { start: '2026-08-20', end: '2026-08-26' },
      granularity: 'total',
      metrics: ['pageviews'],
    });
    const payload = payloadOf(result) as { results: QueryResult[]; errors?: unknown };
    expect(payload.errors).toBeUndefined();
    expect(payload.results[0]?.rows[0]?.pageviews).toBe(9);
  });

  it('get_schema returns static entries for injected sources', async () => {
    process.env.SITES_CONFIG = SITES;
    setCacheStoreForTests(createMemoryCache());
    setSourcesForTests([fakeSource('vercel')]);
    const result = await handleGetSchema({ source: 'vercel' });
    const payload = payloadOf(result) as {
      schemas: Array<{ source: string; entries: Array<{ name: string }> }>;
    };
    expect(payload.schemas[0]?.source).toBe('vercel');
    expect(payload.schemas[0]?.entries[0]?.name).toBe('pageviews');
  });
});
