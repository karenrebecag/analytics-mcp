/**
 * POST /token — authorization_code and refresh_token grants.
 *
 * Every check here exists because skipping it has a known exploit:
 * - the code is bound to its client_id and redirect_uri, so a code issued for
 *   one client cannot be redeemed by another;
 * - PKCE is unconditional, so a stolen code cannot be redeemed by simply
 *   omitting code_verifier;
 * - codes and refresh tokens are single-use, consumed atomically;
 * - refresh reuse revokes the whole subject family;
 * - if the state store is unreachable the grant fails (503) rather than
 *   proceeding without proof.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { SignJWT, jwtVerify } from 'jose';
import {
  AuthStateUnavailableError,
  createAuthStateStore,
  type AuthStateStore,
} from './_shared/auth-state.js';
import { codeIssuerName, issuerName, signingSecret } from './_shared/config.js';
import { handlePreflight, readBody } from './_shared/utils.js';

export const config = { runtime: 'nodejs' };

const ACCESS_TTL_DAYS = 30;
const ACCESS_TTL_SEC = ACCESS_TTL_DAYS * 24 * 60 * 60;
const REFRESH_TTL_SEC = 60 * 24 * 60 * 60;
/** Codes live ≤5 min; the consumed record outlives them a little. */
const CODE_TTL_SEC = 10 * 60;

let storeOverride: AuthStateStore | null = null;
export function setAuthStateStoreForTests(store: AuthStateStore | null): void {
  storeOverride = store;
}
function store(): AuthStateStore {
  return storeOverride ?? createAuthStateStore();
}

function fail(res: ServerResponse, description: string, error = 'invalid_grant'): void {
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error, error_description: description }));
}

function unavailable(res: ServerResponse, err: unknown): void {
  const message = err instanceof AuthStateUnavailableError ? err.message : 'Auth state unavailable';
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'temporarily_unavailable', error_description: message }));
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

async function mint(
  claims: { email?: unknown; sub: string; type: 'access' | 'refresh' },
  ttl: string,
  secret: Uint8Array,
): Promise<string> {
  const issuer = issuerName();
  return new SignJWT({ email: claims.email, sub: claims.sub, type: claims.type })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(ttl)
    .setIssuer(issuer)
    .setAudience(issuer)
    .setJti(crypto.randomUUID())
    .sign(secret);
}

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
) {
  if (handlePreflight(req, res, 'POST, OPTIONS')) return;

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method_not_allowed' }));
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

  if (body.grant_type === 'authorization_code') return handleAuthorizationCode(body, res);
  if (body.grant_type === 'refresh_token') return handleRefreshToken(body, res);

  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
}

async function handleAuthorizationCode(
  body: Record<string, string>,
  res: ServerResponse,
): Promise<void> {
  const { code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri } = body;
  if (!code) {
    fail(res, 'Missing code', 'invalid_request');
    return;
  }

  const secret = new TextEncoder().encode(signingSecret());
  let payload;
  try {
    const result = await jwtVerify(code, secret, {
      issuer: codeIssuerName(),
      audience: issuerName(),
    });
    payload = result.payload;
  } catch {
    fail(res, 'Invalid or expired authorization code');
    return;
  }

  // RFC 6749 4.1.3: the code is bound to the client and redirect_uri it was
  // issued for. Both are signed into the code; not reading them would let a
  // code issued for one client be redeemed by any other.
  const boundClient = payload.client_id as string | undefined;
  if (boundClient && (!clientId || !constantTimeEquals(clientId, boundClient))) {
    fail(res, 'client_id does not match the client this code was issued to');
    return;
  }
  const boundRedirect = payload.redirect_uri as string | undefined;
  if (boundRedirect && (!redirectUri || !constantTimeEquals(redirectUri, boundRedirect))) {
    fail(res, 'redirect_uri does not match the one used to obtain this code');
    return;
  }

  const challenge = payload.code_challenge as string | undefined;
  if (!challenge) {
    fail(res, 'Authorization code is missing its PKCE challenge');
    return;
  }
  if (!verifier) {
    fail(res, 'code_verifier is required', 'invalid_request');
    return;
  }
  if ((payload.code_challenge_method ?? 'S256') !== 'S256') {
    fail(res, 'Only the S256 code_challenge_method is supported');
    return;
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  if (!constantTimeEquals(Buffer.from(digest).toString('base64url'), challenge)) {
    fail(res, 'PKCE verification failed');
    return;
  }

  const codeJti = payload.jti as string | undefined;
  if (!codeJti) {
    fail(res, 'Authorization code is missing jti');
    return;
  }
  try {
    if (!(await store().consumeCode(codeJti, CODE_TTL_SEC))) {
      fail(res, 'Authorization code has already been used');
      return;
    }
  } catch (err) {
    unavailable(res, err);
    return;
  }

  const sub = payload.sub as string;
  const email = payload.email;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      access_token: await mint({ email, sub, type: 'access' }, `${ACCESS_TTL_DAYS}d`, secret),
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SEC,
      refresh_token: await mint({ email, sub, type: 'refresh' }, '60d', secret),
    }),
  );
}

async function handleRefreshToken(
  body: Record<string, string>,
  res: ServerResponse,
): Promise<void> {
  const refreshToken = body.refresh_token;
  if (!refreshToken) {
    fail(res, 'Missing refresh_token', 'invalid_request');
    return;
  }

  const secret = new TextEncoder().encode(signingSecret());
  const issuer = issuerName();
  let payload;
  try {
    const result = await jwtVerify(refreshToken, secret, { issuer, audience: issuer });
    payload = result.payload;
    if (payload.type !== 'refresh') throw new Error('not a refresh token');
  } catch {
    fail(res, 'Invalid refresh token');
    return;
  }

  const refreshJti = payload.jti as string | undefined;
  const sub = payload.sub as string | undefined;
  if (!refreshJti || !sub) {
    fail(res, 'Refresh token is missing jti or sub');
    return;
  }

  try {
    const st = store();
    // iat matters: a refresh minted after the revocation belongs to a new
    // session and must not inherit the old family's block.
    if (await st.isSubjectRevoked(sub, payload.iat)) {
      fail(res, 'Token family has been revoked');
      return;
    }
    if (await st.isJtiRevoked(refreshJti)) {
      fail(res, 'Refresh token has been revoked');
      return;
    }
    if (!(await st.consumeRefresh(refreshJti, REFRESH_TTL_SEC))) {
      await st.revokeSubject(sub, REFRESH_TTL_SEC);
      fail(res, 'Refresh token reuse detected — session family revoked');
      return;
    }
  } catch (err) {
    unavailable(res, err);
    return;
  }

  const email = payload.email;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      access_token: await mint({ email, sub, type: 'access' }, `${ACCESS_TTL_DAYS}d`, secret),
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SEC,
      refresh_token: await mint({ email, sub, type: 'refresh' }, '60d', secret),
    }),
  );
}
