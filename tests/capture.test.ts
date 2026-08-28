import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHistory } from '../src/core/history/index.js';
import type { HistoryStore } from '../src/core/history/types.js';
import { captureSite, historyKey } from '../src/page/capture.js';
import { setHostLookupForTests, setPageFetchForTests } from '../src/page/fetch.js';
import type { PageFacts } from '../src/page/types.js';
import { setSourcesForTests } from '../src/sources/registry.js';
import type { AnalyticsSource } from '../src/sources/types.js';

const SITES = JSON.stringify([
  {
    id: 'marketing-site',
    name: 'Marketing website',
    sources: { gsc: { siteUrl: 'sc-domain:example.com' } },
  },
]);

const PAGES = ['https://example.com/a', 'https://example.com/b'];

function gscSource(): AnalyticsSource {
  return {
    id: 'gsc',
    authKind: 'http-api',
    isConfigured: () => true,
    schema: async () => [],
    query: async () => ({
      source: 'gsc',
      timezone: 'UTC',
      rows: PAGES.map((page, index) => ({
        page,
        clicks: 10 - index,
        impressions: 1000 - index * 100,
        position: 5,
      })),
    }),
    queryRaw: async () => ({}),
  } as AnalyticsSource;
}

/** Serves a title we can change between runs, which is the whole point. */
function servePages(titleFor: (url: string) => string): void {
  setPageFetchForTests(async (url) => ({
    status: 200,
    headers: { get: () => null },
    text: async () =>
      `<html><head><title>${titleFor(url)}</title></head><body><h1>H</h1></body></html>`,
  }));
}

describe('capture', () => {
  let prevSites: string | undefined;
  let history: HistoryStore;

  beforeEach(() => {
    prevSites = process.env.SITES_CONFIG;
    process.env.SITES_CONFIG = SITES;
    setSourcesForTests([gscSource()]);
    setHostLookupForTests(async () => [{ address: '93.184.216.34' }]);
    history = createMemoryHistory();
  });

  afterEach(() => {
    setSourcesForTests(null);
    setPageFetchForTests(null);
    setHostLookupForTests(null);
    if (prevSites === undefined) delete process.env.SITES_CONFIG;
    else process.env.SITES_CONFIG = prevSites;
  });

  it('records a baseline for every page the first time', async () => {
    servePages(() => 'Original title');
    const summary = await captureSite('marketing-site', { history, delayMs: 0 });
    expect(summary.changed).toBe(2);
    expect(summary.unchanged).toBe(0);
    expect(await history.range(historyKey('marketing-site', PAGES[0]), 0, Date.now())).toHaveLength(
      1,
    );
  });

  it('writes nothing when nothing moved — what a duplicated cron run needs', async () => {
    servePages(() => 'Original title');
    await captureSite('marketing-site', { history, delayMs: 0 });
    const second = await captureSite('marketing-site', { history, delayMs: 0 });
    expect(second.changed).toBe(0);
    expect(second.unchanged).toBe(2);
    expect(await history.range(historyKey('marketing-site', PAGES[0]), 0, Date.now())).toHaveLength(
      1,
    );
  });

  it('records the page that moved and leaves the other alone', async () => {
    servePages(() => 'Original title');
    await captureSite('marketing-site', { history, delayMs: 0 });

    servePages((url) => (url === PAGES[0] ? 'Rewritten title' : 'Original title'));
    const second = await captureSite('marketing-site', { history, delayMs: 0 });
    expect(second.changed).toBe(1);
    expect(second.unchanged).toBe(1);

    const entries = await history.range(historyKey('marketing-site', PAGES[0]), 0, Date.now());
    expect(entries).toHaveLength(2);
    expect((JSON.parse(entries[1].value) as PageFacts).title).toBe('Rewritten title');
    expect(await history.range(historyKey('marketing-site', PAGES[1]), 0, Date.now())).toHaveLength(
      1,
    );
  });

  it('carries on past a page it cannot read', async () => {
    setPageFetchForTests(async (url) => {
      if (url === PAGES[0]) throw new Error('connection reset');
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => '<html><head><title>Fine</title></head><body><h1>H</h1></body></html>',
      };
    });
    const summary = await captureSite('marketing-site', { history, delayMs: 0 });
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.page).toBe(PAGES[0]);
    expect(summary.changed).toBe(1);
  });

  it('says plainly that it cannot record without a store', async () => {
    servePages(() => 'Original title');
    const summary = await captureSite('marketing-site', { history: null, delayMs: 0 });
    expect(summary.skipped).toContain('No history store');
    expect(summary.changed).toBe(0);
  });
});
