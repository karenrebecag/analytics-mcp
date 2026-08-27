/**
 * F1 recon. Hits the cheapest real read per configured source and writes the
 * raw JSON under scratch/ so adapters can be typed against captures, not docs.
 *
 * Never prints tokens — only env var names. Exit 1 if a configured source fails.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSites } from '../src/config/sites.js';
import {
  GA4_SCOPE,
  GSC_SCOPE,
  getGoogleAccessToken,
  readGoogleJson,
} from '../src/sources/google-auth.js';
import { DEFAULT_TIMEOUT_MS, fetchUpstream } from '../src/sources/upstream.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = resolve(ROOT, 'scratch');

const green = (m: string) => `\x1b[32m✓\x1b[0m ${m}`;
const red = (m: string) => `\x1b[31m✗\x1b[0m ${m}`;
const dim = (m: string) => `\x1b[2m${m}\x1b[0m`;

export function writeCapture(name: string, data: unknown): string {
  if (!name || /[\\/\0]/.test(name) || name.includes('..') || isAbsolute(name)) {
    throw new Error('capture name must be a bare file stem under scratch/');
  }
  mkdirSync(SCRATCH, { recursive: true });
  const dest = resolve(SCRATCH, `${name}.json`);
  const rel = relative(SCRATCH, dest);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('capture path escapes scratch/');
  }
  writeFileSync(dest, JSON.stringify(data, null, 2), 'utf8');
  return dest;
}

function loadDotEnv(): void {
  let raw: string;
  try {
    raw = readFileSync(join(ROOT, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function hydrateGoogleJsonFromPath(): void {
  if (process.env.GA4_SERVICE_ACCOUNT_JSON) return;
  const path = process.env.GA_SA_KEY_PATH?.trim();
  if (!path) return;
  try {
    process.env.GA4_SERVICE_ACCOUNT_JSON = readFileSync(path, 'utf8');
  } catch {
    // Presence of the path var is not a credential; adapters still see unset JSON.
  }
}

function present(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

async function probe(label: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    const data = await fn();
    const dest = writeCapture(label, data);
    process.stdout.write(`  ${green(label)}  ${dim(relative(ROOT, dest))}\n`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`  ${red(`${label} — ${msg.slice(0, 160)}`)}\n`);
    return false;
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  hydrateGoogleJsonFromPath();
  const sites = loadSites(process.env);
  const ga4Property = sites.find((s) => s.sources.ga4)?.sources.ga4?.propertyId;
  const cfZone = sites.find((s) => s.sources.cloudflare)?.sources.cloudflare?.zoneId;
  const vercelProject = sites.find((s) => s.sources.vercel)?.sources.vercel;
  const timeoutMs = DEFAULT_TIMEOUT_MS;
  const fetchImpl = fetch;

  process.stdout.write('\n══ F1 · source recon ══\n\n');

  let configuredFailed = false;

  const ga4Configured = present('GA4_SERVICE_ACCOUNT_JSON');
  if (!ga4Configured) {
    process.stdout.write(`  ${dim('ga4 skipped (GA4_SERVICE_ACCOUNT_JSON unset)')}\n`);
  } else if (!ga4Property) {
    process.stdout.write(`  ${red('ga4 — SITES_CONFIG has no ga4.propertyId')}\n`);
    configuredFailed = true;
  } else {
    const json = readGoogleJson(process.env, 'GA4_SERVICE_ACCOUNT_JSON');
    const token = await getGoogleAccessToken({ json, scope: GA4_SCOPE, fetchImpl, timeoutMs });
    const ok = await probe('ga4-metadata', () =>
      fetchUpstream({
        source: 'ga4',
        url: `https://analyticsdata.googleapis.com/v1beta/properties/${ga4Property}/metadata`,
        fetchImpl,
        timeoutMs,
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    if (!ok) configuredFailed = true;
    else {
      await probe('ga4-runReport', () =>
        fetchUpstream({
          source: 'ga4',
          url: `https://analyticsdata.googleapis.com/v1beta/properties/${ga4Property}:runReport`,
          fetchImpl,
          timeoutMs,
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
            metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }, { name: 'totalUsers' }],
            dimensions: [{ name: 'date' }],
            limit: 3,
          }),
        }),
      );
    }
  }

  const cfConfigured = present('CLOUDFLARE_API_TOKEN');
  if (!cfConfigured) {
    process.stdout.write(`  ${dim('cloudflare skipped (CLOUDFLARE_API_TOKEN unset)')}\n`);
  } else {
    const headers = {
      Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
    };
    const gql = async (query: string, variables: Record<string, unknown>) => {
      const json = await fetchUpstream({
        source: 'cloudflare',
        url: 'https://api.cloudflare.com/client/v4/graphql',
        fetchImpl,
        timeoutMs,
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
      });
      if (
        typeof json === 'object' &&
        json !== null &&
        'errors' in json &&
        (json as { errors?: unknown }).errors
      ) {
        const errs = (json as { errors: Array<{ message?: string }> }).errors;
        throw new Error(errs.map((e) => e.message ?? 'graphql error').join('; '));
      }
      return json;
    };
    const until = new Date();
    const since = new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000);
    const accountTag = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
    // Cheapest authorized read: account RUM when CLOUDFLARE_ACCOUNT_ID is set;
    // zone http requires Zone Analytics:Read which some tokens omit.
    let cfOk = false;
    if (accountTag) {
      cfOk = await probe('cloudflare-viewer', () =>
        gql(
          `query ProbeRum($accountTag: String!, $since: Time!, $until: Time!) {
            viewer {
              accounts(filter: { accountTag: $accountTag }) {
                rumPageloadEventsAdaptiveGroups(
                  limit: 1
                  filter: { datetime_geq: $since, datetime_lt: $until }
                ) {
                  count
                  sum { visits }
                }
                rumWebVitalsEventsAdaptiveGroups(
                  limit: 1
                  filter: { datetime_geq: $since, datetime_lt: $until }
                ) {
                  count
                  quantiles {
                    largestContentfulPaintP75
                    cumulativeLayoutShiftP75
                    interactionToNextPaintP75
                  }
                }
              }
            }
          }`,
          { accountTag, since: since.toISOString(), until: until.toISOString() },
        ),
      );
    } else if (cfZone) {
      cfOk = await probe('cloudflare-viewer', () =>
        gql(
          `query ProbeZone($zoneTag: String!) {
            viewer { zones(filter: { zoneTag: $zoneTag }) { zoneTag } }
          }`,
          { zoneTag: cfZone },
        ),
      );
    } else {
      process.stdout.write(
        `  ${red('cloudflare — SITES_CONFIG has no cloudflare.zoneId and CLOUDFLARE_ACCOUNT_ID unset')}\n`,
      );
    }
    if (!cfOk) configuredFailed = true;
    if (cfZone) {
      await probe('cloudflare-http', () =>
        gql(
          `query ProbeHttp($zoneTag: String!, $since: Date!, $until: Date!) {
            viewer {
              zones(filter: { zoneTag: $zoneTag }) {
                httpRequests1dGroups(
                  limit: 3
                  orderBy: [date_DESC]
                  filter: { date_geq: $since, date_lt: $until }
                ) {
                  dimensions { date }
                  sum { requests bytes cachedRequests }
                  uniq { uniques }
                }
              }
            }
          }`,
          {
            zoneTag: cfZone,
            since: since.toISOString().slice(0, 10),
            until: until.toISOString().slice(0, 10),
          },
        ),
      );
    }
  }

  const vercelConfigured = present('VERCEL_API_TOKEN');
  if (!vercelConfigured) {
    process.stdout.write(`  ${dim('vercel skipped (VERCEL_API_TOKEN unset)')}\n`);
  } else {
    const headers = { Authorization: `Bearer ${process.env.VERCEL_API_TOKEN}` };
    const team = vercelProject?.teamId;
    const qs = (path: string, extra: Record<string, string> = {}) => {
      const u = new URL(path, 'https://api.vercel.com');
      if (team) u.searchParams.set('teamId', team);
      for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
      return u.toString();
    };
    const ok = await probe('vercel-projects', () =>
      fetchUpstream({
        source: 'vercel',
        url: qs('https://api.vercel.com/v9/projects', { limit: '2' }),
        fetchImpl,
        timeoutMs,
        headers,
      }),
    );
    if (!ok) configuredFailed = true;
    if (ok && vercelProject?.projectId) {
      const until = new Date();
      const since = new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000);
      await probe('vercel-visits-count', () =>
        fetchUpstream({
          source: 'vercel',
          url: qs('https://api.vercel.com/v1/query/web-analytics/visits/count', {
            projectId: vercelProject.projectId,
          }),
          fetchImpl,
          timeoutMs,
          headers,
        }),
      );
      await probe('vercel-visits-aggregate', () =>
        fetchUpstream({
          source: 'vercel',
          url: qs('https://api.vercel.com/v1/query/web-analytics/visits/aggregate', {
            projectId: vercelProject.projectId,
            since: since.toISOString().slice(0, 10),
            until: until.toISOString().slice(0, 10),
            by: 'day',
          }),
          fetchImpl,
          timeoutMs,
          headers,
        }),
      );
    }
  }

  const gscConfigured = present('GSC_SERVICE_ACCOUNT_JSON') || ga4Configured;
  if (!gscConfigured) {
    process.stdout.write(
      `  ${dim('gsc skipped (GSC_SERVICE_ACCOUNT_JSON/GA4_SERVICE_ACCOUNT_JSON unset)')}\n`,
    );
  } else {
    const json = present('GSC_SERVICE_ACCOUNT_JSON')
      ? readGoogleJson(process.env, 'GSC_SERVICE_ACCOUNT_JSON')
      : readGoogleJson(process.env, 'GA4_SERVICE_ACCOUNT_JSON');
    const token = await getGoogleAccessToken({ json, scope: GSC_SCOPE, fetchImpl, timeoutMs });
    const ok = await probe('gsc-sites', () =>
      fetchUpstream({
        source: 'gsc',
        url: 'https://www.googleapis.com/webmasters/v3/sites',
        fetchImpl,
        timeoutMs,
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    if (!ok) configuredFailed = true;
    const gscSite = sites.find((s) => s.sources.gsc)?.sources.gsc?.siteUrl;
    if (ok && gscSite) {
      await probe('gsc-searchanalytics', () =>
        fetchUpstream({
          source: 'gsc',
          url: `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(gscSite)}/searchAnalytics/query`,
          fetchImpl,
          timeoutMs,
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
            endDate: new Date().toISOString().slice(0, 10),
            dimensions: ['date'],
            rowLimit: 3,
          }),
        }),
      );
    }
  }

  process.stdout.write('\n');
  if (configuredFailed) {
    process.stdout.write('configured source failed\n');
    process.exit(1);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
