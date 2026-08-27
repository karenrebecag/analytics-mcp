import { createHmac, timingSafeEqual } from 'node:crypto';
import { signingSecret } from './config.js';

/**
 * Stateless OAuth client registry.
 *
 * Registered clients cannot live in a module-level Map: that does not survive
 * across serverless instances, so `authorize` could never verify a client
 * registered by a different invocation and the redirect_uri allowlist would go
 * unenforced. Signing the registration into the client_id itself removes the
 * need for shared storage.
 */

export interface RegisteredClient {
  redirect_uris: string[];
  client_name?: string;
  iat: number;
}

export type ClientRegistryErrorCode =
  'MALFORMED' | 'INVALID_SIGNATURE' | 'REDIRECT_URI_NOT_ALLOWED' | 'UNSUPPORTED_SCHEME';

export class ClientRegistryError extends Error {
  code: ClientRegistryErrorCode;
  constructor(code: ClientRegistryErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'ClientRegistryError';
  }
}

// Schemes that can execute script or read local files if a redirect ever reaches a
// browser context. Never registrable, regardless of client.
const DENIED_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'blob:', 'vbscript:']);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

function getSecret(secretOverride?: string): string {
  return secretOverride ?? signingSecret();
}

function computeHmac(payloadB64: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payloadB64, 'utf8').digest();
}

function parse(uri: string): URL {
  try {
    return new URL(uri);
  } catch {
    throw new ClientRegistryError('UNSUPPORTED_SCHEME', `Unparseable redirect_uri: ${uri}`);
  }
}

function isLoopback(u: URL): boolean {
  return LOOPBACK_HOSTS.has(u.hostname);
}

/**
 * Rejects a redirect_uri that could never be safe to register. Custom application
 * schemes (cursor:, vscode:) stay allowed — native MCP clients depend on them.
 */
function assertRegistrableUri(uri: string): void {
  const u = parse(uri);

  if (DENIED_SCHEMES.has(u.protocol)) {
    throw new ClientRegistryError('UNSUPPORTED_SCHEME', `Scheme not allowed: ${u.protocol}`);
  }

  // Plaintext HTTP only for loopback — anywhere else the code is exposed in transit.
  if (u.protocol === 'http:' && !isLoopback(u)) {
    throw new ClientRegistryError(
      'UNSUPPORTED_SCHEME',
      'http is only allowed for loopback redirect URIs; use https',
    );
  }

  // Credentials in a redirect target are how `https://trusted.example@evil.example/cb`
  // reads as trusted to a human and as evil.example to a URL parser.
  if (u.username || u.password) {
    throw new ClientRegistryError(
      'UNSUPPORTED_SCHEME',
      'redirect_uri must not contain credentials',
    );
  }
}

export function issueClientId(
  redirectUris: string[],
  clientName?: string,
  secretOverride?: string,
): string {
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    throw new ClientRegistryError('MALFORMED', 'At least one redirect_uri is required');
  }
  for (const uri of redirectUris) {
    if (typeof uri !== 'string') {
      throw new ClientRegistryError('MALFORMED', 'redirect_uris must be strings');
    }
    assertRegistrableUri(uri);
  }

  const client: RegisteredClient = {
    redirect_uris: redirectUris,
    ...(clientName ? { client_name: clientName } : {}),
    iat: Math.floor(Date.now() / 1000),
  };

  const payloadB64 = Buffer.from(JSON.stringify(client)).toString('base64url');
  const macB64 = computeHmac(payloadB64, getSecret(secretOverride)).toString('base64url');
  return `${payloadB64}.${macB64}`;
}

export function verifyClientId(clientId: string, secretOverride?: string): RegisteredClient {
  if (!clientId || typeof clientId !== 'string') {
    throw new ClientRegistryError('MALFORMED', 'Missing client_id');
  }

  const parts = clientId.split('.');
  if (parts.length !== 2) {
    throw new ClientRegistryError('MALFORMED', 'Malformed client_id — expected payload.mac');
  }

  const [payloadB64, macB64] = parts;
  const B64URL_RE = /^[A-Za-z0-9_-]+$/;
  if (!B64URL_RE.test(payloadB64) || !B64URL_RE.test(macB64)) {
    throw new ClientRegistryError('MALFORMED', 'Malformed client_id — invalid encoding');
  }

  const expected = computeHmac(payloadB64, getSecret(secretOverride));
  const provided = Buffer.from(macB64, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new ClientRegistryError('INVALID_SIGNATURE', 'client_id signature does not verify');
  }

  let client: RegisteredClient;
  try {
    client = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new ClientRegistryError('MALFORMED', 'Malformed client_id — payload is not valid JSON');
  }

  if (!Array.isArray(client.redirect_uris) || client.redirect_uris.length === 0) {
    throw new ClientRegistryError('MALFORMED', 'Malformed client_id — no redirect_uris');
  }

  return client;
}

/**
 * RFC 6749 section 3.1.2.3 mandates simple string comparison. The one exception is
 * RFC 8252 section 7.3: a native client on loopback gets an ephemeral port, so the
 * port — and only the port — may vary.
 */
export function redirectUriMatches(registered: string, provided: string): boolean {
  if (registered === provided) return true;

  let reg: URL;
  let prov: URL;
  try {
    reg = new URL(registered);
    prov = new URL(provided);
  } catch {
    return false;
  }

  if (!isLoopback(reg) || !isLoopback(prov)) return false;
  if (prov.username || prov.password) return false;

  return (
    reg.protocol === prov.protocol &&
    reg.hostname === prov.hostname &&
    reg.pathname === prov.pathname &&
    reg.search === prov.search
  );
}

export function assertRedirectUriAllowed(
  clientId: string,
  redirectUri: string,
  secretOverride?: string,
): void {
  const client = verifyClientId(clientId, secretOverride);

  if (!redirectUri || typeof redirectUri !== 'string') {
    throw new ClientRegistryError('REDIRECT_URI_NOT_ALLOWED', 'Missing redirect_uri');
  }

  const allowed = client.redirect_uris.some((registered) =>
    redirectUriMatches(registered, redirectUri),
  );

  if (!allowed) {
    throw new ClientRegistryError(
      'REDIRECT_URI_NOT_ALLOWED',
      'redirect_uri does not match any URI registered for this client_id',
    );
  }
}
