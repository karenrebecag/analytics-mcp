import { afterEach, describe, expect, it } from 'vitest';
import { spawnInitialized } from './helpers.js';
import { createMemoryCache, setCacheStoreForTests } from '../../dist/core/cache/index.js';
import { setSourcesForTests } from '../../dist/sources/registry.js';
import type { AnalyticsSource, SourceId } from '../../dist/sources/types.js';
import { handleQuery } from '../../dist/tools/query.js';

const SITES = JSON.stringify([
  {
    id: 'marketing-site',
    name: 'Marketing website',
    sources: {
      ga4: { propertyId: '123456789' },
      cloudflare: { zoneId: '0123456789abcdef0123456789abcdef' },
      vercel: { projectId: 'prj_xxxxxxxxxxxxxxxxxxxx' },
    },
  },
]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timedSource(id: SourceId, workMs: number, onQuery: () => void): AnalyticsSource {
  return {
    id,
    authKind: 'http-api',
    isConfigured: () => true,
    schema: async () => [],
    query: async (_req, _binding, timeoutMs) => {
      onQuery();
      const cap = timeoutMs ?? 60_000;
      if (workMs > cap) {
        await delay(cap);
        throw new Error(`${id} timeout after ${cap}ms`);
      }
      await delay(workMs);
      const native = id === 'ga4' ? 'screenPageViews' : 'pageviews';
      return { source: id, timezone: 'UTC', rows: [{ [native]: 1 }] };
    },
    queryRaw: async () => ({}),
  };
}

describe('P-F0-1 cold initialize', () => {
  it('completes initialize in under 3000 ms', async () => {
    const { client, initMs, init } = await spawnInitialized();
    try {
      expect(init).toMatchObject({ serverInfo: { name: 'analytics-mcp' } });
      expect(initMs).toBeLessThan(3000);
    } finally {
      await client.kill();
    }
  });
});

describe('P-F2 query fan-out', () => {
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

  it('P-F2-1 three 300ms sources finish in under 700ms', async () => {
    process.env.SITES_CONFIG = SITES;
    setCacheStoreForTests(createMemoryCache());
    setSourcesForTests([
      timedSource('ga4', 300, () => undefined),
      timedSource('cloudflare', 300, () => undefined),
      timedSource('vercel', 300, () => undefined),
    ]);
    const started = Date.now();
    const result = await handleQuery({
      site: 'marketing-site',
      range: { start: '2026-08-20', end: '2026-08-26' },
      granularity: 'total',
      metrics: ['pageviews'],
    });
    expect(Date.now() - started).toBeLessThan(700);
    expect(result.isError).toBeUndefined();
  });

  it('P-F2-2 timeout isolates a hung source', async () => {
    process.env.SITES_CONFIG = SITES;
    process.env.QUERY_SOURCE_TIMEOUT_MS = '500';
    setCacheStoreForTests(createMemoryCache());
    setSourcesForTests([
      timedSource('ga4', 50, () => undefined),
      timedSource('cloudflare', 5000, () => undefined),
      timedSource('vercel', 50, () => undefined),
    ]);
    const started = Date.now();
    const result = await handleQuery({
      site: 'marketing-site',
      range: { start: '2026-08-20', end: '2026-08-26' },
      granularity: 'total',
      metrics: ['pageviews'],
    });
    expect(Date.now() - started).toBeLessThan(1500);
    const text =
      result.content[0] && result.content[0].type === 'text' ? result.content[0].text : '';
    const payload = JSON.parse(text) as {
      results: Array<{ source: string }>;
      errors: Array<{ source: string; error: string }>;
    };
    expect(payload.results.map((r) => r.source).sort()).toEqual(['ga4', 'vercel']);
    expect(payload.errors).toEqual([
      expect.objectContaining({ source: 'cloudflare', error: expect.stringMatching(/timeout/) }),
    ]);
  });

  it('P-F2-3 identical query hits cache on the second call', async () => {
    process.env.SITES_CONFIG = SITES;
    setCacheStoreForTests(createMemoryCache());
    let calls = 0;
    setSourcesForTests([
      timedSource('ga4', 0, () => {
        calls += 1;
      }),
    ]);
    const args = {
      site: 'marketing-site' as const,
      range: { start: '2026-08-20', end: '2026-08-26' },
      granularity: 'total' as const,
      metrics: ['pageviews'],
    };
    await handleQuery(args);
    await handleQuery(args);
    expect(calls).toBe(1);
  });
});

describe('P-F8 page fetch deadline', () => {
  it('P-F8-1 a hung page gives up on its own deadline', async () => {
    const { fetchPageSnapshot } = await import('../../dist/page/fetch.js');
    const { allowedHostsForSite } = await import('../../dist/page/allowlist.js');
    const hosts = allowedHostsForSite({
      id: 'marketing-site',
      name: 'Marketing website',
      sources: { gsc: { siteUrl: 'sc-domain:example.com' } },
    });

    const started = Date.now();
    await expect(
      fetchPageSnapshot('https://example.com/slow', hosts, {
        timeoutMs: 500,
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('server answered late')), 5_000);
            init.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            });
          }),
      }),
    ).rejects.toThrow(/example\.com/);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
