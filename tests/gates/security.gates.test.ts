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
