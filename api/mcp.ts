/**
 * POST /mcp — the remote MCP endpoint (StreamableHTTP).
 *
 * Bearer verification accepts two shapes so a deployment can pick its identity
 * model without a fork:
 *   1. a Clerk session JWT, when CLERK_SECRET_KEY is configured;
 *   2. an access token this server issued (HS256, MCP_SIGNING_SECRET).
 *
 * The 401 carries WWW-Authenticate — that header is what makes a client start
 * the OAuth flow instead of simply failing.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { jwtVerify } from 'jose';
import {
  AuthStateUnavailableError,
  createAuthStateStore,
  type AuthStateStore,
} from './_shared/auth-state.js';
import { baseUrl, issuerName, signingSecret } from './_shared/config.js';
import { setCors } from './_shared/utils.js';
import { createServer } from '../src/server.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

let storeOverride: AuthStateStore | null = null;
export function setMcpAuthStoreForTests(store: AuthStateStore | null): void {
  storeOverride = store;
}
function store(): AuthStateStore {
  return storeOverride ?? createAuthStateStore();
}

/** Verify a Clerk session token. Returns null when Clerk is not configured. */
async function verifyClerk(token: string): Promise<string | null> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) return null;
  try {
    // Imported lazily so a deployment without Clerk never loads the package.
    const { verifyToken } = await import('@clerk/backend');
    const payload = (await verifyToken(token, {
      secretKey,
      jwtKey: process.env.CLERK_JWT_KEY,
    })) as Record<string, unknown>;
    const email = payload.email;
    return typeof email === 'string' ? email : ((payload.sub as string | undefined) ?? null);
  } catch {
    return null;
  }
}

/** Verify an access token this server issued. */
async function verifyOwnToken(token: string): Promise<string | null> {
  let payload;
  try {
    const issuer = issuerName();
    const result = await jwtVerify(token, new TextEncoder().encode(signingSecret()), {
      issuer,
      audience: issuer,
    });
    payload = result.payload;
  } catch {
    return null;
  }

  // Refresh tokens share issuer and audience and differ only by `type`. Without
  // this check a 60-day refresh token works as a 30-day access token, doubling
  // the lifetime of a leaked credential.
  if (payload.type === 'refresh') return null;

  const jti = payload.jti;
  const sub = payload.sub;
  try {
    const st = store();
    if (jti && (await st.isJtiRevoked(jti))) return null;
    if (sub && (await st.isSubjectRevoked(sub, payload.iat))) return null;
  } catch (err) {
    // Fail closed: a store that cannot prove a token is live is not proof it is.
    if (err instanceof AuthStateUnavailableError) return null;
    throw err;
  }

  const email = payload.email;
  return typeof email === 'string' ? email : ((sub as string | undefined) ?? null);
}

async function verifyBearer(token: string): Promise<string | null> {
  return (await verifyClerk(token)) ?? (await verifyOwnToken(token));
}

/** Empty ALLOWED_EMAIL_DOMAIN means no domain restriction. */
function isAllowedIdentity(identity: string): boolean {
  const domain = process.env.ALLOWED_EMAIL_DOMAIN?.trim();
  if (!domain) return true;
  return identity.toLowerCase().endsWith(`@${domain.toLowerCase()}`);
}

function unauthorized(req: IncomingMessage, res: ServerResponse, invalid: boolean): void {
  let challenge = invalid ? 'Bearer error="invalid_token"' : 'Bearer';
  try {
    challenge += `, resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource/mcp"`;
  } catch {
    // No base URL to advertise; the bare challenge still starts the flow.
  }
  res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': challenge });
  res.end(
    JSON.stringify({
      error: invalid ? 'invalid_token' : 'unauthorized',
      error_description: invalid ? 'Invalid or expired token' : 'Bearer token required',
    }),
  );
}

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
) {
  setCors(res, 'GET, POST, DELETE, OPTIONS', 'Content-Type, Accept, Authorization, Mcp-Session-Id');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const authHeader = req.headers.authorization ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    unauthorized(req, res, false);
    return;
  }

  const identity = await verifyBearer(authHeader.slice(7));
  if (!identity) {
    unauthorized(req, res, true);
    return;
  }
  if (!isAllowedIdentity(identity)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'forbidden',
        error_description: 'This account is not allowed to use this server',
      }),
    );
    return;
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
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
