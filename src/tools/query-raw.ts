import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getSite, loadSites } from '../config/sites.js';
import { jsonResult, runTool } from '../core/tool-result.js';
import { getSource } from '../sources/registry.js';
import { SOURCE_IDS, type BindingFor } from '../sources/types.js';

export const RAW_MAX_BYTES = 32 * 1024;

export const queryRawSchema = z.object({
  source: z.enum(SOURCE_IDS, {
    errorMap: () => ({ message: `Unknown source. Valid: ${SOURCE_IDS.join(', ')}` }),
  }),
  site: z.string().min(1),
  body: z.unknown(),
});

export async function handleQueryRaw(
  args: z.infer<typeof queryRawSchema>,
): Promise<CallToolResult> {
  return runTool(async () => {
    const parsed = queryRawSchema.safeParse(args);
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const { source: sourceId, site: siteId, body } = parsed.data;
    const site = getSite(loadSites(), siteId);
    const binding = site.sources[sourceId];
    if (!binding) {
      throw new Error(`Site '${siteId}' has no ${sourceId} binding`);
    }
    const source = getSource(sourceId);
    const raw = await source.queryRaw(body, binding as BindingFor<typeof sourceId>);
    const serialized = JSON.stringify(raw);
    if (serialized.length <= RAW_MAX_BYTES) {
      return jsonResult({ source: sourceId, site: siteId, result: raw });
    }
    return jsonResult({
      source: sourceId,
      site: siteId,
      result: serialized.slice(0, RAW_MAX_BYTES),
      truncated: true,
      note: `response truncated to ${RAW_MAX_BYTES} bytes`,
    });
  });
}
