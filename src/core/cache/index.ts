import type { CacheStore } from './types.js';
import { createMemoryCache } from './memory.js';
import { createUpstashCache } from './upstash.js';

export type { CacheStore } from './types.js';
export { createMemoryCache } from './memory.js';
export { createUpstashCache } from './upstash.js';

export function createCacheStore(
  env: Record<string, string | undefined> = process.env,
): CacheStore {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return createUpstashCache({ url, token });
  return createMemoryCache();
}
