import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createCloudflareSource } from '../src/sources/cloudflare.js';
import { createGa4Source, fetchGa4Metadata } from '../src/sources/ga4.js';
import { clearGoogleTokenCacheForTests } from '../src/sources/google-auth.js';
import { createGscSource } from '../src/sources/gsc.js';
import { createVercelSource } from '../src/sources/vercel.js';
import type { FetchLike } from '../src/sources/upstream.js';
import type { QueryRequest } from '../src/sources/types.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const RANGE = { start: '2026-08-20', end: '2026-08-26' };
const REQ: QueryRequest = {
  siteId: 'marketing-site',
  range: RANGE,
  granularity: 'total',
  metrics: ['pageviews'],
};

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function testServiceAccount(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return JSON.stringify({
    client_email: 'tester@example.com',
    private_key: privateKey,
  });
}

function googleFetch(apiFixture: unknown): FetchLike {
  return async (url) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return jsonResponse({ access_token: 'ga-access-token-fixture', expires_in: 3600 });
    }
    return jsonResponse(apiFixture);
  };
}

afterEach(() => {
  clearGoogleTokenCacheForTests();
});

describe('ga4', () => {
  const sa = testServiceAccount();
  const binding = { propertyId: '123456789' };

  it('isConfigured is env presence only', () => {
    const src = createGa4Source();
    expect(src.isConfigured({})).toBe(false);
    expect(src.isConfigured({ GA4_SERVICE_ACCOUNT_JSON: sa })).toBe(true);
  });

  it('query maps runReport rows from the capture shape', async () => {
    const src = createGa4Source({
      env: { GA4_SERVICE_ACCOUNT_JSON: sa },
      fetchImpl: googleFetch(fixture('ga4-runReport.json')),
    });
    const result = await src.query(
      { ...REQ, metrics: ['screenPageViews', 'sessions', 'totalUsers'] },
      binding,
    );
    expect(result.source).toBe('ga4');
    expect(result.timezone).toBe('America/Los_Angeles');
    expect(result.rows[0]).toMatchObject({
      date: '20260820',
      screenPageViews: 120,
      sessions: 40,
      totalUsers: 30,
    });
  });

  it('schema uses metadata capture names', async () => {
    const entries = await fetchGa4Metadata(binding, {
      env: { GA4_SERVICE_ACCOUNT_JSON: sa },
      fetchImpl: googleFetch(fixture('ga4-metadata.json')),
    });
    expect(entries.some((e) => e.name === 'screenPageViews' && e.kind === 'metric')).toBe(true);
    expect(entries.some((e) => e.name === 'date' && e.kind === 'dimension')).toBe(true);
  });

  it('truncates upstream errors and omits the bearer token', async () => {
    const token = 'ga-access-token-fixture';
    const src = createGa4Source({
      env: { GA4_SERVICE_ACCOUNT_JSON: sa },
      fetchImpl: async (url) => {
        if (url.includes('/token')) return jsonResponse({ access_token: token, expires_in: 3600 });
        return new Response('E'.repeat(10_000), { status: 500 });
      },
    });
    await expect(src.query({ ...REQ, metrics: ['sessions'] }, binding)).rejects.toSatisfy(
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        return message.length <= 400 && !message.includes(token) && message.startsWith('ga4 500:');
      },
    );
  });
});

describe('cloudflare', () => {
  const rum = fixture('cloudflare-viewer.json');
  const http = fixture('cloudflare-http.json');
  const binding = { zoneId: '0123456789abcdef0123456789abcdef', host: 'www.example.com' };

  it('query uses RUM capture when CLOUDFLARE_ACCOUNT_ID is set', async () => {
    const src = createCloudflareSource({
      env: { CLOUDFLARE_API_TOKEN: 'cf-token', CLOUDFLARE_ACCOUNT_ID: 'acct_test' },
      fetchImpl: async () => jsonResponse(rum),
    });
    const result = await src.query(REQ, binding);
    expect(result.rows[0]).toMatchObject({ pageviews: 108, visits: 83, lcp: 1764000, cls: 0.011 });
    expect(result.timezone).toBe('UTC');
  });

  it('query uses zone HTTP capture when account id is absent', async () => {
    const src = createCloudflareSource({
      env: { CLOUDFLARE_API_TOKEN: 'cf-token' },
      fetchImpl: async () => jsonResponse(http),
    });
    const result = await src.query(REQ, binding);
    expect(result.rows[0]).toMatchObject({ date: '2026-08-20', requests: 1000, uniques: 200 });
  });
});

describe('vercel', () => {
  const binding = {
    projectId: 'prj_xxxxxxxxxxxxxxxxxxxx',
    teamId: 'team_xxxxxxxxxxxxxxxxxxxxxxxx',
  };

  it('total granularity uses visits/count capture', async () => {
    const src = createVercelSource({
      env: { VERCEL_API_TOKEN: 'vercel-token' },
      fetchImpl: async (url) => {
        expect(url).toContain('visits/count');
        expect(url).toContain('projectId=prj_xxxxxxxxxxxxxxxxxxxx');
        expect(url).toContain('teamId=team_');
        return jsonResponse(fixture('vercel-visits-count.json'));
      },
    });
    const result = await src.query(REQ, binding);
    expect(result.rows[0]).toEqual({ pageviews: 1250, visitors: 980 });
  });

  it('day granularity uses visits/aggregate capture', async () => {
    const src = createVercelSource({
      env: { VERCEL_API_TOKEN: 'vercel-token' },
      fetchImpl: async (url) => {
        expect(url).toContain('visits/aggregate');
        expect(url).toContain('by=day');
        return jsonResponse(fixture('vercel-visits-aggregate.json'));
      },
    });
    const result = await src.query({ ...REQ, granularity: 'day' }, binding);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ pageviews: 220, visitors: 180 });
  });

  it('queryRaw refuses absolute and protocol-relative paths before fetch', async () => {
    let called = 0;
    const src = createVercelSource({
      env: { VERCEL_API_TOKEN: 'vercel-token' },
      fetchImpl: async () => {
        called += 1;
        return jsonResponse({});
      },
    });
    for (const path of ['https://evil.example/steal', '//evil.example/steal', '/v9/projects']) {
      await expect(src.queryRaw({ path }, binding)).rejects.toThrow(/vercel path/);
    }
    expect(called).toBe(0);
  });
});

describe('gsc', () => {
  const sa = testServiceAccount();
  const binding = { siteUrl: 'sc-domain:example.com' };

  it('reuses GA4 json when GSC_SERVICE_ACCOUNT_JSON is empty', async () => {
    const src = createGscSource({
      env: { GA4_SERVICE_ACCOUNT_JSON: sa },
      fetchImpl: googleFetch(fixture('gsc-searchanalytics.json')),
    });
    expect(src.isConfigured({ GA4_SERVICE_ACCOUNT_JSON: sa })).toBe(true);
    const result = await src.query({ ...REQ, granularity: 'day', metrics: ['clicks'] }, binding);
    expect(result.rows[0]).toMatchObject({
      date: '2026-08-20',
      clicks: 12,
      impressions: 400,
      ctr: 0.03,
      position: 8.2,
    });
  });
});
