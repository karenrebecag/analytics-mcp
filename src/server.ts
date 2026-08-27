import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { INSTRUCTIONS } from './instructions.js';
import { registerPrompts } from './prompts/index.js';
import { registerResources } from './resources/index.js';
import {
  explainDiscrepancySchema,
  getSchemaSchema,
  handleExplainDiscrepancy,
  handleGetSchema,
  handleListSites,
  handleListSources,
  handleQuery,
  handleQueryRaw,
  handleValidateQuery,
  listSitesSchema,
  listSourcesSchema,
  queryRawSchema,
  querySchema,
  validateQuerySchema,
} from './tools/index.js';

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'analytics-mcp', version: '0.1.0' },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: INSTRUCTIONS,
    },
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

  server.registerTool(
    'explain_discrepancy',
    {
      description:
        'Is the gap between two sources for one metric normal? Deterministic verdict from codified criterion; says so plainly when no criterion exists rather than guessing.',
      inputSchema: explainDiscrepancySchema.shape,
      annotations: READ_ONLY,
    },
    (args) => handleExplainDiscrepancy(args),
  );

  server.registerTool(
    'validate_query',
    {
      description:
        'Dry-run a query: reports unsupported metrics, silently truncated ranges and misleading comparisons. Advisory — never blocks query.',
      inputSchema: validateQuerySchema.shape,
      annotations: READ_ONLY,
    },
    (args) => handleValidateQuery(args),
  );

  registerResources(server);
  registerPrompts(server);

  return server;
}
