import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { INSTRUCTIONS } from './instructions.js';
import {
  getSchemaSchema,
  handleGetSchema,
  handleListSites,
  handleListSources,
  handleQuery,
  handleQueryRaw,
  listSitesSchema,
  listSourcesSchema,
  queryRawSchema,
  querySchema,
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

  server.registerTool(
    'get_schema',
    {
      description: 'List metrics and dimensions for one source, or every configured source.',
      inputSchema: getSchemaSchema.shape,
      annotations: READ_ONLY,
    },
    (args) => handleGetSchema(args),
  );

  server.registerTool(
    'query',
    {
      description:
        'Primary analytics query. Fans out across configured sources bound to the site; a slow or failed source becomes an errors slot, not a failed tool call.',
      inputSchema: querySchema.shape,
      annotations: READ_ONLY,
    },
    (args) => handleQuery(args),
  );

  server.registerTool(
    'query_raw',
    {
      description:
        'Escape hatch: pass a native body to one source. No cache. Response may be truncated.',
      inputSchema: queryRawSchema.shape,
      annotations: READ_ONLY,
    },
    (args) => handleQueryRaw(args),
  );

  return server;
}
