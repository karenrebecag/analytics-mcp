/**
 * Ephemeral auth state: single-use codes, revocation, refresh rotation.
 *
 * Backed by Upstash Redis over REST — no extra npm dependency, and native
 * SET NX gives single-use consumption its atomicity.
 *
 * Fail-closed: if the store is unavailable, callers must reject the request
 * (never skip the check). A store that cannot prove a code is unused must not
 * be read as proof that it is.
 */

export class AuthStateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthStateUnavailableError';
  }
}

export interface AuthStateStore {
  /**
   * Mark an authorization-code jti as consumed.
   * @returns true if this is the first use; false if already consumed.
   */
  consumeCode(jti: string, ttlSec: number): Promise<boolean>;

  /** Mark a refresh-token jti as consumed. true = first use. */
  consumeRefresh(jti: string, ttlSec: number): Promise<boolean>;

  /** Revoke a single JWT jti (access or refresh). */
  revokeJti(jti: string, ttlSec: number): Promise<void>;

  /** True if jti was revoked. */
  isJtiRevoked(jti: string): Promise<boolean>;

  /** Revoke all tokens for a subject (refresh reuse detection). */
  revokeSubject(sub: string, ttlSec: number): Promise<void>;

  /**
   * True if the subject family was revoked at or after the token was issued.
   *
   * `tokenIat` is what makes revocation recoverable: without it a revoked
   * subject stays blocked for the whole TTL and re-authenticating does not
   * help, because the sub never changes. Omitting it is treated as revoked —
   * an unknown issue time cannot be proven to postdate the revocation.
   */
  isSubjectRevoked(sub: string, tokenIat?: number): Promise<boolean>;
}

/* ---- Memory (tests + AUTH_STATE_STORE=memory) ---- */

export class MemoryAuthStateStore implements AuthStateStore {
  private codes = new Map<string, number>();
  private refreshes = new Map<string, number>();
  private revokedJtis = new Map<string, number>();
  // value: { expiresAt (ms, for gc), revokedAt (epoch seconds, compared to token.iat) }
  private revokedSubs = new Map<string, { expiresAt: number; revokedAt: number }>();

  async consumeCode(jti: string, ttlSec: number): Promise<boolean> {
    this.gc(this.codes);
    if (this.codes.has(jti)) return false;
    this.codes.set(jti, Date.now() + ttlSec * 1000);
    return true;
  }

  async consumeRefresh(jti: string, ttlSec: number): Promise<boolean> {
    this.gc(this.refreshes);
    if (this.refreshes.has(jti)) return false;
    this.refreshes.set(jti, Date.now() + ttlSec * 1000);
    return true;
  }

  async revokeJti(jti: string, ttlSec: number): Promise<void> {
    this.revokedJtis.set(jti, Date.now() + ttlSec * 1000);
  }

  async isJtiRevoked(jti: string): Promise<boolean> {
    this.gc(this.revokedJtis);
    return this.revokedJtis.has(jti);
  }

  async revokeSubject(sub: string, ttlSec: number): Promise<void> {
    this.revokedSubs.set(sub, {
      expiresAt: Date.now() + ttlSec * 1000,
      revokedAt: Math.floor(Date.now() / 1000),
    });
  }

  async isSubjectRevoked(sub: string, tokenIat?: number): Promise<boolean> {
    this.gcSubs();
    const entry = this.revokedSubs.get(sub);
    if (entry == null) return false;
    if (tokenIat == null) return true;
    return tokenIat <= entry.revokedAt;
  }

  private gc(map: Map<string, number>) {
    const now = Date.now();
    for (const [k, exp] of map) {
      if (exp <= now) map.delete(k);
    }
  }

  private gcSubs() {
    const now = Date.now();
    for (const [k, v] of this.revokedSubs) {
      if (v.expiresAt <= now) this.revokedSubs.delete(k);
    }
  }

  /** Test helper */
  clear() {
    this.codes.clear();
    this.refreshes.clear();
    this.revokedJtis.clear();
    this.revokedSubs.clear();
  }
}

/* ---- Upstash Redis REST (no extra npm dep) ---- */

export class RedisAuthStateStore implements AuthStateStore {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private async cmd(args: string[]): Promise<unknown> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) {
      throw new AuthStateUnavailableError(`Redis REST ${res.status}`);
    }
    const body = (await res.json()) as { result?: unknown; error?: string };
    if (body.error) throw new AuthStateUnavailableError(body.error);
    return body.result;
  }

  async consumeCode(jti: string, ttlSec: number): Promise<boolean> {
    // SET key 1 NX EX ttl → "OK" if set, null if exists
    const r = await this.cmd(['SET', `mcp:code:${jti}`, '1', 'NX', 'EX', String(ttlSec)]);
    return r === 'OK';
  }

  async consumeRefresh(jti: string, ttlSec: number): Promise<boolean> {
    const r = await this.cmd(['SET', `mcp:refresh:${jti}`, '1', 'NX', 'EX', String(ttlSec)]);
    return r === 'OK';
  }

  async revokeJti(jti: string, ttlSec: number): Promise<void> {
    await this.cmd(['SET', `mcp:revoked:jti:${jti}`, '1', 'EX', String(ttlSec)]);
  }

  async isJtiRevoked(jti: string): Promise<boolean> {
    const r = await this.cmd(['EXISTS', `mcp:revoked:jti:${jti}`]);
    return r === 1 || r === '1';
  }

  async revokeSubject(sub: string, ttlSec: number): Promise<void> {
    await this.cmd([
      'SET',
      `mcp:revoked:sub:${sub}`,
      String(Math.floor(Date.now() / 1000)),
      'EX',
      String(ttlSec),
    ]);
  }

  async isSubjectRevoked(sub: string, tokenIat?: number): Promise<boolean> {
    // GET, not EXISTS: the value is the revocation instant, and comparing it to
    // token.iat is what lets a re-authenticated user back in.
    const r = await this.cmd(['GET', `mcp:revoked:sub:${sub}`]);
    if (r == null) return false;
    if (tokenIat == null) return true;
    const revokedAt = Number(r);
    if (!Number.isFinite(revokedAt)) return true;
    return tokenIat <= revokedAt;
  }
}

const globalMemory = new MemoryAuthStateStore();

/**
 * Resolve the auth-state backend.
 * - AUTH_STATE_STORE=memory → in-process (tests / local)
 * - UPSTASH_REDIS_REST_* or KV_REST_API_* → Redis
 * - else throws AuthStateUnavailableError (fail closed)
 *
 * Vercel's Upstash Marketplace integration injects `KV_REST_API_URL` /
 * `KV_REST_API_TOKEN`, while a database created straight from the Upstash
 * console uses `UPSTASH_REDIS_REST_*`. Reading both keeps the integration the
 * single owner of the credential: hand-copying it into an alias survives until
 * the token is rotated and then fails closed for reasons nobody can see.
 *
 * `KV_REST_API_READ_ONLY_TOKEN` is deliberately not accepted — single-use code
 * consumption needs SET, and a read-only credential would turn every login into
 * a 503.
 */
export function createAuthStateStore(env: NodeJS.ProcessEnv = process.env): AuthStateStore {
  // The memory store is a module singleton, so on serverless it silently stops
  // enforcing single-use across instances — the same failure mode the signed
  // client registry exists to avoid. Fail at startup instead.
  if (env.AUTH_STATE_STORE === 'memory' && env.NODE_ENV === 'production') {
    throw new AuthStateUnavailableError(
      'AUTH_STATE_STORE=memory is forbidden when NODE_ENV=production — it cannot enforce single-use across instances',
    );
  }
  if (env.AUTH_STATE_STORE === 'memory' || env.VITEST === 'true') {
    return globalMemory;
  }
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url && token) {
    return new RedisAuthStateStore(url, token);
  }
  throw new AuthStateUnavailableError(
    'Auth state backend not configured — set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, ' +
      'or connect the Upstash Marketplace integration (KV_REST_API_URL + KV_REST_API_TOKEN). ' +
      'Use AUTH_STATE_STORE=memory only for tests.',
  );
}

export function getMemoryAuthStateStoreForTests(): MemoryAuthStateStore {
  return globalMemory;
}
