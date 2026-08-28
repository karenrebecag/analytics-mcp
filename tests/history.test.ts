import { describe, expect, it } from 'vitest';
import { createHistoryStore, createMemoryHistory } from '../src/core/history/index.js';
import { createUpstashHistory, type UpstashHistoryFetch } from '../src/core/history/upstash.js';
import type { HistoryStore } from '../src/core/history/types.js';

/** One suite, both implementations: a contract nobody can drift out of. */
function contract(name: string, make: () => HistoryStore): void {
  describe(`${name} history contract`, () => {
    it('returns the most recent entry at or before a moment', async () => {
      const store = make();
      await store.append('k', 100, 'first');
      await store.append('k', 200, 'second');
      expect(await store.latestBefore('k', 150)).toEqual({ at: 100, value: 'first' });
      expect(await store.latestBefore('k', 200)).toEqual({ at: 200, value: 'second' });
      expect(await store.latestBefore('k', 50)).toBeNull();
    });

    it('has nothing to say about a key never written', async () => {
      const store = make();
      expect(await store.latestBefore('missing', Date.now())).toBeNull();
      expect(await store.range('missing', 0, Date.now())).toEqual([]);
    });

    it('reads a window in order', async () => {
      const store = make();
      for (const at of [300, 100, 200]) await store.append('k', at, `v${at}`);
      expect(await store.range('k', 100, 200)).toEqual([
        { at: 100, value: 'v100' },
        { at: 200, value: 'v200' },
      ]);
    });

    it('treats an identical write as a no-op, which a duplicated cron run needs', async () => {
      const store = make();
      await store.append('k', 100, 'same');
      await store.append('k', 100, 'same');
      expect(await store.range('k', 0, 999)).toHaveLength(1);
    });

    it('prunes only what is older than the cutoff', async () => {
      const store = make();
      for (const at of [100, 200, 300]) await store.append('k', at, `v${at}`);
      expect(await store.prune('k', 200)).toBe(1);
      expect(await store.range('k', 0, 999)).toEqual([
        { at: 200, value: 'v200' },
        { at: 300, value: 'v300' },
      ]);
    });
  });
}

contract('memory', createMemoryHistory);

/** A Redis stand-in that speaks only the commands the store actually sends. */
function fakeRedis(): UpstashHistoryFetch {
  const sets = new Map<string, Map<string, number>>();
  const members = (key: string): Map<string, number> => {
    const found = sets.get(key);
    if (found) return found;
    const created = new Map<string, number>();
    sets.set(key, created);
    return created;
  };
  const sorted = (key: string): Array<[string, number]> =>
    [...members(key).entries()].sort((a, b) => a[1] - b[1]);
  /** Redis '(' means exclusive, and which side it excludes depends on the end. */
  const bound = (raw: unknown): { value: number; exclusive: boolean } => {
    const text = String(raw);
    if (text === '-inf') return { value: -Infinity, exclusive: false };
    if (text === '+inf') return { value: Infinity, exclusive: false };
    return text.startsWith('(')
      ? { value: Number(text.slice(1)), exclusive: true }
      : { value: Number(text), exclusive: false };
  };
  const within = (
    score: number,
    min: { value: number; exclusive: boolean },
    max: { value: number; exclusive: boolean },
  ): boolean =>
    (min.exclusive ? score > min.value : score >= min.value) &&
    (max.exclusive ? score < max.value : score <= max.value);

  return async (_url, init) => {
    const args = JSON.parse(init.body) as unknown[];
    const [command, key] = [String(args[0]), String(args[1])];
    let result: unknown = null;
    if (command === 'ZADD') members(key).set(String(args[3]), Number(args[2]));
    else if (command === 'ZREVRANGEBYSCORE') {
      const max = bound(args[2]);
      const min = bound(args[3]);
      result = sorted(key)
        .filter(([, score]) => within(score, min, max))
        .reverse()
        .slice(0, Number(args[6] ?? 1))
        .map(([member]) => member);
    } else if (command === 'ZRANGEBYSCORE') {
      const min = bound(args[2]);
      const max = bound(args[3]);
      const found = sorted(key).filter(([, score]) => within(score, min, max));
      const limited = args[4] === 'LIMIT' ? found.slice(0, Number(args[6])) : found;
      result = limited.map(([member]) => member);
    } else if (command === 'ZREMRANGEBYSCORE') {
      const min = bound(args[2]);
      const max = bound(args[3]);
      const doomed = sorted(key).filter(([, score]) => within(score, min, max));
      for (const [member] of doomed) members(key).delete(member);
      result = doomed.length;
    }
    return { ok: true, status: 200, json: async () => ({ result }) };
  };
}

contract('upstash', () =>
  createUpstashHistory({ url: 'https://example.upstash.io', token: 't', fetchImpl: fakeRedis() }),
);

describe('upstash history transport', () => {
  const TOKEN = 'history-token-do-not-echo';

  it('namespaces keys away from the cache and keeps the token out of errors', async () => {
    const seen: unknown[][] = [];
    const store = createUpstashHistory({
      url: 'https://example.upstash.io/',
      token: TOKEN,
      fetchImpl: async (_url, init) => {
        seen.push(JSON.parse(init.body) as unknown[]);
        return { ok: true, status: 200, json: async () => ({ result: null }) };
      },
    });
    await store.append('page:a', 1, 'v');
    expect(seen[0]?.[1]).toBe('hist:page:a');

    const failing = createUpstashHistory({
      url: 'https://example.upstash.io',
      token: TOKEN,
      fetchImpl: async () => {
        throw new Error(`connect failed token=${TOKEN}`);
      },
    });
    await expect(failing.append('k', 1, 'v')).rejects.toThrow('Upstash history request failed');
    try {
      await failing.append('k', 1, 'v');
    } catch (err) {
      expect(err instanceof Error ? err.message : '').not.toContain(TOKEN);
    }
  });

  it('gives up on a hung request', async () => {
    const store = createUpstashHistory({
      url: 'https://example.upstash.io',
      token: TOKEN,
      timeoutMs: 20,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await expect(store.append('k', 1, 'v')).rejects.toThrow('Upstash history request failed');
  });
});

describe('history store resolution', () => {
  it('uses Upstash when it is configured, under either variable spelling', () => {
    expect(
      createHistoryStore({
        UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 't',
      }),
    ).not.toBeNull();
    expect(
      createHistoryStore({ KV_REST_API_URL: 'https://example.upstash.io', KV_REST_API_TOKEN: 't' }),
    ).not.toBeNull();
  });

  it('returns null on a serverless entry rather than a memory that dies with it', () => {
    expect(createHistoryStore({ VERCEL: '1' })).toBeNull();
  });

  it('falls back to memory only where a process actually persists', () => {
    expect(createHistoryStore({})).not.toBeNull();
  });
});
