export const SOURCE_IDS = ['ga4', 'cloudflare', 'vercel', 'gsc'] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export type SourceAuthKind = 'http-api' | 'mcp-subprocess';

/** ISO `yyyy-mm-dd` (inclusive). */
export interface DateRange {
  start: string;
  end: string;
}

export type Granularity = 'day' | 'week' | 'month' | 'total';

export interface QueryRequest {
  siteId: string;
  range: DateRange;
  granularity: Granularity;
  metrics: string[];
  dimensions?: string[];
}

export interface QueryResult {
  source: SourceId;
  timezone: string;
  rows: Array<Record<string, string | number>>;
  warnings?: string[];
}

export interface SchemaEntry {
  name: string;
  kind: 'metric' | 'dimension';
  description: string;
}

export interface Ga4Binding {
  propertyId: string;
}

export interface CloudflareBinding {
  zoneId: string;
  host?: string;
}

export interface VercelBinding {
  projectId: string;
  teamId?: string;
}

export interface GscBinding {
  siteUrl: string;
}

export interface SiteSourceBindings {
  ga4: Ga4Binding;
  cloudflare: CloudflareBinding;
  vercel: VercelBinding;
  gsc: GscBinding;
}

export type BindingFor<I extends SourceId> = SiteSourceBindings[I];

export interface Site {
  id: string;
  name: string;
  sources: { [K in SourceId]?: SiteSourceBindings[K] };
}

export type Env = Record<string, string | undefined>;

export interface AnalyticsSource<I extends SourceId = SourceId> {
  readonly id: I;
  readonly authKind: SourceAuthKind;
  isConfigured(env: Env): boolean;
  schema(): Promise<SchemaEntry[]>;
  query(req: QueryRequest, binding: BindingFor<I>): Promise<QueryResult>;
  queryRaw(body: unknown, binding: BindingFor<I>): Promise<unknown>;
}
