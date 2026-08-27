import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getSite, loadSites } from '../config/sites.js';
import { getCacheStore } from '../core/cache/index.js';
import { canonicalizeRows, discrepancyNotes, planSourceMetrics } from '../core/normalize.js';
import { jsonResult, runTool } from '../core/tool-result.js';
import { allSources } from '../sources/registry.js';
import { SOURCE_IDS, type BindingFor, type QueryResult, type SourceId } from '../sources/types.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be yyyy-mm-dd');

export const querySchema = z.object({
  site: z.string().min(1),
  range: z.object({ start: isoDate, end: isoDate }).strict(),
  granularity: z.enum(['day', 'week', 'month', 'total']),
  metrics: z.array(z.string().min(1)).min(1),
  dimensions: z.array(z.string().min(1)).optional(),
  sources: z.array(z.enum(SOURCE_IDS)).optional(),
});

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TTL_S = 300;

export async function handleQuery(args: z.infer<typeof querySchema>): Promise<CallToolResult> {
  return runTool(async () => {
    const env = process.env;
    const site = getSite(loadSites(env), args.site);
    const timeoutMs = positiveInt(env.QUERY_SOURCE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const ttlS = positiveInt(env.QUERY_CACHE_TTL_S, DEFAULT_TTL_S);
    const requested = args.sources ?? [...SOURCE_IDS];
    const targets = allSources().filter(
      (source) =>
        requested.includes(source.id) &&
        source.isConfigured(env) &&
        site.sources[source.id] !== undefined,
    );
    if (targets.length === 0) {
      throw new Error(
        `No matching sources for site '${args.site}' (requested ∩ configured ∩ bound)`,
      );
    }

    const cache = getCacheStore(env);
    const settled = await Promise.allSettled(
      targets.map((source) => {
        const binding = site.sources[source.id];
        if (!binding) {
          return Promise.reject(new Error(`${source.id} missing binding`));
        }
        return runSlot(source.id, source, binding, args, timeoutMs, ttlS, cache);
      }),
    );

    const results: QueryResult[] = [];
    const errors: Array<{ source: SourceId; error: string }> = [];
    for (const [i, outcome] of settled.entries()) {
      const id = targets[i].id;
      if (outcome.status === 'fulfilled') results.push(outcome.value);
      else {
        const message =
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        errors.push({ source: id, error: message });
      }
    }

    const notes = discrepancyNotes(results);
    return jsonResult({
      site: args.site,
      range: args.range,
      results,
      ...(errors.length ? { errors } : {}),
      ...(notes.length ? { notes } : {}),
    });
  });
}

async function runSlot(
  id: SourceId,
  source: ReturnType<typeof allSources>[number],
  binding: BindingFor<SourceId>,
  args: z.infer<typeof querySchema>,
  timeoutMs: number,
  ttlS: number,
  cache: ReturnType<typeof getCacheStore>,
): Promise<QueryResult> {
  const { native, warnings } = planSourceMetrics(id, args.metrics);
  if (native.length === 0) {
    return { source: id, timezone: 'UTC', rows: [], warnings };
  }

  const key = slotKey(id, args);
  const cached = await readCachedSlot(cache, key);
  if (cached) return cached;

  const result = await withTimeout(
    source.query(
      {
        siteId: args.site,
        range: args.range,
        granularity: args.granularity,
        metrics: native,
        dimensions: args.dimensions,
      },
      binding,
      timeoutMs,
    ),
    timeoutMs,
    id,
  );
  const mapped: QueryResult = {
    ...result,
    rows: canonicalizeRows(id, result.rows, args.metrics),
    warnings: [...(result.warnings ?? []), ...warnings],
  };
  if (mapped.warnings?.length === 0) delete mapped.warnings;
  try {
    await cache.set(key, JSON.stringify(mapped), ttlS);
  } catch {
    // Cache is a wrapper; a store failure must not drop a successful slot.
  }
  return mapped;
}

function isQueryResult(value: unknown): value is QueryResult {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.source === 'string' && typeof rec.timezone === 'string' && Array.isArray(rec.rows)
  );
}

async function readCachedSlot(
  cache: ReturnType<typeof getCacheStore>,
  key: string,
): Promise<QueryResult | null> {
  let hit: string | null;
  try {
    hit = await cache.get(key);
  } catch {
    return null;
  }
  if (!hit) return null;
  try {
    const parsed: unknown = JSON.parse(hit);
    return isQueryResult(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function slotKey(source: SourceId, args: z.infer<typeof querySchema>): string {
  const payload = {
    site: args.site,
    range: args.range,
    granularity: args.granularity,
    metrics: [...args.metrics].sort(),
    dimensions: [...(args.dimensions ?? [])].sort(),
    source,
  };
  return `query:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, source: SourceId): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${source} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
