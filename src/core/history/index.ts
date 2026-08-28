/**
 * Resolves the history backend, or reports that there is none.
 *
 * Returning null is the contract, not an error path: history is optional, and a
 * deployment without a store degrades to "no earlier capture to compare
 * against". What it must never do is pretend to remember — which is why a
 * serverless entry with nothing configured gets null rather than the in-memory
 * store, whose contents die with the instance.
 */
import type { HistoryStore } from './types.js';
import { createMemoryHistory } from './memory.js';
import { createUpstashHistory } from './upstash.js';

export type { HistoryEntry, HistoryStore } from './types.js';
export { createMemoryHistory } from './memory.js';
export { createUpstashHistory } from './upstash.js';

export function createHistoryStore(
  env: Record<string, string | undefined> = process.env,
): HistoryStore | null {
  const url = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
  if (url && token) return createUpstashHistory({ url, token });
  // On Vercel there is no process to keep anything in.
  if (env.VERCEL) return null;
  return createMemoryHistory();
}

let injected: HistoryStore | null = null;
let injectedSet = false;
let singleton: HistoryStore | null = null;
let resolved = false;

export function getHistoryStore(
  env: Record<string, string | undefined> = process.env,
): HistoryStore | null {
  if (injectedSet) return injected;
  if (!resolved) {
    singleton = createHistoryStore(env);
    resolved = true;
  }
  return singleton;
}

export function setHistoryStoreForTests(store: HistoryStore | null, active = true): void {
  injected = store;
  injectedSet = active;
  if (!active) {
    singleton = null;
    resolved = false;
  }
}
