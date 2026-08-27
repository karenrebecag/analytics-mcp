import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadSites } from '../config/sites.js';
import { getCacheStore } from '../core/cache/index.js';
import { jsonResult, runTool } from '../core/tool-result.js';
import { allSources } from '../sources/registry.js';
import { SOURCE_IDS, type BindingFor, type SchemaEntry, type SourceId } from '../sources/types.js';

const SCHEMA_TTL_S = 3600;

export const getSchemaSchema = z.object({
  source: z.enum(SOURCE_IDS).optional(),
});

export async function handleGetSchema(
  args: z.infer<typeof getSchemaSchema>,
): Promise<CallToolResult> {
  return runTool(async () => {
    const env = process.env;
    const wanted = args.source ? [args.source] : [...SOURCE_IDS];
    const sites = loadSites(env);
    const schemas = [];
    for (const source of allSources()) {
      if (!wanted.includes(source.id)) continue;
      if (!args.source && !source.isConfigured(env)) continue;
      const binding = firstBinding(sites, source.id);
      const entries = (await schemaFor(
        source.id,
        async () => source.schema(binding),
        binding,
      )) as SchemaEntry[];
      schemas.push({ source: source.id, entries });
    }
    return jsonResult({ schemas });
  });
}

function firstBinding(
  sites: ReturnType<typeof loadSites>,
  id: SourceId,
): BindingFor<SourceId> | undefined {
  for (const site of sites) {
    const binding = site.sources[id];
    if (binding) return binding;
  }
  return undefined;
}

async function schemaFor(
  id: SourceId,
  load: () => Promise<unknown>,
  binding: BindingFor<SourceId> | undefined,
): Promise<unknown> {
  if (id !== 'ga4' || !binding || !('propertyId' in binding)) return load();
  const cache = getCacheStore();
  const key = `schema:ga4:${createHash('sha256').update(binding.propertyId).digest('hex')}`;
  try {
    const hit = await cache.get(key);
    if (hit) return JSON.parse(hit) as unknown;
  } catch {
    /* miss */
  }
  const entries = await load();
  try {
    await cache.set(key, JSON.stringify(entries), SCHEMA_TTL_S);
  } catch {
    /* still return */
  }
  return entries;
}
