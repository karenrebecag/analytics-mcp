import { describe, expect, it } from 'vitest';
import { redisRestConfig } from '../src/core/redis-env.js';

const URL = 'https://eminent-example-00000.upstash.io';

describe('redis env resolution', () => {
  it('takes the Upstash console spelling', () => {
    expect(
      redisRestConfig({ UPSTASH_REDIS_REST_URL: URL, UPSTASH_REDIS_REST_TOKEN: 'tok' }),
    ).toEqual({ url: URL, token: 'tok' });
  });

  it('takes the names a Marketplace install injects', () => {
    expect(redisRestConfig({ KV_REST_API_URL: URL, KV_REST_API_TOKEN: 'tok' })).toEqual({
      url: URL,
      token: 'tok',
    });
  });

  /**
   * The case that actually happened: a Vercel project carrying empty
   * UPSTASH_* placeholders alongside a real Marketplace install. With `??` the
   * empty string wins and the store silently falls back to memory.
   */
  it('steps over a declared but empty variable', () => {
    expect(
      redisRestConfig({
        UPSTASH_REDIS_REST_URL: '',
        UPSTASH_REDIS_REST_TOKEN: '',
        KV_REST_API_URL: URL,
        KV_REST_API_TOKEN: 'tok',
      }),
    ).toEqual({ url: URL, token: 'tok' });
  });

  it('treats whitespace as empty, because a pasted value often is', () => {
    expect(
      redisRestConfig({
        UPSTASH_REDIS_REST_URL: '   ',
        KV_REST_API_URL: URL,
        KV_REST_API_TOKEN: 'tok',
      }),
    ).toEqual({ url: URL, token: 'tok' });
  });

  it('never accepts the read-only token, which cannot write a capture', () => {
    expect(
      redisRestConfig({ KV_REST_API_URL: URL, KV_REST_API_READ_ONLY_TOKEN: 'read-only' }),
    ).toBeNull();
  });

  it('reports nothing configured when either half is missing', () => {
    expect(redisRestConfig({ KV_REST_API_URL: URL })).toBeNull();
    expect(redisRestConfig({ KV_REST_API_TOKEN: 'tok' })).toBeNull();
    expect(redisRestConfig({})).toBeNull();
    // KV_URL and REDIS_URL are TCP connection strings; this server speaks REST.
    expect(redisRestConfig({ KV_URL: 'redis://x', REDIS_URL: 'rediss://x' })).toBeNull();
  });
});
