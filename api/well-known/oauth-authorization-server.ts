/** RFC 8414 authorization server metadata. */
import type { IncomingMessage, ServerResponse } from 'http';
import { baseUrl } from '../_shared/config.js';
import { setCors } from '../_shared/utils.js';

export const config = { runtime: 'nodejs' };

export default function handler(req: IncomingMessage, res: ServerResponse) {
  setCors(res);
  const base = baseUrl(req);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['read'],
    }),
  );
}
