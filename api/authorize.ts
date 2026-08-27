/**
 * GET /authorize — OAuth 2.1 authorization endpoint.
 *
 * This server does not authenticate anyone: it validates the request and hands
 * off to the deployer's sign-in page (FRONTEND_URL), which authenticates the
 * user and mints the authorization code. See README for that contract.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { ClientRegistryError, assertRedirectUriAllowed } from './_shared/client-registry.js';
import { authorizePagePath, frontendUrl } from './_shared/config.js';
import { handlePreflight } from './_shared/utils.js';

export const config = { runtime: 'nodejs' };

function badRequest(res: ServerResponse, description: string): void {
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'invalid_request', error_description: description }));
}

export default function handler(req: IncomingMessage, res: ServerResponse) {
  if (handlePreflight(req, res, 'GET, OPTIONS')) return;

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  const state = url.searchParams.get('state');
  const codeChallenge = url.searchParams.get('code_challenge');
  const codeChallengeMethod = url.searchParams.get('code_challenge_method');
  const responseType = url.searchParams.get('response_type');
  const scope = url.searchParams.get('scope');

  if (!clientId || !redirectUri || !codeChallenge || responseType !== 'code') {
    badRequest(res, 'Missing required parameters');
    return;
  }

  // PKCE is mandatory. Without pinning the method a client could downgrade to
  // "plain" and make the challenge equal the verifier, which proves nothing.
  if (codeChallengeMethod && codeChallengeMethod !== 'S256') {
    badRequest(res, 'code_challenge_method must be S256');
    return;
  }

  // The redirect_uri decides where the authorization code lands. Unvalidated,
  // any link sent to a signed-in user hands their code to the attacker's host.
  // Errors are returned here, never redirected to the caller.
  try {
    assertRedirectUriAllowed(clientId, redirectUri);
  } catch (err) {
    if (err instanceof ClientRegistryError) {
      badRequest(
        res,
        'redirect_uri is not registered for this client_id. Re-register at /register.',
      );
      return;
    }
    throw err;
  }

  let authUrl: URL;
  try {
    authUrl = new URL(authorizePagePath(), frontendUrl());
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'server_error',
        error_description: err instanceof Error ? err.message : 'Sign-in page not configured',
      }),
    );
    return;
  }

  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state ?? '');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', codeChallengeMethod ?? 'S256');
  if (scope) authUrl.searchParams.set('scope', scope);

  res.writeHead(302, { Location: authUrl.toString() });
  res.end();
}
