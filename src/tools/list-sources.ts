import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { jsonResult, runTool } from '../core/tool-result.js';
import { allSources } from '../sources/registry.js';

export const listSourcesSchema = z.object({});

export async function handleListSources(): Promise<CallToolResult> {
  return runTool(async () => {
    const sources = allSources().map((source) => ({
      id: source.id,
      authKind: source.authKind,
      configured: source.isConfigured(process.env),
    }));
    return jsonResult({ sources });
  });
}
