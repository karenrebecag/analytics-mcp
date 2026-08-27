/** RFC 9728 protected resource metadata — points clients at this server's AS. */
import type { IncomingMessage, ServerResponse } from 'http';
import { baseUrl } from '../../_shared/config.js';
import { setCors } from '../../_shared/utils.js';

export const config = { runtime: 'nodejs' };

export default function handler(req: IncomingMessage, res: ServerResponse) {
  setCors(res);
  const base = baseUrl(req);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      scopes_supported: ['read'],
    }),
  );
}
