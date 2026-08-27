import type {
  AnalyticsSource,
  BindingFor,
  Env,
  QueryRequest,
  QueryResult,
  SchemaEntry,
} from './types.js';
import {
  asRecord,
  fetchUpstream,
  resolveTimeout,
  upstreamError,
  type FetchLike,
} from './upstream.js';

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';

export interface CloudflareSourceOpts {
  env?: Env;
  fetchImpl?: FetchLike;
}

const SCHEMA: SchemaEntry[] = [
  { name: 'pageviews', kind: 'metric', description: 'RUM pageload events' },
  { name: 'visits', kind: 'metric', description: 'RUM visits' },
  { name: 'requests', kind: 'metric', description: 'Zone HTTP requests' },
  { name: 'uniques', kind: 'metric', description: 'Zone unique visitors' },
  { name: 'lcp', kind: 'metric', description: 'LCP p75 (microseconds)' },
  { name: 'cls', kind: 'metric', description: 'CLS p75' },
  { name: 'inp', kind: 'metric', description: 'INP p75 (microseconds)' },
  { name: 'date', kind: 'dimension', description: 'Date' },
];

interface GraphqlEnvelope {
  data?: {
    viewer?: {
      accounts?: Array<{
        rumPageloadEventsAdaptiveGroups?: Array<{
          count?: number;
          sum?: { visits?: number };
          dimensions?: { date?: string };
        }>;
        rumWebVitalsEventsAdaptiveGroups?: Array<{
          count?: number;
          quantiles?: {
            largestContentfulPaintP75?: number | null;
            cumulativeLayoutShiftP75?: number | null;
            interactionToNextPaintP75?: number | null;
          };
        }>;
      }>;
      zones?: Array<{
        httpRequests1dGroups?: Array<{
          dimensions?: { date?: string };
          sum?: { requests?: number; bytes?: number; cachedRequests?: number };
          uniq?: { uniques?: number };
        }>;
      }>;
    };
  };
  errors?: Array<{ message?: string }> | null;
}

function envOf(opts?: CloudflareSourceOpts): Env {
  return opts?.env ?? process.env;
}

function fetchOf(opts?: CloudflareSourceOpts): FetchLike {
  return opts?.fetchImpl ?? fetch;
}

/** DateRange.end is inclusive; CF HTTP filter is date_lt. */
function nextUtcDay(isoDate: string): string {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(ms)) return isoDate;
  return new Date(ms + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function pinGraphqlBinding(body: unknown, binding: BindingFor<'cloudflare'>, env: Env): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const rec = body as { query?: unknown; variables?: unknown };
  if (typeof rec.query === 'string' && /\b(mutation|subscription)\b/i.test(rec.query)) {
    throw new Error('cloudflare queryRaw only accepts GraphQL queries');
  }
  const variables =
    typeof rec.variables === 'object' && rec.variables !== null
      ? { ...(rec.variables as Record<string, unknown>) }
      : {};
  variables.zoneTag = binding.zoneId;
  const accountTag = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (accountTag) variables.accountTag = accountTag;
  return { ...rec, variables };
}

function hostBits(host?: string): { decl: string; filter: string; vars: Record<string, unknown> } {
  if (!host) return { decl: '', filter: '', vars: {} };
  return { decl: ', $host: String!', filter: ', requestHost: $host', vars: { host } };
}

export function createCloudflareSource(opts?: CloudflareSourceOpts): AnalyticsSource<'cloudflare'> {
  return {
    id: 'cloudflare',
    authKind: 'http-api',
    isConfigured(env: Env): boolean {
      return Boolean(env.CLOUDFLARE_API_TOKEN?.trim());
    },
    async schema(): Promise<SchemaEntry[]> {
      return SCHEMA;
    },
    async query(
      req: QueryRequest,
      binding: BindingFor<'cloudflare'>,
      timeoutMs?: number,
    ): Promise<QueryResult> {
      const env = envOf(opts);
      const accountTag = env.CLOUDFLARE_ACCOUNT_ID?.trim();
      if (accountTag) {
        return rumQuery(opts, req, binding, accountTag, timeoutMs);
      }
      return httpQuery(opts, req, binding, timeoutMs);
    },
    async queryRaw(
      body: unknown,
      binding: BindingFor<'cloudflare'>,
      timeoutMs?: number,
    ): Promise<unknown> {
      return graphql(opts, pinGraphqlBinding(body, binding, envOf(opts)), timeoutMs);
    },
  };
}

async function rumQuery(
  opts: CloudflareSourceOpts | undefined,
  req: QueryRequest,
  binding: BindingFor<'cloudflare'>,
  accountTag: string,
  timeoutMs?: number,
): Promise<QueryResult> {
  const byDay = req.granularity === 'day';
  const host = hostBits(binding.host);
  const query = `
    query Rum($accountTag: String!, $since: Time!, $until: Time!${host.decl}) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          rumPageloadEventsAdaptiveGroups(
            limit: ${byDay ? 40 : 1}
            ${byDay ? 'orderBy: [date_ASC]' : ''}
            filter: { datetime_geq: $since, datetime_lt: $until${host.filter} }
          ) {
            count
            sum { visits }
            ${byDay ? 'dimensions { date }' : ''}
          }
          rumWebVitalsEventsAdaptiveGroups(
            limit: 1
            filter: { datetime_geq: $since, datetime_lt: $until${host.filter} }
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
    }`;
  const json = (await graphql(
    opts,
    {
      query,
      variables: {
        accountTag,
        since: `${req.range.start}T00:00:00Z`,
        until: `${req.range.end}T23:59:59Z`,
        ...host.vars,
      },
    },
    timeoutMs,
  )) as GraphqlEnvelope;
  const account = json.data?.viewer?.accounts?.[0];
  const vitals = account?.rumWebVitalsEventsAdaptiveGroups?.[0]?.quantiles;
  const groups = account?.rumPageloadEventsAdaptiveGroups ?? [];
  const rows = groups.map((g) => {
    const row: Record<string, string | number> = {
      pageviews: g.count ?? 0,
      visits: g.sum?.visits ?? 0,
    };
    if (g.dimensions?.date) row.date = g.dimensions.date;
    if (vitals) {
      if (vitals.largestContentfulPaintP75 != null) row.lcp = vitals.largestContentfulPaintP75;
      if (vitals.cumulativeLayoutShiftP75 != null) row.cls = vitals.cumulativeLayoutShiftP75;
      if (vitals.interactionToNextPaintP75 != null) row.inp = vitals.interactionToNextPaintP75;
    }
    return row;
  });
  return { source: 'cloudflare', timezone: 'UTC', rows };
}

async function httpQuery(
  opts: CloudflareSourceOpts | undefined,
  req: QueryRequest,
  binding: BindingFor<'cloudflare'>,
  timeoutMs?: number,
): Promise<QueryResult> {
  const json = (await graphql(
    opts,
    {
      query: `
        query Http($zoneTag: String!, $since: Date!, $until: Date!) {
          viewer {
            zones(filter: { zoneTag: $zoneTag }) {
              httpRequests1dGroups(
                limit: 40
                orderBy: [date_ASC]
                filter: { date_geq: $since, date_lt: $until }
              ) {
                dimensions { date }
                sum { requests bytes cachedRequests }
                uniq { uniques }
              }
            }
          }
        }`,
      variables: {
        zoneTag: binding.zoneId,
        since: req.range.start,
        until: nextUtcDay(req.range.end),
      },
    },
    timeoutMs,
  )) as GraphqlEnvelope;
  const groups = json.data?.viewer?.zones?.[0]?.httpRequests1dGroups ?? [];
  const rows = groups.map((g) => ({
    date: g.dimensions?.date ?? '',
    requests: g.sum?.requests ?? 0,
    bytes: g.sum?.bytes ?? 0,
    cachedRequests: g.sum?.cachedRequests ?? 0,
    uniques: g.uniq?.uniques ?? 0,
  }));
  return { source: 'cloudflare', timezone: 'UTC', rows };
}

async function graphql(
  opts: CloudflareSourceOpts | undefined,
  body: unknown,
  timeoutMs?: number,
): Promise<unknown> {
  const env = envOf(opts);
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is not set');
  const json = asRecord(
    'cloudflare',
    await fetchUpstream({
      source: 'cloudflare',
      url: GRAPHQL,
      fetchImpl: fetchOf(opts),
      timeoutMs: resolveTimeout(timeoutMs),
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  ) as GraphqlEnvelope;
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    throw upstreamError(
      'cloudflare',
      200,
      json.errors.map((e) => e.message ?? 'graphql error').join('; '),
    );
  }
  return json;
}
