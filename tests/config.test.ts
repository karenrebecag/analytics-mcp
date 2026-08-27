import { afterEach, describe, expect, it } from 'vitest';
import { getSite, loadSites } from '../src/config/sites.js';

const LEAK_PROPERTY = 'LEAK_ME_PROPERTY_ID_xyz';
const LEAK_JSON = 'LEAK_ME_JSON_BLOB_xyz';

describe('loadSites', () => {
  afterEach(() => {
    delete process.env.SITES_CONFIG;
  });

  it('returns [] when SITES_CONFIG is missing', () => {
    expect(loadSites({})).toEqual([]);
    expect(loadSites({ SITES_CONFIG: undefined })).toEqual([]);
    expect(loadSites({ SITES_CONFIG: '' })).toEqual([]);
  });

  it('parses a valid config', () => {
    const sites = loadSites({
      SITES_CONFIG: JSON.stringify([
        {
          id: 'marketing-site',
          name: 'Marketing website',
          sources: {
            ga4: { propertyId: '123456789' },
            cloudflare: { zoneId: '0123456789abcdef0123456789abcdef', host: 'www.example.com' },
          },
        },
      ]),
    });
    expect(sites).toHaveLength(1);
    expect(sites[0]?.id).toBe('marketing-site');
    expect(sites[0]?.sources.ga4?.propertyId).toBe('123456789');
  });

  it('throws without echoing raw content when JSON is invalid', () => {
    const raw = `{not json ${LEAK_JSON}}`;
    expect(() => loadSites({ SITES_CONFIG: raw })).toThrow('SITES_CONFIG is not valid JSON');
    try {
      loadSites({ SITES_CONFIG: raw });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(LEAK_JSON);
      expect(message).not.toContain(raw);
    }
  });

  it('throws listing zod paths only on shape errors', () => {
    const raw = JSON.stringify([
      {
        id: 'site',
        name: 'Site',
        sources: { ga4: { propertyId: LEAK_PROPERTY, extra: true } },
      },
    ]);
    expect(() => loadSites({ SITES_CONFIG: raw })).toThrow(/0\.sources\.ga4/);
    try {
      loadSites({ SITES_CONFIG: raw });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('SITES_CONFIG shape error at:');
      expect(message).toContain('0.sources.ga4');
      expect(message).not.toContain(LEAK_PROPERTY);
    }
  });
});

describe('getSite', () => {
  const sites = loadSites({
    SITES_CONFIG: JSON.stringify([
      { id: 'app', name: 'App', sources: { vercel: { projectId: 'prj_xxxxxxxxxxxxxxxxxxxx' } } },
      { id: 'docs', name: 'Docs', sources: { gsc: { siteUrl: 'sc-domain:example.com' } } },
    ]),
  });

  it('returns the matching site', () => {
    expect(getSite(sites, 'app').name).toBe('App');
  });

  it('lists available ids when not found', () => {
    expect(() => getSite(sites, 'missing')).toThrow("Unknown site 'missing'. Available: app, docs");
  });
});
