/**
 * Shared transport glue for every HTTP entry point.
 *
 * Transport only — no auth, no business logic. Each entry decides who may call
 * it and then delegates here, so the two entries cannot drift apart in how
 * they actually speak MCP.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';

export const CORS_METHODS = 'GET, POST, DELETE, OPTIONS';
export const CORS_HEADERS = 'Content-Type, Accept, Authorization, Mcp-Session-Id';

/**
 * A fresh server and transport per request: stateless mode keeps no session,
 * and serverless gives no shared instance to keep one in.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody?: unknown,
): Promise<void> {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'server_error' }));
    }
    process.stderr.write(
      `mcp handler error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
