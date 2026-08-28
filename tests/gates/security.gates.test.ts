import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnInitialized } from './helpers.js';
import { writeCapture } from '../../scripts/probe.js';
import { createCloudflareSource } from '../../dist/sources/cloudflare.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const FAKE_TOKEN = 'fake-secret-123';
const FAKE_CF = 'cf-fake-secret-abc';
const FAKE_VERCEL = 'vercel-fake-secret-xyz';
const FAKE_SIGNING = 'fake-signing-secret-999';
const FAKE_SECRETS = [FAKE_TOKEN, FAKE_CF, FAKE_VERCEL, FAKE_SIGNING];

const EXAMPLE_SITES = fs.readFileSync(path.join(ROOT, 'sites.example.json'), 'utf8');

describe('S-F0-1 gitignore coverage', () => {
  it('covers credential, scratch and build paths', () => {
    const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    for (const pattern of ['.env', '.env.*', 'sites.config.json', 'scratch/', 'dist/']) {
      expect(gitignore).toContain(pattern);
    }
  });
});

describe('S-F0-2 secrets never appear in tool output', () => {
  it('keeps fake env secrets out of tools/list and list_sources', async () => {
    const { client } = await spawnInitialized({
      UPSTASH_REDIS_REST_TOKEN: FAKE_TOKEN,
      CLOUDFLARE_API_TOKEN: FAKE_CF,
      VERCEL_API_TOKEN: FAKE_VERCEL,
      MCP_SIGNING_SECRET: FAKE_SIGNING,
      SITES_CONFIG: EXAMPLE_SITES,
    });
    try {
      const listed = await client.request('tools/list');
      const sources = await client.request('tools/call', {
        name: 'list_sources',
        arguments: {},
      });
      const blob = `${JSON.stringify(listed)}\n${JSON.stringify(sources)}`;
      for (const secret of FAKE_SECRETS) {
        expect(blob).not.toContain(secret);
      }
    } finally {
      await client.kill();
    }
  });
});

describe('S-F0-3 no credential material in tracked files', () => {
  it('rejects private keys, Google API keys and bearer-like strings', () => {
    const tracked = gitFiles(['ls-files', '-z']);
    const unignored = gitFiles(['ls-files', '-z', '--others', '--exclude-standard']);
    const files = [...new Set([...tracked, ...unignored])];
    const pem = /-----BEGIN[A-Z0-9 ]*PRIVATE KEY/;
    const google = /AIza[0-9A-Za-z_-]{35}/;
    const bearer = /\bBearer\s+[A-Za-z0-9\-._~+/]{24,}={0,2}/;

    const hits: string[] = [];
    for (const rel of files) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) continue;
      const buf = fs.readFileSync(abs);
      if (buf.includes(0)) continue;
      const text = buf.toString('utf8');
      if (pem.test(text) || google.test(text) || bearer.test(text)) {
        hits.push(rel);
      }
    }
    expect(hits).toEqual([]);
  });

  it('greps docs for forbidden org terms when GATES_FORBIDDEN_TERMS_FILE is set', () => {
    const termsFile = process.env.GATES_FORBIDDEN_TERMS_FILE;
    if (!termsFile) return;
    const terms = fs
      .readFileSync(termsFile, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    if (terms.length === 0) return;

    const docs = gitFiles(['ls-files', '-z']).filter((rel) => /\.(md|txt|html)$/i.test(rel));
    const hits: string[] = [];
    for (const rel of docs) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      for (const term of terms) {
        if (text.toLowerCase().includes(term.toLowerCase())) {
          hits.push(`${rel}: ${term}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

function gitFiles(args: string[]): string[] {
  const out = execFileSync('git', args, { cwd: ROOT });
  return out.toString('utf8').split('\0').filter(Boolean);
}

describe('S-F2-1 query_raw source allowlist', () => {
  it('rejects a source id outside SOURCE_IDS and lists valid ids', async () => {
    const { client } = await spawnInitialized({ SITES_CONFIG: EXAMPLE_SITES });
    try {
      let blob: string;
      try {
        blob = JSON.stringify(
          await client.request('tools/call', {
            name: 'query_raw',
            arguments: { source: 'not-a-source', site: 'marketing-site', body: {} },
          }),
        );
      } catch (err) {
        blob = err instanceof Error ? err.message : String(err);
      }
      expect(blob).toMatch(/ga4/);
      expect(blob).toMatch(/cloudflare/);
      expect(blob).toMatch(/vercel/);
      expect(blob).toMatch(/gsc/);
    } finally {
      await client.kill();
    }
  });
});

describe('S-F1-1 writeCapture stays under scratch/', () => {
  it('rejects traversal', () => {
    expect(() => writeCapture('../x', { n: 1 })).toThrow(/bare file stem|escapes scratch/);
  });
});

describe('S-F1-2 adapter errors truncate body and omit Authorization', () => {
  it('keeps a 10KB upstream body and bearer header out of the thrown message', async () => {
    const headerValue = 'gate-auth-header-value-1234567890';
    const source = createCloudflareSource({
      env: { CLOUDFLARE_API_TOKEN: headerValue, CLOUDFLARE_ACCOUNT_ID: 'acct_test' },
      fetchImpl: async (_url, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        expect(headers?.Authorization).toBe(`Bearer ${headerValue}`);
        return new Response('A'.repeat(10_000), { status: 502 });
      },
    });
    await expect(
      source.query(
        {
          siteId: 's',
          range: { start: '2026-08-20', end: '2026-08-26' },
          granularity: 'total',
          metrics: ['pageviews'],
        },
        { zoneId: '0123456789abcdef0123456789abcdef' },
      ),
    ).rejects.toSatisfy((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      return (
        message.length <= 400 &&
        !message.includes(headerValue) &&
        message.startsWith('cloudflare 502:')
      );
    });
  });
});

describe('S-F25-1 semantic layer carries no site-specific values', () => {
  it('keeps knowledge.ts free of site identifiers and per-site numbers', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'src/semantics/knowledge.ts'), 'utf8');
    // Comments legitimately name the config that overrides this module; the
    // invariant is that no CODE reads it. Strip comments, then assert.
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/loadSites|SITES_CONFIG|getSite/);
    // Identifier shapes that would mean a real property, zone or project leaked in.
    expect(source).not.toMatch(/\bproperties\/\d+/);
    expect(source).not.toMatch(/\bprj_[A-Za-z0-9]{8,}/);
    expect(source).not.toMatch(/\b[0-9a-f]{32}\b/);
    expect(source).not.toMatch(/sc-domain:/);
  });

  it('reaches per-site expectations only through runtime config', async () => {
    const { client } = await spawnInitialized({ SITES_CONFIG: EXAMPLE_SITES });
    try {
      const generic = JSON.stringify(
        await client.request('resources/read', { uri: 'analytics://metrics' }),
      );
      // The generic document must not carry the example site's measured gap.
      expect(generic).not.toContain('marketing-site');
      const scoped = JSON.stringify(
        await client.request('resources/read', { uri: 'analytics://metrics/marketing-site' }),
      );
      expect(scoped).toContain('siteExpectations');
    } finally {
      await client.kill();
    }
  });
});

describe('S-F6-1 the SEO layer judges only against the caller own data', () => {
  it('reads no env or config, and carries no benchmark table', () => {
    const files = ['ctr-curve.ts', 'opportunities.ts', 'ai-sources.ts'].map((f) =>
      fs.readFileSync(path.join(ROOT, 'src/seo', f), 'utf8'),
    );
    for (const raw of files) {
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code).not.toMatch(/process\.env/);
      expect(code).not.toMatch(/loadSites|SITES_CONFIG|getSite/);
      // An imported CTR-by-position table would look like a literal array of
      // rates. The curve must be computed, never declared.
      expect(code).not.toMatch(/0\.\d+\s*,\s*0\.\d+\s*,\s*0\.\d+/);
    }
  });

  it('returns no expectation when the caller data is too thin', async () => {
    const { buildCtrCurve, expectedCtr } = await import('../../dist/seo/ctr-curve.js');
    const thin = buildCtrCurve([{ page: '/a', clicks: 3, impressions: 60, position: 4 }]);
    expect(expectedCtr(thin, 4)).toBeUndefined();
  });
});

const PAGE_SITES = JSON.stringify([
  {
    id: 'marketing-site',
    name: 'Marketing website',
    sources: { gsc: { siteUrl: 'sc-domain:example.com' } },
  },
]);

async function withPageSites<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.SITES_CONFIG;
  process.env.SITES_CONFIG = PAGE_SITES;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.SITES_CONFIG;
    else process.env.SITES_CONFIG = previous;
  }
}

describe('S-F8-1 page fetch never reaches an unbound host', () => {
  it('rejects lookalikes, literal addresses, http and userinfo without opening a socket', async () => {
    const { setPageFetchForTests } = await import('../../dist/page/fetch.js');
    const { handleInspectPage } = await import('../../dist/tools/inspect-page.js');

    let calls = 0;
    setPageFetchForTests(async () => {
      calls += 1;
      throw new Error('the allowlist let this through');
    });

    try {
      await withPageSites(async () => {
        const refused = [
          'https://evil-example.com/a',
          'https://example.com.attacker.test/a',
          'http://example.com/a',
          'https://user:pass@example.com/a',
          'https://93.184.216.34/a',
          'https://localhost/a',
        ];
        for (const url of refused) {
          const result = await handleInspectPage({ site: 'marketing-site', url });
          expect(result.isError, url).toBe(true);
        }
        expect(calls).toBe(0);
      });
    } finally {
      setPageFetchForTests(null);
    }
  });
});

describe('S-F8-2 a redirect is reported, never followed', () => {
  it('stops at the 3xx and does not request the target', async () => {
    const { setPageFetchForTests, setHostLookupForTests } =
      await import('../../dist/page/fetch.js');
    const { handleInspectPage } = await import('../../dist/tools/inspect-page.js');

    setHostLookupForTests(async () => [{ address: '93.184.216.34' }]);
    const requested: string[] = [];
    setPageFetchForTests(async (url, init) => {
      requested.push(url);
      expect(init.redirect).toBe('manual');
      return {
        status: 302,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'location' ? 'https://internal.attacker.test/admin' : null,
        },
        text: async () => '',
      };
    });

    try {
      await withPageSites(async () => {
        const result = await handleInspectPage({
          site: 'marketing-site',
          url: 'https://example.com/a',
        });
        expect(result.isError).toBeFalsy();
        const payload = JSON.parse(String(result.content[0]?.text)) as {
          facts: { redirectTo?: string };
        };
        expect(payload.facts.redirectTo).toBe('https://internal.attacker.test/admin');
        expect(requested).toEqual(['https://example.com/a']);
      });
    } finally {
      setPageFetchForTests(null);
      setHostLookupForTests(null);
    }
  });
});

describe('S-F8-3 a bound name pointing inward is still refused', () => {
  it('refuses a subdomain that resolves to a private address', async () => {
    const { setPageFetchForTests, setHostLookupForTests } =
      await import('../../dist/page/fetch.js');
    const { handleInspectPage } = await import('../../dist/tools/inspect-page.js');

    let calls = 0;
    setPageFetchForTests(async () => {
      calls += 1;
      throw new Error('the address guard let this through');
    });
    // The name is inside the sc-domain scope; only its address disqualifies it.
    setHostLookupForTests(async () => [{ address: '169.254.169.254' }]);

    try {
      await withPageSites(async () => {
        const result = await handleInspectPage({
          site: 'marketing-site',
          url: 'https://old-campaign.example.com/',
        });
        expect(result.isError).toBe(true);
        expect(String(result.content[0]?.text)).toContain('private address');
        expect(calls).toBe(0);
      });
    } finally {
      setPageFetchForTests(null);
      setHostLookupForTests(null);
    }
  });
});
