import { afterEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { handleListSites } from '../src/tools/list-sites.js';
import { handleListSources } from '../src/tools/list-sources.js';
import { setSourcesForTests } from '../src/sources/registry.js';
import type { AnalyticsSource } from '../src/sources/types.js';

const PROPERTY_ID = 'secret-property-should-not-leak';
const ZONE_ID = 'secret-zone-should-not-leak';
const TOKEN = 'super-secret-token-should-not-leak';

const FIXTURE = JSON.stringify([
  {
    id: 'marketing-site',
    name: 'Marketing website',
    sources: {
      ga4: { propertyId: PROPERTY_ID },
      cloudflare: { zoneId: ZONE_ID, host: 'www.example.com' },
    },
  },
  {
    id: 'app',
    name: 'Product app',
    sources: { vercel: { projectId: 'prj_xxxxxxxxxxxxxxxxxxxx' } },
  },
]);

function textOf(result: CallToolResult): string {
  const block = result.content[0];
  if (!block || block.type !== 'text') throw new Error('expected text content');
  return block.text;
}

function payloadOf(result: CallToolResult): unknown {
  return JSON.parse(textOf(result));
}

describe('list_sites / list_sources', () => {
  const previousConfig = process.env.SITES_CONFIG;
  const previousToken = process.env.GA4_SERVICE_ACCOUNT_JSON;

  afterEach(() => {
    setSourcesForTests(null);
    if (previousConfig === undefined) delete process.env.SITES_CONFIG;
    else process.env.SITES_CONFIG = previousConfig;
    if (previousToken === undefined) delete process.env.GA4_SERVICE_ACCOUNT_JSON;
    else process.env.GA4_SERVICE_ACCOUNT_JSON = previousToken;
  });

  it('lists site ids and source keys without binding values', async () => {
    process.env.SITES_CONFIG = FIXTURE;
    const result = await handleListSites();
    const payload = payloadOf(result) as {
      count: number;
      sites: Array<{ id: string; name: string; sources: string[] }>;
    };
    expect(payload.count).toBe(2);
    expect(payload.sites).toEqual([
      { id: 'marketing-site', name: 'Marketing website', sources: ['ga4', 'cloudflare'] },
      { id: 'app', name: 'Product app', sources: ['vercel'] },
    ]);
    const raw = textOf(result);
    expect(raw).not.toContain(PROPERTY_ID);
    expect(raw).not.toContain(ZONE_ID);
  });

  it('reports injected source configuration without credential values', async () => {
    process.env.GA4_SERVICE_ACCOUNT_JSON = TOKEN;
    const ga4: AnalyticsSource = {
      id: 'ga4',
      authKind: 'http-api',
      isConfigured: (env) => Boolean(env.GA4_SERVICE_ACCOUNT_JSON),
      schema: async () => [],
      query: async () => ({ source: 'ga4', timezone: 'UTC', rows: [] }),
      queryRaw: async () => ({}),
    };
    setSourcesForTests([ga4]);
    const result = await handleListSources();
    const payload = payloadOf(result) as {
      sources: Array<{ id: string; authKind: string; configured: boolean }>;
    };
    expect(payload.sources).toEqual([{ id: 'ga4', authKind: 'http-api', configured: true }]);
    expect(textOf(result)).not.toContain(TOKEN);
  });
});
