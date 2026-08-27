import type {
  AnalyticsSource,
  BindingFor,
  Env,
  QueryRequest,
  QueryResult,
  SchemaEntry,
} from './types.js';
import { asRecord, fetchUpstream, resolveTimeout, type FetchLike } from './upstream.js';

const API = 'https://api.vercel.com';

export interface VercelSourceOpts {
  env?: Env;
  fetchImpl?: FetchLike;
}

const SCHEMA: SchemaEntry[] = [
  { name: 'pageviews', kind: 'metric', description: 'Web Analytics page views' },
  { name: 'visitors', kind: 'metric', description: 'Web Analytics visitors' },
  { name: 'timestamp', kind: 'dimension', description: 'Bucket start (ISO)' },
];

interface CountResponse {
  data?: { pageviews?: number; visitors?: number };
}

interface AggregateResponse {
  data?: Array<
    { timestamp?: string; pageviews?: number; visitors?: number } & Record<string, unknown>
  >;
}

function envOf(opts?: VercelSourceOpts): Env {
  return opts?.env ?? process.env;
}

function fetchOf(opts?: VercelSourceOpts): FetchLike {
  return opts?.fetchImpl ?? fetch;
}

function url(path: string, binding: BindingFor<'vercel'>, extra: Record<string, string>): string {
  // queryRaw body.path is caller-controlled; an absolute URL would take the
  // Bearer token off api.vercel.com.
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) {
    throw new Error('vercel path must be a relative API path');
  }
  const u = new URL(path, API);
  if (u.protocol !== 'https:' || u.hostname !== 'api.vercel.com') {
    throw new Error('vercel path escaped api.vercel.com');
  }
  if (!u.pathname.startsWith('/v1/query/web-analytics/')) {
    throw new Error('vercel path must be a web-analytics endpoint');
  }
  u.searchParams.set('projectId', binding.projectId);
  if (binding.teamId) u.searchParams.set('teamId', binding.teamId);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
}

function byOf(granularity: QueryRequest['granularity']): string | undefined {
  if (granularity === 'day') return 'day';
  if (granularity === 'week') return 'week';
  if (granularity === 'month') return 'month';
  return undefined;
}

export function createVercelSource(opts?: VercelSourceOpts): AnalyticsSource<'vercel'> {
  return {
    id: 'vercel',
    authKind: 'http-api',
    isConfigured(env: Env): boolean {
      return Boolean(env.VERCEL_API_TOKEN?.trim());
    },
    async schema(): Promise<SchemaEntry[]> {
      return SCHEMA;
    },
    async query(
      req: QueryRequest,
      binding: BindingFor<'vercel'>,
      timeoutMs?: number,
    ): Promise<QueryResult> {
      const env = envOf(opts);
      const token = env.VERCEL_API_TOKEN;
      if (!token) throw new Error('VERCEL_API_TOKEN is not set');
      const headers = { Authorization: `Bearer ${token}` };
      const ms = resolveTimeout(timeoutMs);
      const fetchImpl = fetchOf(opts);
      const extra: Record<string, string> = {
        since: req.range.start,
        until: req.range.end,
      };
      const grouped = byOf(req.granularity);
      if (grouped) extra.by = grouped;
      if (req.dimensions?.[0])
        extra.by = extra.by ? `${extra.by},${req.dimensions[0]}` : req.dimensions[0];

      if (!grouped) {
        const json = asRecord(
          'vercel',
          await fetchUpstream({
            source: 'vercel',
            url: url('/v1/query/web-analytics/visits/count', binding, extra),
            fetchImpl,
            timeoutMs: ms,
            headers,
          }),
        ) as CountResponse;
        return {
          source: 'vercel',
          timezone: 'UTC',
          rows: [
            {
              pageviews: json.data?.pageviews ?? 0,
              visitors: json.data?.visitors ?? 0,
            },
          ],
        };
      }

      const json = asRecord(
        'vercel',
        await fetchUpstream({
          source: 'vercel',
          url: url('/v1/query/web-analytics/visits/aggregate', binding, extra),
          fetchImpl,
          timeoutMs: ms,
          headers,
        }),
      ) as AggregateResponse;
      const rows = (json.data ?? []).map((row) => {
        const out: Record<string, string | number> = {
          pageviews: typeof row.pageviews === 'number' ? row.pageviews : 0,
          visitors: typeof row.visitors === 'number' ? row.visitors : 0,
        };
        if (row.timestamp) out.timestamp = row.timestamp;
        for (const [k, v] of Object.entries(row)) {
          if (k === 'pageviews' || k === 'visitors' || k === 'timestamp') continue;
          if (typeof v === 'string' || typeof v === 'number') out[k] = v;
        }
        return out;
      });
      return { source: 'vercel', timezone: 'UTC', rows };
    },
    async queryRaw(
      body: unknown,
      binding: BindingFor<'vercel'>,
      timeoutMs?: number,
    ): Promise<unknown> {
      const env = envOf(opts);
      const token = env.VERCEL_API_TOKEN;
      if (!token) throw new Error('VERCEL_API_TOKEN is not set');
      const rec =
        typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      const path = typeof rec.path === 'string' ? rec.path : '/v1/query/web-analytics/visits/count';
      const extra: Record<string, string> = {};
      if (typeof rec.query === 'object' && rec.query !== null) {
        for (const [k, v] of Object.entries(rec.query as Record<string, unknown>)) {
          if (typeof v === 'string') extra[k] = v;
        }
      }
      return fetchUpstream({
        source: 'vercel',
        url: url(path, binding, extra),
        fetchImpl: fetchOf(opts),
        timeoutMs: resolveTimeout(timeoutMs),
        headers: { Authorization: `Bearer ${token}` },
      });
    },
  };
}
