/**
 * POST /revoke — RFC 7009-style token revocation.
 *
 * Only tokens whose `sub` matches the caller's may be revoked, otherwise any
 * valid token would be a lever to log everyone else out.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { jwtVerify } from 'jose';
import {
  AuthStateUnavailableError,
  createAuthStateStore,
  type AuthStateStore,
} from './_shared/auth-state.js';
import { issuerName, signingSecret } from './_shared/config.js';
import { handlePreflight, readBody } from './_shared/utils.js';

export const config = { runtime: 'nodejs' };

const REFRESH_TTL_SEC = 60 * 24 * 60 * 60;

let storeOverride: AuthStateStore | null = null;
export function setRevokeStoreForTests(store: AuthStateStore | null): void {
  storeOverride = store;
}
function store(): AuthStateStore {
  return storeOverride ?? createAuthStateStore();
}

async function verifyToken(raw: string): Promise<{ sub?: string; jti?: string } | null> {
  try {
    const issuer = issuerName();
    const { payload } = await jwtVerify(raw, new TextEncoder().encode(signingSecret()), {
      issuer,
      audience: issuer,
    });
    return { sub: payload.sub, jti: payload.jti };
  } catch {
    return null;
  }
}

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
) {
  if (handlePreflight(req, res, 'POST, OPTIONS', 'Content-Type, Authorization')) return;

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }

  const authHeader = req.headers.authorization ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
    res.end(JSON.stringify({ error: 'invalid_token' }));
    return;
  }
  const caller = await verifyToken(authHeader.slice(7));
  if (!caller?.sub) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer error="invalid_token"',
    });
    res.end(JSON.stringify({ error: 'invalid_token' }));
    return;
  }

  let body: Record<string, string>;
  try {
    const raw =
      typeof req.body === 'string'
        ? req.body
        : typeof req.body === 'object' && req.body
          ? JSON.stringify(req.body)
          : await readBody(req);
    body = raw.startsWith('{')
      ? (JSON.parse(raw) as Record<string, string>)
      : Object.fromEntries(new URLSearchParams(raw));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_request' }));
    return;
  }

  const target = body.token;
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_request', error_description: 'Missing token' }));
    return;
  }

  const subject = await verifyToken(target);
  // RFC 7009: revoking an already-invalid token is a success, not an error.
  if (!subject?.jti || subject.sub !== caller.sub) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ revoked: false }));
    return;
  }

  try {
    await store().revokeJti(subject.jti, REFRESH_TTL_SEC);
  } catch (err) {
    const message =
      err instanceof AuthStateUnavailableError ? err.message : 'Auth state unavailable';
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'temporarily_unavailable', error_description: message }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ revoked: true }));
}
