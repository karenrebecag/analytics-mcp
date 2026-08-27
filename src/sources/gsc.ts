import type {
  AnalyticsSource,
  BindingFor,
  Env,
  QueryRequest,
  QueryResult,
  SchemaEntry,
} from './types.js';
import { GSC_SCOPE, getGoogleAccessToken, readGoogleJson } from './google-auth.js';
import { asRecord, fetchUpstream, resolveTimeout, type FetchLike } from './upstream.js';

const SITES_URL = 'https://www.googleapis.com/webmasters/v3/sites';

export interface GscSourceOpts {
  env?: Env;
  fetchImpl?: FetchLike;
}

const SCHEMA: SchemaEntry[] = [
  { name: 'clicks', kind: 'metric', description: 'Search clicks' },
  { name: 'impressions', kind: 'metric', description: 'Search impressions' },
  { name: 'ctr', kind: 'metric', description: 'Click-through rate' },
  { name: 'position', kind: 'metric', description: 'Average position' },
  { name: 'date', kind: 'dimension', description: 'Date' },
  { name: 'query', kind: 'dimension', description: 'Search query' },
  { name: 'page', kind: 'dimension', description: 'Page URL' },
  { name: 'country', kind: 'dimension', description: 'Country' },
  { name: 'device', kind: 'dimension', description: 'Device' },
];

interface GscQueryResponse {
  rows?: Array<{
    keys?: string[];
    clicks?: number;
    impressions?: number;
    ctr?: number;
    position?: number;
  }>;
}

function envOf(opts?: GscSourceOpts): Env {
  return opts?.env ?? process.env;
}

function fetchOf(opts?: GscSourceOpts): FetchLike {
  return opts?.fetchImpl ?? fetch;
}

function gscJson(env: Env): string {
  return readGoogleJson(env, 'GSC_SERVICE_ACCOUNT_JSON', 'GA4_SERVICE_ACCOUNT_JSON');
}

export function createGscSource(opts?: GscSourceOpts): AnalyticsSource<'gsc'> {
  return {
    id: 'gsc',
    authKind: 'http-api',
    isConfigured(env: Env): boolean {
      return Boolean(env.GSC_SERVICE_ACCOUNT_JSON?.trim() || env.GA4_SERVICE_ACCOUNT_JSON?.trim());
    },
    async schema(): Promise<SchemaEntry[]> {
      return SCHEMA;
    },
    async query(
      req: QueryRequest,
      binding: BindingFor<'gsc'>,
      timeoutMs?: number,
    ): Promise<QueryResult> {
      const dimensions = [
        ...(req.granularity !== 'total' && !(req.dimensions ?? []).includes('date')
          ? ['date']
          : []),
        ...(req.dimensions ?? []),
      ];
      const json = asRecord(
        'gsc',
        await gscPost(opts, binding, timeoutMs, {
          startDate: req.range.start,
          endDate: req.range.end,
          dimensions,
          rowLimit: 1000,
        }),
      ) as GscQueryResponse;
      const rows = (json.rows ?? []).map((row) => {
        const out: Record<string, string | number> = {
          clicks: row.clicks ?? 0,
          impressions: row.impressions ?? 0,
          ctr: row.ctr ?? 0,
          position: row.position ?? 0,
        };
        row.keys?.forEach((key, i) => {
          const name = dimensions[i];
          if (name) out[name] = key;
        });
        return out;
      });
      return { source: 'gsc', timezone: 'UTC', rows };
    },
    async queryRaw(
      body: unknown,
      binding: BindingFor<'gsc'>,
      timeoutMs?: number,
    ): Promise<unknown> {
      return gscPost(opts, binding, timeoutMs, body);
    },
  };
}

async function gscPost(
  opts: GscSourceOpts | undefined,
  binding: BindingFor<'gsc'>,
  timeoutMs: number | undefined,
  body: unknown,
): Promise<unknown> {
  const env = envOf(opts);
  const fetchImpl = fetchOf(opts);
  const ms = resolveTimeout(timeoutMs);
  const token = await getGoogleAccessToken({
    json: gscJson(env),
    scope: GSC_SCOPE,
    fetchImpl,
    timeoutMs: ms,
  });
  return fetchUpstream({
    source: 'gsc',
    url: `${SITES_URL}/${encodeURIComponent(binding.siteUrl)}/searchAnalytics/query`,
    fetchImpl,
    timeoutMs: ms,
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
