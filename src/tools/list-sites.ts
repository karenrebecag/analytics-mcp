import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadSites } from '../config/sites.js';
import { jsonResult, runTool } from '../core/tool-result.js';

export const listSitesSchema = z.object({});

export async function handleListSites(): Promise<CallToolResult> {
  return runTool(async () => {
    const sites = loadSites();
    return jsonResult({
      count: sites.length,
      sites: sites.map((site) => ({
        id: site.id,
        name: site.name,
        sources: Object.keys(site.sources),
      })),
    });
  });
}
