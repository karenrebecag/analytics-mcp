export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  /**
   * Atomic claim: true when the key did not exist and is now ours. A lock
   * belongs in the cache rather than the history store precisely because it
   * MUST expire — a lock that outlives the run that took it is a deadlock.
   */
  setIfAbsent(key: string, value: string, ttlSec: number): Promise<boolean>;
}
