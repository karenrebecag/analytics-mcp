import type { CacheStore } from './types.js';
import { createMemoryCache } from './memory.js';
import { createUpstashCache } from './upstash.js';
import { redisRestConfig } from '../redis-env.js';

export type { CacheStore } from './types.js';
export { createMemoryCache } from './memory.js';
export { createUpstashCache } from './upstash.js';

export function createCacheStore(
  env: Record<string, string | undefined> = process.env,
): CacheStore {
  const redis = redisRestConfig(env);
  if (redis) return createUpstashCache(redis);
  return createMemoryCache();
}

let injected: CacheStore | null = null;
let singleton: CacheStore | null = null;

export function getCacheStore(env: Record<string, string | undefined> = process.env): CacheStore {
  if (injected) return injected;
  if (!singleton) singleton = createCacheStore(env);
  return singleton;
}

export function setCacheStoreForTests(store: CacheStore | null): void {
  injected = store;
  if (store === null) singleton = null;
}
