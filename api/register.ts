/**
 * POST /register — RFC 7591 dynamic client registration.
 *
 * Public client per RFC 8252: PKCE is the proof of possession, so no client
 * secret is issued and none would be verified if one were sent.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { ClientRegistryError, issueClientId } from './_shared/client-registry.js';
import { handlePreflight, readBody } from './_shared/utils.js';

export const config = { runtime: 'nodejs' };

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

  let body: Record<string, unknown>;
  try {
    const raw =
      typeof req.body === 'string'
        ? req.body
        : typeof req.body === 'object' && req.body
          ? JSON.stringify(req.body)
          : await readBody(req);
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_request', error_description: 'Invalid JSON body' }));
    return;
  }

  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: 'invalid_request', error_description: 'redirect_uris is required' }),
    );
    return;
  }

  const clientName = typeof body.client_name === 'string' ? body.client_name : undefined;

  let clientId: string;
  try {
    clientId = issueClientId(redirectUris as string[], clientName);
  } catch (err) {
    if (err instanceof ClientRegistryError) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_redirect_uri', error_description: err.message }));
      return;
    }
    throw err;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      client_name: clientName ?? 'MCP Client',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  );
}
