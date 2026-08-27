import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import authorize from '../api/authorize.js';
import registerHandler from '../api/register.js';
import tokenHandler, { setAuthStateStoreForTests } from '../api/token.js';
import mcpHandler, { setMcpAuthStoreForTests } from '../api/mcp.js';
import {
  AuthStateUnavailableError,
  MemoryAuthStateStore,
  type AuthStateStore,
} from '../api/_shared/auth-state.js';
import { issueClientId } from '../api/_shared/client-registry.js';
import { json, mockRequest, mockResponse } from './helpers/http.js';

const SECRET = 'test-signing-secret-that-is-long-enough';
const ISSUER = 'analytics-mcp';

let store: MemoryAuthStateStore;

beforeEach(() => {
  process.env.MCP_SIGNING_SECRET = SECRET;
  process.env.FRONTEND_URL = 'https://app.example';
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CLERK_JWT_KEY;
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

const secretBytes = () => new TextEncoder().encode(SECRET);

async function makeCode(overrides: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({
    sub: 'user-1',
    email: 'someone@example.com',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .setIssuer(`${ISSUER}-oauth`)
    .setAudience(ISSUER)
    .setJti(crypto.randomUUID())
    .sign(secretBytes());
}

// RFC 7636 appendix B fixture: this verifier hashes to the challenge above.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

async function exchange(code: string, verifier = VERIFIER) {
  const res = mockResponse();
  await tokenHandler(
    mockRequest({
      method: 'POST',
      body: { grant_type: 'authorization_code', code, code_verifier: verifier },
    }),
    res,
  );
  return res;
}

describe('register', () => {
  it('issues a client_id and rejects a dangerous scheme', async () => {
    const ok = mockResponse();
    await registerHandler(
      mockRequest({ method: 'POST', body: { redirect_uris: ['https://client.example/cb'] } }),
      ok,
    );
    expect(ok.captured.status).toBe(200);
    expect(json(ok).client_id).toBeTruthy();

    const bad = mockResponse();
    await registerHandler(
      mockRequest({ method: 'POST', body: { redirect_uris: ['javascript:alert(1)'] } }),
      bad,
    );
    expect(bad.captured.status).toBe(400);
  });
});

describe('authorize', () => {
  const clientId = () => issueClientId(['https://client.example/cb'], 'test', SECRET);

  function get(params: Record<string, string>) {
    const res = mockResponse();
    const qs = new URLSearchParams(params).toString();
    authorize(mockRequest({ url: `/authorize?${qs}` }), res);
    return res;
  }

  it('redirects a valid request to the sign-in page', () => {
    const res = get({
      client_id: clientId(),
      redirect_uri: 'https://client.example/cb',
      response_type: 'code',
      code_challenge: 'abc',
      code_challenge_method: 'S256',
    });
    expect(res.captured.status).toBe(302);
    expect(res.captured.headers.location).toContain('https://app.example/auth/mcp-oauth');
  });

  it('rejects code_challenge_method=plain', () => {
    const res = get({
      client_id: clientId(),
      redirect_uri: 'https://client.example/cb',
      response_type: 'code',
      code_challenge: 'abc',
      code_challenge_method: 'plain',
    });
    expect(res.captured.status).toBe(400);
    expect(String(json(res).error_description)).toMatch(/S256/);
  });

  it('rejects an unregistered redirect_uri without redirecting', () => {
    const res = get({
      client_id: clientId(),
      redirect_uri: 'https://evil.example/cb',
      response_type: 'code',
      code_challenge: 'abc',
    });
    expect(res.captured.status).toBe(400);
    expect(res.captured.headers.location).toBeUndefined();
  });
});

describe('token — authorization_code', () => {
  it('exchanges a valid code for an access and refresh token', async () => {
    const res = await exchange(await makeCode());
    expect(res.captured.status).toBe(200);
    const body = json(res);
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
  });

  it('rejects a wrong code_verifier', async () => {
    const res = await exchange(await makeCode(), 'wrong-verifier-value-padding-padding-pad');
    expect(res.captured.status).toBe(400);
    expect(String(json(res).error_description)).toMatch(/PKCE/);
  });

  it('refuses to reuse a code', async () => {
    const code = await makeCode();
    expect((await exchange(code)).captured.status).toBe(200);
    const second = await exchange(code);
    expect(second.captured.status).toBe(400);
    expect(String(json(second).error_description)).toMatch(/already been used/);
  });

  it('fails closed when the auth-state store is unavailable', async () => {
    const broken: AuthStateStore = {
      consumeCode: async () => {
        throw new AuthStateUnavailableError('store down');
      },
      consumeRefresh: async () => true,
      revokeJti: async () => {},
      isJtiRevoked: async () => false,
      revokeSubject: async () => {},
      isSubjectRevoked: async () => false,
    };
    setAuthStateStoreForTests(broken);
    const res = await exchange(await makeCode());
    expect(res.captured.status).toBe(503);
    expect(json(res).access_token).toBeUndefined();
  });
});

describe('token — refresh', () => {
  async function refresh(token: string) {
    const res = mockResponse();
    await tokenHandler(
      mockRequest({ method: 'POST', body: { grant_type: 'refresh_token', refresh_token: token } }),
      res,
    );
    return res;
  }

  it('rotates and revokes the family on reuse', async () => {
    const first = json(await exchange(await makeCode()));
    const rotated = await refresh(first.refresh_token as string);
    expect(rotated.captured.status).toBe(200);

    const reused = await refresh(first.refresh_token as string);
    expect(reused.captured.status).toBe(400);
    expect(String(json(reused).error_description)).toMatch(/reuse detected/);

    const afterRevocation = await refresh(json(rotated).refresh_token as string);
    expect(afterRevocation.captured.status).toBe(400);
  });
});

describe('mcp endpoint auth', () => {
  async function call(headers: Record<string, string>) {
    const res = mockResponse();
    await mcpHandler(mockRequest({ method: 'POST', headers, body: {} }), res);
    return res;
  }

  it('401s without a bearer token and advertises the challenge', async () => {
    const res = await call({});
    expect(res.captured.status).toBe(401);
    expect(res.captured.headers['www-authenticate']).toMatch(/^Bearer/);
  });

  it('401s on a refresh token presented as an access token', async () => {
    const tokens = json(await exchange(await makeCode()));
    const res = await call({ authorization: `Bearer ${tokens.refresh_token as string}` });
    expect(res.captured.status).toBe(401);
    expect(res.captured.headers['www-authenticate']).toMatch(/invalid_token/);
  });

  it('403s an identity outside ALLOWED_EMAIL_DOMAIN', async () => {
    process.env.ALLOWED_EMAIL_DOMAIN = 'allowed.example';
    const tokens = json(await exchange(await makeCode()));
    const res = await call({ authorization: `Bearer ${tokens.access_token as string}` });
    expect(res.captured.status).toBe(403);
  });

  it('attempts Clerk with only the public key, and falls through on failure', async () => {
    // The public PEM alone must enable the Clerk path; a token this server
    // issued still verifies afterwards, so the fallthrough is not skipped.
    process.env.CLERK_JWT_KEY =
      '-----BEGIN PUBLIC KEY-----\nnot-a-real-key\n-----END PUBLIC KEY-----';
    const tokens = json(await exchange(await makeCode()));
    const res = await call({ authorization: `Bearer ${tokens.access_token as string}` });
    // Anything but 401/403 means auth resolved and the request reached the
    // transport (which then rejects the mock for its own reasons).
    expect(res.captured.status).not.toBe(401);
    expect(res.captured.status).not.toBe(403);
  });

  it('rejects an access token whose jti was revoked', async () => {
    const tokens = json(await exchange(await makeCode()));
    const decoded = JSON.parse(
      Buffer.from((tokens.access_token as string).split('.')[1], 'base64url').toString(),
    ) as { jti: string };
    await store.revokeJti(decoded.jti, 60);
    const res = await call({ authorization: `Bearer ${tokens.access_token as string}` });
    expect(res.captured.status).toBe(401);
  });
});
