/**
 * Deployment-supplied identity for the OAuth layer.
 *
 * Nothing here is hardcoded to one organization: the issuer name, the base URL
 * and the authorize page all come from env, so a fork deploys the same code
 * against its own identity provider. See README for the FRONTEND_URL contract.
 */
import type { IncomingMessage } from 'http';

export const DEFAULT_ISSUER = 'analytics-mcp';

export function issuerName(env: NodeJS.ProcessEnv = process.env): string {
  return env.MCP_ISSUER?.trim() || DEFAULT_ISSUER;
}

/** Authorization codes are minted by the frontend under a distinct issuer. */
export function codeIssuerName(env: NodeJS.ProcessEnv = process.env): string {
  return `${issuerName(env)}-oauth`;
}

export function signingSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.MCP_SIGNING_SECRET;
  if (!secret) throw new Error('Missing required env var: MCP_SIGNING_SECRET');
  return secret;
}

/**
 * Public origin of this deployment. Falls back to the request host so a fresh
 * deploy advertises correct metadata before anyone sets MCP_BASE_URL.
 */
export function baseUrl(req?: IncomingMessage, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MCP_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');
  const host = req?.headers.host;
  if (host) {
    const proto = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
    return `${proto}://${host}`;
  }
  throw new Error('Cannot determine base URL — set MCP_BASE_URL');
}

/**
 * The deployer's sign-in page, which authenticates the user and mints the
 * authorization code. Deliberately has no default: guessing one would send
 * users of a fork to somebody else's login screen.
 */
export function frontendUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.FRONTEND_URL?.trim();
  if (!url) throw new Error('Missing required env var: FRONTEND_URL');
  return url.replace(/\/$/, '');
}

/** Path on FRONTEND_URL that renders the consent/sign-in page. */
export function authorizePagePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.FRONTEND_AUTHORIZE_PATH?.trim() || '/auth/mcp-oauth';
}
