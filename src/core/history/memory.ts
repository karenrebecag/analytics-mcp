/**
 * In-process history. Honest ONLY under stdio, where one process owns the whole
 * session.
 *
 * uikit-atom-mcp's api/_shared/client-registry.ts records what a module-level
 * Map cost this codebase in a serverless deployment: one lambda could not see
 * what another had written, and an allowlist went silently unenforced. State
 * that does not outlive the instance is a bug there, not a fallback — which is
 * why index.ts returns null rather than this on a serverless entry.
 */
import type { HistoryEntry, HistoryStore } from './types.js';

export function createMemoryHistory(): HistoryStore {
  const store = new Map<string, HistoryEntry[]>();

  function entries(key: string): HistoryEntry[] {
    const existing = store.get(key);
    if (existing) return existing;
    const created: HistoryEntry[] = [];
    store.set(key, created);
    return created;
  }

  return {
    async append(key: string, at: number, value: string): Promise<void> {
      const list = entries(key);
      if (list.some((entry) => entry.at === at && entry.value === value)) return;
      list.push({ at, value });
      list.sort((a, b) => a.at - b.at);
    },
    async latestBefore(key: string, at: number): Promise<HistoryEntry | null> {
      const candidates = entries(key).filter((entry) => entry.at <= at);
      return candidates.length > 0 ? candidates[candidates.length - 1] : null;
    },
    async range(key: string, from: number, to: number, limit?: number): Promise<HistoryEntry[]> {
      const found = entries(key).filter((entry) => entry.at >= from && entry.at <= to);
      return limit === undefined ? found : found.slice(0, limit);
    },
    async prune(key: string, before: number): Promise<number> {
      const list = entries(key);
      const kept = list.filter((entry) => entry.at >= before);
      const removed = list.length - kept.length;
      store.set(key, kept);
      return removed;
    },
  };
}
