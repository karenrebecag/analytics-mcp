import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCacheStore } from '../src/core/cache/index.js';
import { createMemoryCache } from '../src/core/cache/memory.js';
import { createUpstashCache, type UpstashFetch } from '../src/core/cache/upstash.js';

describe('memory cache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns stored values before TTL', async () => {
    const cache = createMemoryCache();
    await cache.set('k', 'v', 60);
    expect(await cache.get('k')).toBe('v');
    expect(await cache.get('missing')).toBeNull();
  });

  it('deletes expired entries on read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const cache = createMemoryCache();
    await cache.set('k', 'v', 10);
    expect(await cache.get('k')).toBe('v');
    vi.advanceTimersByTime(10_001);
    expect(await cache.get('k')).toBeNull();
  });
});

describe('upstash cache', () => {
  const TOKEN = 'upstash-test-token-do-not-echo';

  it('sends GET/SET REST bodies with a Bearer header', async () => {
    const calls: Array<{
      url: string;
      init: { method: string; headers: Record<string, string>; body: string };
    }> = [];
    const fetchImpl: UpstashFetch = async (url, init) => {
      calls.push({ url, init });
      const cmd = JSON.parse(init.body) as unknown[];
      if (cmd[0] === 'GET') {
        return { ok: true, status: 200, json: async () => ({ result: 'cached-value' }) };
      }
      return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
    };

    const cache = createUpstashCache({
      url: 'https://example.upstash.io/',
      token: TOKEN,
      fetchImpl,
    });

    expect(await cache.get('my-key')).toBe('cached-value');
    await cache.set('my-key', 'next', 300);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://example.upstash.io');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(calls[0]?.init.body ?? '')).toEqual(['GET', 'my-key']);
    expect(JSON.parse(calls[1]?.init.body ?? '')).toEqual(['SET', 'my-key', 'next', 'EX', 300]);
  });

  it('keeps the token out of thrown error messages', async () => {
    const fetchImpl: UpstashFetch = async () => {
      throw new Error(`connect failed token=${TOKEN}`);
    };
    const cache = createUpstashCache({
      url: 'https://example.upstash.io',
      token: TOKEN,
      fetchImpl,
    });
    await expect(cache.get('k')).rejects.toThrow('Upstash request failed');
    try {
      await cache.get('k');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(TOKEN);
    }

    const failingJson = createUpstashCache({
      url: 'https://example.upstash.io',
      token: TOKEN,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ error: `NOAUTH ${TOKEN}` }),
      }),
    });
    await expect(failingJson.get('k')).rejects.toThrow('Upstash command failed');
    try {
      await failingJson.get('k');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(TOKEN);
    }
  });

  it('gives up on a hung request instead of waiting forever', async () => {
    const cache = createUpstashCache({
      url: 'https://example.upstash.io',
      token: TOKEN,
      timeoutMs: 20,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await expect(cache.get('k')).rejects.toThrow('Upstash request failed');
  });
});

describe('createCacheStore', () => {
  it('uses memory when Upstash env is incomplete', async () => {
    const cache = createCacheStore({ UPSTASH_REDIS_REST_URL: 'https://example.upstash.io' });
    await cache.set('k', 'v', 60);
    expect(await cache.get('k')).toBe('v');
  });

  it('accepts the names a Vercel Marketplace install injects', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 'from-upstash' }),
    } as Response);
    try {
      const cache = createCacheStore({
        KV_REST_API_URL: 'https://example.upstash.io',
        KV_REST_API_TOKEN: 'kv-token',
      });
      // Memory would answer null without ever reaching for the network.
      expect(await cache.get('k')).toBe('from-upstash');
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('uses Upstash when both env vars are set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 'from-upstash' }),
    } as Response);
    try {
      const cache = createCacheStore({
        UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 'tok',
      });
      expect(await cache.get('k')).toBe('from-upstash');
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
