import type { CacheStore } from './types.js';

export function createMemoryCache(): CacheStore {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key: string): Promise<string | null> {
      const hit = store.get(key);
      if (!hit) return null;
      if (hit.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return hit.value;
    },
    async set(key: string, value: string, ttlSec: number): Promise<void> {
      store.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
    },
    async setIfAbsent(key: string, value: string, ttlSec: number): Promise<boolean> {
      const hit = store.get(key);
      if (hit && hit.expiresAt > Date.now()) return false;
      store.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });
      return true;
    },
  };
}
