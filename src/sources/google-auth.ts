import { createSign } from 'node:crypto';
import type { FetchLike } from './upstream.js';
import { fetchUpstream } from './upstream.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

interface CachedToken {
  token: string;
  expiresAtSec: number;
}

const cache = new Map<string, CachedToken>();

export function readGoogleJson(
  env: Record<string, string | undefined>,
  primary: string,
  fallback?: string,
): string {
  const raw = env[primary]?.trim() || (fallback ? env[fallback]?.trim() : undefined);
  if (!raw) {
    throw new Error(`${primary} is not set`);
  }
  return raw;
}

function parseKey(raw: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('service account JSON is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('service account JSON is not an object');
  }
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.client_email !== 'string' || typeof rec.private_key !== 'string') {
    throw new Error('service account JSON missing client_email/private_key');
  }
  return { client_email: rec.client_email, private_key: rec.private_key };
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function getGoogleAccessToken(opts: {
  json: string;
  scope: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
}): Promise<string> {
  const key = parseKey(opts.json);
  const cacheKey = `${key.client_email}:${opts.scope}`;
  const now = Math.floor(Date.now() / 1000);
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAtSec - 60 > now) return hit.token;

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(
    JSON.stringify({
      iss: key.client_email,
      scope: opts.scope,
      aud: TOKEN_ENDPOINT,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${base64url(signer.sign(key.private_key))}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  }).toString();

  const json = await fetchUpstream({
    source: 'google-auth',
    url: TOKEN_ENDPOINT,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (
    typeof json !== 'object' ||
    json === null ||
    typeof (json as { access_token?: unknown }).access_token !== 'string'
  ) {
    throw new Error('google-auth token exchange failed');
  }
  const token = (json as { access_token: string }).access_token;
  const expiresIn = (json as { expires_in?: unknown }).expires_in;
  const ttlSec = typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : 3600;
  cache.set(cacheKey, { token, expiresAtSec: now + ttlSec });
  return token;
}

export function clearGoogleTokenCacheForTests(): void {
  cache.clear();
}
