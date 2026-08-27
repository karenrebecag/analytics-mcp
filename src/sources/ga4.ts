import type {
  AnalyticsSource,
  BindingFor,
  Env,
  QueryRequest,
  QueryResult,
  SchemaEntry,
} from './types.js';
import { GA4_SCOPE, getGoogleAccessToken, readGoogleJson } from './google-auth.js';
import { asRecord, fetchUpstream, resolveTimeout, type FetchLike } from './upstream.js';

const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';

export interface Ga4SourceOpts {
  env?: Env;
  fetchImpl?: FetchLike;
}

interface Ga4Metadata {
  metrics?: Array<{ apiName?: string; uiName?: string; description?: string }>;
  dimensions?: Array<{ apiName?: string; uiName?: string; description?: string }>;
}

interface Ga4Report {
  dimensionHeaders?: Array<{ name?: string }>;
  metricHeaders?: Array<{ name?: string }>;
  rows?: Array<{
    dimensionValues?: Array<{ value?: string }>;
    metricValues?: Array<{ value?: string }>;
  }>;
  metadata?: { timeZone?: string };
}

/**
 * A GA4 property normally receives from every subdomain at once, so without
 * this a site bound to one hostname silently reports the whole estate.
 */
function hostFilter(host?: string): Record<string, unknown> {
  if (!host) return {};
  return {
    dimensionFilter: {
      filter: {
        fieldName: 'hostName',
        stringFilter: { matchType: 'EXACT', value: host },
      },
    },
  };
}

function envOf(opts?: Ga4SourceOpts): Env {
  return opts?.env ?? process.env;
}

function fetchOf(opts?: Ga4SourceOpts): FetchLike {
  return opts?.fetchImpl ?? fetch;
}

function num(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function dateDimension(granularity: QueryRequest['granularity']): string | undefined {
  if (granularity === 'day') return 'date';
  if (granularity === 'week') return 'yearWeek';
  if (granularity === 'month') return 'yearMonth';
  return undefined;
}

export function createGa4Source(opts?: Ga4SourceOpts): AnalyticsSource<'ga4'> {
  return {
    id: 'ga4',
    authKind: 'http-api',
    isConfigured(env: Env): boolean {
      return Boolean(env.GA4_SERVICE_ACCOUNT_JSON?.trim());
    },
    async schema(binding?: BindingFor<'ga4'>): Promise<SchemaEntry[]> {
      if (!binding?.propertyId) {
        return [
          { name: 'screenPageViews', kind: 'metric', description: 'Page views' },
          { name: 'sessions', kind: 'metric', description: 'Sessions' },
          { name: 'totalUsers', kind: 'metric', description: 'Users' },
          { name: 'date', kind: 'dimension', description: 'Date (YYYYMMDD)' },
        ];
      }
      return fetchGa4Metadata(binding, opts);
    },
    async query(
      req: QueryRequest,
      binding: BindingFor<'ga4'>,
      timeoutMs?: number,
    ): Promise<QueryResult> {
      const grain = dateDimension(req.granularity);
      const dimensions = [
        ...(grain ? [grain] : []),
        ...(req.dimensions ?? []).filter((name) => name !== grain),
      ];
      const report = asRecord(
        'ga4',
        await runGa4(opts, binding, timeoutMs, {
          ...hostFilter(binding.host),
          dateRanges: [{ startDate: req.range.start, endDate: req.range.end }],
          metrics: req.metrics.map((name) => ({ name })),
          dimensions: dimensions.map((name) => ({ name })),
          limit: 10000,
        }),
      ) as Ga4Report;
      const dimNames = (report.dimensionHeaders ?? []).map((h) => h.name ?? '');
      const metNames = (report.metricHeaders ?? []).map((h) => h.name ?? '');
      const rows = (report.rows ?? []).map((row) => {
        const out: Record<string, string | number> = {};
        row.dimensionValues?.forEach((d, i) => {
          const key = dimNames[i];
          if (key) out[key] = d.value ?? '';
        });
        row.metricValues?.forEach((m, i) => {
          const key = metNames[i];
          if (key) out[key] = num(m.value);
        });
        return out;
      });
      return {
        source: 'ga4',
        timezone: report.metadata?.timeZone ?? 'UTC',
        rows,
      };
    },
    async queryRaw(
      body: unknown,
      binding: BindingFor<'ga4'>,
      timeoutMs?: number,
    ): Promise<unknown> {
      return runGa4(opts, binding, timeoutMs, body);
    },
  };
}

export async function fetchGa4Metadata(
  binding: BindingFor<'ga4'>,
  opts?: Ga4SourceOpts,
  timeoutMs?: number,
): Promise<SchemaEntry[]> {
  const env = envOf(opts);
  const fetchImpl = fetchOf(opts);
  const ms = resolveTimeout(timeoutMs);
  const token = await getGoogleAccessToken({
    json: readGoogleJson(env, 'GA4_SERVICE_ACCOUNT_JSON'),
    scope: GA4_SCOPE,
    fetchImpl,
    timeoutMs: ms,
  });
  const json = asRecord(
    'ga4',
    await fetchUpstream({
      source: 'ga4',
      url: `${DATA_API}/properties/${encodeURIComponent(binding.propertyId)}/metadata`,
      fetchImpl,
      timeoutMs: ms,
      headers: { Authorization: `Bearer ${token}` },
    }),
  ) as Ga4Metadata;
  const metrics: SchemaEntry[] = (json.metrics ?? []).map((m) => ({
    name: m.apiName ?? '',
    kind: 'metric' as const,
    description: m.description ?? m.uiName ?? '',
  }));
  const dimensions: SchemaEntry[] = (json.dimensions ?? []).map((d) => ({
    name: d.apiName ?? '',
    kind: 'dimension' as const,
    description: d.description ?? d.uiName ?? '',
  }));
  return [...metrics, ...dimensions].filter((e) => e.name);
}

async function runGa4(
  opts: Ga4SourceOpts | undefined,
  binding: BindingFor<'ga4'>,
  timeoutMs: number | undefined,
  body: unknown,
): Promise<unknown> {
  const env = envOf(opts);
  const fetchImpl = fetchOf(opts);
  const ms = resolveTimeout(timeoutMs);
  const token = await getGoogleAccessToken({
    json: readGoogleJson(env, 'GA4_SERVICE_ACCOUNT_JSON'),
    scope: GA4_SCOPE,
    fetchImpl,
    timeoutMs: ms,
  });
  return fetchUpstream({
    source: 'ga4',
    url: `${DATA_API}/properties/${encodeURIComponent(binding.propertyId)}:runReport`,
    fetchImpl,
    timeoutMs: ms,
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
