import { afterEach, describe, expect, it } from 'vitest';
import { allSources, getSource, setSourcesForTests } from '../src/sources/registry.js';
import type { AnalyticsSource } from '../src/sources/types.js';

function fakeSource(id: AnalyticsSource['id'] = 'ga4'): AnalyticsSource {
  return {
    id,
    authKind: 'http-api',
    isConfigured: () => false,
    schema: async () => [],
    query: async () => ({ source: id, timezone: 'UTC', rows: [] }),
    queryRaw: async () => ({}),
  };
}

describe('registry', () => {
  afterEach(() => {
    setSourcesForTests(null);
  });

  it('returns the four adapters', () => {
    expect(allSources().map((s) => s.id)).toEqual(['ga4', 'cloudflare', 'vercel', 'gsc']);
  });

  it('lists valid ids when getSource misses', () => {
    expect(() => getSource('nope')).toThrow(
      "Unknown source 'nope'. Valid: ga4, cloudflare, vercel, gsc",
    );
  });

  it('injects adapters for tests and clears them', () => {
    const ga4 = fakeSource('ga4');
    setSourcesForTests([ga4]);
    expect(allSources()).toEqual([ga4]);
    expect(getSource('ga4')).toBe(ga4);
    setSourcesForTests(null);
    expect(allSources().map((s) => s.id)).toEqual(['ga4', 'cloudflare', 'vercel', 'gsc']);
  });
});
