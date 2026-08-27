import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { INSTRUCTIONS } from './instructions.js';
import {
  handleListSites,
  handleListSources,
  listSitesSchema,
  listSourcesSchema,
} from './tools/index.js';

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'analytics-mcp', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'list_sites',
    {
      description:
        'List configured sites (id, name, bound source keys). Binding values stay server-side.',
      inputSchema: listSitesSchema.shape,
      annotations: READ_ONLY,
    },
    () => handleListSites(),
  );

  server.registerTool(
    'list_sources',
    {
      description: 'List registered analytics adapters and whether their credentials are present.',
      inputSchema: listSourcesSchema.shape,
      annotations: READ_ONLY,
    },
    () => handleListSources(),
  );

  return server;
}
