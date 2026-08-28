import { describe, expect, it, vi } from 'vitest';
import {
  allowedHostsForSite,
  assertFetchable,
  isAllowedHost,
  type AllowedHosts,
} from '../src/page/allowlist.js';
import { extractPageFacts, hashFacts } from '../src/page/extract.js';
import { fetchPageSnapshot, type PageFetch, type PageResponse } from '../src/page/fetch.js';
import type { PageFacts } from '../src/page/types.js';
import { pageVerdicts } from '../src/page/verdicts.js';
import type { Site } from '../src/sources/types.js';

const transport = { url: 'https://example.com/a', status: 200, fetchedAt: '2026-01-01T00:00:00Z' };

function site(sources: Site['sources']): Site {
  return { id: 'example', name: 'Example', sources };
}

function hosts(sources: Site['sources']): AllowedHosts {
  return allowedHostsForSite(site(sources));
}

function response(status: number, html: string, location?: string): PageResponse {
  return {
    status,
    headers: { get: (name) => (name.toLowerCase() === 'location' ? (location ?? null) : null) },
    text: async () => html,
  };
}

describe('page allowlist', () => {
  it('derives hosts from the site bindings only', () => {
    const allowed = hosts({
      ga4: { propertyId: '1', host: 'App.Example.com' },
      gsc: { siteUrl: 'https://example.com/' },
    });
    expect(allowed.exact.has('app.example.com')).toBe(true);
    expect(allowed.exact.has('example.com')).toBe(true);
    expect(allowed.domains.size).toBe(0);
  });

  it('treats a sc-domain property as covering its subdomains', () => {
    const allowed = hosts({ gsc: { siteUrl: 'sc-domain:example.com' } });
    expect(isAllowedHost('www.example.com', allowed)).toBe(true);
    expect(isAllowedHost('example.com', allowed)).toBe(true);
    // The dot boundary is the whole point: a lookalike registrable domain must not pass.
    expect(isAllowedHost('evil-example.com', allowed)).toBe(false);
    expect(isAllowedHost('example.com.attacker.test', allowed)).toBe(false);
  });

  it('rejects everything that is not a bound https host', () => {
    const allowed = hosts({ gsc: { siteUrl: 'https://example.com/' } });
    const rejected = [
      'https://evil-example.com/x',
      'http://example.com/x',
      'https://user:pass@example.com/x',
      'https://93.184.216.34/x',
      'https://localhost/x',
      'https://build.local/x',
      'not-a-url',
    ];
    for (const url of rejected) {
      expect(() => assertFetchable(url, allowed), url).toThrow();
    }
    expect(assertFetchable('https://example.com/ok', allowed).hostname).toBe('example.com');
  });
});

describe('page extraction', () => {
  const html = `<!doctype html><html><head>
    <title>  A perfectly    reasonable title </title>
    <meta name="description" content="Ninety characters of promise &amp; delivery.">
    <meta name='robots' content='index, follow'>
    <meta property="og:title" content="Social title">
    <link rel="stylesheet" href="/a.css"><link rel="canonical" href="https://example.com/a">
    </head><body><h1>The heading</h1><p>x</p></body></html>`;

  it('reads the facts a search result is built from', () => {
    const facts = extractPageFacts(html, transport);
    expect(facts.title).toBe('A perfectly reasonable title');
    expect(facts.titleLength).toBe(28);
    expect(facts.metaDescription).toBe('Ninety characters of promise & delivery.');
    expect(facts.robotsMeta).toBe('index, follow');
    expect(facts.ogTitle).toBe('Social title');
    expect(facts.canonical).toBe('https://example.com/a');
    expect(facts.h1s).toEqual(['The heading']);
    expect(facts.headTruncated).toBe(false);
  });

  it('leaves an absent tag undefined rather than empty', () => {
    const facts = extractPageFacts(
      '<html><head><title>t</title></head><body></body></html>',
      transport,
    );
    expect(facts.metaDescription).toBeUndefined();
    expect(facts.canonical).toBeUndefined();
    expect(facts.h1s).toEqual([]);
    expect('metaDescription' in facts).toBe(false);
  });

  it('flags a head it never reached the end of', () => {
    const facts = extractPageFacts('<html><head><title>t</title>', transport);
    expect(facts.headTruncated).toBe(true);
  });

  it('hashes what the page says, not the bytes it shipped', () => {
    const withChurn = html
      .replace('<p>x</p>', '<p>x</p><script>window.__BUILD__="c39f1"</script>')
      .replace('/a.css', '/a.css?v=8912');
    expect(extractPageFacts(withChurn, transport).contentHash).toBe(
      extractPageFacts(html, transport).contentHash,
    );

    const retitled = html.replace('A perfectly    reasonable title', 'A different title');
    expect(extractPageFacts(retitled, transport).contentHash).not.toBe(
      extractPageFacts(html, transport).contentHash,
    );
  });

  it('treats a page that starts failing as a change', () => {
    const ok = extractPageFacts(html, transport);
    const gone = extractPageFacts('', { ...transport, status: 404 });
    expect(gone.contentHash).not.toBe(ok.contentHash);
  });

  it('excludes the moment of capture from the hash', () => {
    const base = extractPageFacts(html, transport);
    const later = extractPageFacts(html, { ...transport, fetchedAt: '2026-06-01T00:00:00Z' });
    expect(later.contentHash).toBe(base.contentHash);
    expect(hashFacts(base)).toBe(base.contentHash);
  });
});

describe('page verdicts', () => {
  function facts(over: Partial<PageFacts>): PageFacts {
    return {
      url: 'https://example.com/a',
      fetchedAt: transport.fetchedAt,
      status: 200,
      title: 'A perfectly reasonable title',
      titleLength: 28,
      metaDescription: 'x'.repeat(120),
      metaDescriptionLength: 120,
      h1s: ['The heading'],
      headTruncated: false,
      contentHash: 'hash',
      ...over,
    };
  }
  const rules = (over: Partial<PageFacts>): string[] =>
    pageVerdicts(facts(over)).map((verdict) => verdict.rule);

  it('stays quiet on a page with nothing mechanically wrong', () => {
    expect(rules({})).toEqual([]);
  });

  it('stops at the redirect rather than judging a head it never read', () => {
    expect(rules({ status: 301, redirectTo: 'https://example.com/b' })).toEqual(['redirect']);
  });

  it('leads with the status when the page is not there', () => {
    expect(rules({ status: 404, title: undefined, titleLength: undefined })).toEqual(['status']);
  });

  it('names each mechanical fault', () => {
    expect(rules({ title: undefined, titleLength: undefined })).toContain('title-missing');
    expect(rules({ title: 'x'.repeat(72), titleLength: 72 })).toContain('title-long');
    expect(rules({ title: 'Short', titleLength: 5 })).toContain('title-short');
    expect(rules({ metaDescription: undefined, metaDescriptionLength: undefined })).toContain(
      'description-missing',
    );
    expect(rules({ metaDescription: 'x'.repeat(200), metaDescriptionLength: 200 })).toContain(
      'description-long',
    );
    expect(rules({ h1s: [] })).toContain('h1-missing');
    expect(rules({ h1s: ['a', 'b'] })).toContain('h1-multiple');
    expect(rules({ robotsMeta: 'noindex, nofollow' })).toContain('noindex');
    expect(rules({ canonical: 'https://example.com/other' })).toContain('canonical-elsewhere');
  });

  it('does not blame a page for a tag it could not read', () => {
    const truncated = rules({
      title: undefined,
      titleLength: undefined,
      h1s: [],
      headTruncated: true,
    });
    expect(truncated).toContain('title-missing');
    expect(truncated).not.toContain('h1-missing');
  });

  it('accepts a canonical that differs only by trailing slash', () => {
    expect(rules({ canonical: 'https://example.com/a/' })).not.toContain('canonical-elsewhere');
  });
});

describe('page fetch', () => {
  const allowed = hosts({ gsc: { siteUrl: 'https://example.com/' } });

  it('reports a redirect instead of following it', async () => {
    const calls: string[] = [];
    const fetchImpl: PageFetch = async (url, init) => {
      calls.push(url);
      expect(init.redirect).toBe('manual');
      return response(302, '', 'https://internal.attacker.test/');
    };
    const facts = await fetchPageSnapshot('https://example.com/a', allowed, { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(facts.status).toBe(302);
    expect(facts.redirectTo).toBe('https://internal.attacker.test/');
  });

  it('never opens a socket for a host outside the allowlist', async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchPageSnapshot('https://evil-example.com/a', allowed, { fetchImpl }),
    ).rejects.toThrow('not bound to this site');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns a failing status as a fact rather than an error', async () => {
    const facts = await fetchPageSnapshot('https://example.com/gone', allowed, {
      fetchImpl: async () => response(404, '<html><head></head><body>nope</body></html>'),
    });
    expect(facts.status).toBe(404);
    expect(pageVerdicts(facts).map((v) => v.rule)).toEqual(['status']);
  });

  it('stops reading at the end of the head', async () => {
    const chunks = [
      '<html><head><title>Read me</title></head>',
      '<body>' + 'x'.repeat(10_000) + '</body>',
    ];
    let delivered = 0;
    const facts = await fetchPageSnapshot('https://example.com/a', allowed, {
      fetchImpl: async () => ({
        status: 200,
        headers: { get: () => null },
        body: (async function* () {
          for (const chunk of chunks) {
            delivered += 1;
            yield new TextEncoder().encode(chunk);
          }
        })(),
      }),
    });
    expect(facts.title).toBe('Read me');
    expect(delivered).toBe(1);
  });

  it('gives up on a hung page instead of waiting forever', async () => {
    const fetchImpl: PageFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    await expect(
      fetchPageSnapshot('https://example.com/a', allowed, { fetchImpl, timeoutMs: 20 }),
    ).rejects.toThrow(/example\.com/);
  });
});
