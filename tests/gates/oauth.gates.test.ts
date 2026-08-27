/**
 * F3 gates — the CN set, run against the OAuth handlers.
 *
 * These import the api/ handlers directly rather than dist/: Vercel functions
 * are deployed as TypeScript sources, so api/ is never part of the tsc build.
 * The invariants under test are behavioural, not artifact-shaped.
 */
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import authorize from '../../api/authorize.js';
import tokenHandler, { setAuthStateStoreForTests } from '../../api/token.js';
import mcpHandler, { setMcpAuthStoreForTests } from '../../api/mcp.js';
import {
  AuthStateUnavailableError,
  MemoryAuthStateStore,
  type AuthStateStore,
} from '../../api/_shared/auth-state.js';
import { issueClientId } from '../../api/_shared/client-registry.js';
import { json, mockRequest, mockResponse } from '../helpers/http.js';

const SECRET = 'gate-signing-secret-long-enough-value';
const REGISTERED = 'https://client.example/callback';
let store: MemoryAuthStateStore;

beforeEach(() => {
  process.env.MCP_SIGNING_SECRET = SECRET;
  process.env.FRONTEND_URL = 'https://app.example';
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.ALLOWED_EMAIL_DOMAIN;
  store = new MemoryAuthStateStore();
  setAuthStateStoreForTests(store);
  setMcpAuthStoreForTests(store);
});

afterEach(() => {
  setAuthStateStoreForTests(null);
  setMcpAuthStoreForTests(null);
  store.clear();
});

function authorizeWith(params: Record<string, string>) {
  const res = mockResponse();
  authorize(mockRequest({ url: `/authorize?${new URLSearchParams(params).toString()}` }), res);
  return res;
}

const clientId = () => issueClientId([REGISTERED], 'gate', SECRET);

describe('S-F3-1 PKCE S256 is pinned', () => {
  it('rejects code_challenge_method=plain', () => {
    const res = authorizeWith({
      client_id: clientId(),
      redirect_uri: REGISTERED,
      response_type: 'code',
      code_challenge: 'challenge',
      code_challenge_method: 'plain',
    });
    expect(res.captured.status).toBe(400);
  });
});

describe('S-F3-2 redirect_uri allowlist', () => {
  const attacks = [
    ['unrelated host', 'https://evil.example/callback'],
    ['prefix trick a naive startsWith would allow', 'https://client.example.evil.test/callback'],
    ['path suffix', 'https://client.example/callback/../../evil'],
    ['dangerous scheme', 'javascript:alert(1)'],
    ['credentials in authority', 'https://client.example@evil.example/callback'],
  ] as const;

  for (const [label, uri] of attacks) {
    it(`rejects ${label} without redirecting`, () => {
      const res = authorizeWith({
        client_id: clientId(),
        redirect_uri: uri,
        response_type: 'code',
        code_challenge: 'challenge',
      });
      expect(res.captured.status).toBe(400);
      expect(res.captured.headers.location).toBeUndefined();
    });
  }

  it('still accepts the registered uri', () => {
    const res = authorizeWith({
      client_id: clientId(),
      redirect_uri: REGISTERED,
      response_type: 'code',
      code_challenge: 'challenge',
    });
    expect(res.captured.status).toBe(302);
  });
});

async function issueTokens(): Promise<Record<string, unknown>> {
  const code = await new SignJWT({
    sub: 'gate-user',
    email: 'gate@example.com',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .setIssuer('analytics-mcp-oauth')
    .setAudience('analytics-mcp')
    .setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(SECRET));

  const res = mockResponse();
  await tokenHandler(
    mockRequest({
      method: 'POST',
      body: {
        grant_type: 'authorization_code',
        code,
        code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      },
    }),
    res,
  );
  return json(res);
}

describe('S-F3-3 a refresh token is not an access token', () => {
  it('401s when a refresh token is presented to /mcp', async () => {
    const tokens = await issueTokens();
    const res = mockResponse();
    await mcpHandler(
      mockRequest({
        method: 'POST',
        headers: { authorization: `Bearer ${tokens.refresh_token as string}` },
        body: {},
      }),
      res,
    );
    expect(res.captured.status).toBe(401);
  });
});

describe('S-F3-4 auth state is fail-closed', () => {
  it('refuses to issue tokens when the store is unreachable', async () => {
    const broken: AuthStateStore = {
      consumeCode: async () => {
        throw new AuthStateUnavailableError('store unreachable');
      },
      consumeRefresh: async () => {
        throw new AuthStateUnavailableError('store unreachable');
      },
      revokeJti: async () => {},
      isJtiRevoked: async () => false,
      revokeSubject: async () => {},
      isSubjectRevoked: async () => false,
    };
    setAuthStateStoreForTests(broken);
    const body = await issueTokens();
    expect(body.access_token).toBeUndefined();
  });
});

describe('S-F3-5 unauthenticated /mcp starts the OAuth flow', () => {
  it('401s with a WWW-Authenticate challenge', async () => {
    const res = mockResponse();
    await mcpHandler(mockRequest({ method: 'POST', body: {} }), res);
    expect(res.captured.status).toBe(401);
    expect(res.captured.headers['www-authenticate']).toMatch(/^Bearer/);
  });
});

describe('P-F3-1 authenticated /mcp responds within budget', () => {
  // A real http server, not a mock: the transport converts IncomingMessage to
  // a web Request underneath, so only a genuine socket exercises that path.
  it('completes initialize under 2000 ms over real HTTP', async () => {
    process.env.SITES_CONFIG = '[]';
    const tokens = await issueTokens();

    const server = createHttpServer((req, res) => {
      void mcpHandler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const started = Date.now();
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokens.access_token as string}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'gate', version: '1' },
          },
        }),
      });
      const text = await response.text();
      expect(response.status).toBeLessThan(400);
      expect(text).toContain('analytics-mcp');
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      delete process.env.SITES_CONFIG;
    }
  });

  it('401s over real HTTP without a token', async () => {
    const server = createHttpServer((req, res) => {
      void mcpHandler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toMatch(/^Bearer/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
