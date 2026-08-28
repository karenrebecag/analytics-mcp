/**
 * Durable, append-only record of how something looked at a point in time.
 *
 * Deliberately NOT CacheStore. A cache expires by design; a history that
 * expires is corrupted. WebflowATOM_mcp's api/_shared/kv.ts drew the same line
 * against its auth-state store and said so in its header for the same reason.
 */
export interface HistoryEntry {
  at: number;
  value: string;
}

export interface HistoryStore {
  /** Writing the same (key, at, value) twice is a no-op, not a duplicate. */
  append(key: string, at: number, value: string): Promise<void>;
  /** The most recent entry at or before `at`, or null when there is none. */
  latestBefore(key: string, at: number): Promise<HistoryEntry | null>;
  range(key: string, from: number, to: number, limit?: number): Promise<HistoryEntry[]>;
  /** Retention. Returns how many entries were removed. */
  prune(key: string, before: number): Promise<number>;
}
