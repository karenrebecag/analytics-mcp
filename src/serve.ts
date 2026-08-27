#!/usr/bin/env node
/**
 * Long-lived HTTP entry — the seam toward a persistent host.
 *
 * Not the v1 deploy path (that is api/mcp.ts on serverless). It exists so the
 * day this server needs a box that stays up — to reach a CLI-authenticated
 * source, or to run an `mcp-subprocess` adapter — that is a new adapter plus
 * this entry, not a rewrite. It stays compiled and smoke-tested precisely so
 * it still works on the day it is needed.
 *
 * Auth is a static bearer, not OAuth: this targets a private host behind a
 * reverse proxy that does its own authentication. Full OAuth stays a
 * serverless concern.
 */
import { createServer as createHttpServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { CORS_HEADERS, CORS_METHODS, handleMcpRequest } from './http-handler.js';

export const DEFAULT_PORT = 8788;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export interface ServeOptions {
  bearerToken?: string;
  host?: string;
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Refuse to bind a public interface without a token. An MCP server reachable
 * from the network with no authentication is a data leak, not a convenience,
 * so the unauthenticated case is confined to loopback where exposing it takes
 * a deliberate proxy in front.
 */
export function assertBindable(host: string, bearerToken?: string): void {
  if (!bearerToken && !LOOPBACK.has(host)) {
    throw new Error(
      `Refusing to bind ${host} without SERVE_BEARER_TOKEN. ` +
        'Set a token, or bind 127.0.0.1 and put a proxy in front.',
    );
  }
}

export function createMcpHttpServer(options: ServeOptions = {}): Server {
  const { bearerToken } = options;
  return createHttpServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', CORS_METHODS);
    res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (bearerToken) {
      const header = req.headers.authorization ?? '';
      if (!header.startsWith('Bearer ') || !tokenMatches(header.slice(7), bearerToken)) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer',
        });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }

    void handleMcpRequest(req, res);
  });
}

async function main(): Promise<void> {
  const bearerToken = process.env.SERVE_BEARER_TOKEN?.trim() || undefined;
  const host = process.env.HOST?.trim() || '127.0.0.1';
  const port = Number(process.env.PORT) || DEFAULT_PORT;

  assertBindable(host, bearerToken);

  const server = createMcpHttpServer({ bearerToken });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));

  process.stderr.write(`analytics-mcp listening on http://${host}:${port}\n`);
  if (!bearerToken) {
    process.stderr.write(
      'warning: no SERVE_BEARER_TOKEN — this server is unauthenticated on loopback\n',
    );
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}

// Only run when executed directly, so tests can import the factory.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
