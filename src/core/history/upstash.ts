/**
 * One Redis sorted set per key: score = timestamp, member = "<at>:<value>".
 *
 * Sorted sets are the standard way to model a time series in Redis, and the
 * Upstash REST API covers the whole family. Reads are O(log N + M), so a key
 * holding years of entries still answers "what did this look like before X"
 * without scanning.
 *
 * The 'hist:' prefix keeps this out of the cache's keyspace. Sharing one Redis
 * is fine; sharing a keyspace between something that expires and something that
 * must not is how a history quietly loses its oldest half.
 */
import type { HistoryEntry, HistoryStore } from './types.js';

const PREFIX = 'hist:';
const DEFAULT_TIMEOUT_MS = 3_000;

export interface UpstashHistoryResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type UpstashHistoryFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<UpstashHistoryResponse>;

/** Members carry their own timestamp so two identical values never collide. */
function encode(at: number, value: string): string {
  return `${at}:${value}`;
}

function decode(member: string): HistoryEntry | null {
  const separator = member.indexOf(':');
  if (separator <= 0) return null;
  const at = Number(member.slice(0, separator));
  if (!Number.isFinite(at)) return null;
  return { at, value: member.slice(separator + 1) };
}

export function createUpstashHistory(opts: {
  url: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: UpstashHistoryFetch;
}): HistoryStore {
  const url = opts.url.replace(/\/$/, '');
  const token = opts.token;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl: UpstashHistoryFetch =
    opts.fetchImpl ??
    (async (href, init) => {
      const res = await fetch(href, init);
      return { ok: res.ok, status: res.status, json: () => res.json() };
    });

  async function cmd(args: unknown[]): Promise<unknown> {
    let res: UpstashHistoryResponse;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Swallow the cause: fetch errors and URLs can embed the token.
      throw new Error('Upstash history request failed');
    }
    if (!res.ok) throw new Error(`Upstash history REST ${res.status}`);
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new Error('Upstash history request failed');
    }
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed && parsed.error) {
      throw new Error('Upstash history command failed');
    }
    if (typeof parsed === 'object' && parsed !== null && 'result' in parsed) {
      return (parsed as { result: unknown }).result;
    }
    return null;
  }

  function members(result: unknown): HistoryEntry[] {
    if (!Array.isArray(result)) return [];
    return result
      .filter((item): item is string => typeof item === 'string')
      .map(decode)
      .filter((entry): entry is HistoryEntry => entry !== null);
  }

  return {
    async append(key: string, at: number, value: string): Promise<void> {
      await cmd(['ZADD', PREFIX + key, at, encode(at, value)]);
    },
    async latestBefore(key: string, at: number): Promise<HistoryEntry | null> {
      const result = await cmd(['ZREVRANGEBYSCORE', PREFIX + key, at, '-inf', 'LIMIT', 0, 1]);
      return members(result)[0] ?? null;
    },
    async range(key: string, from: number, to: number, limit?: number): Promise<HistoryEntry[]> {
      const args: unknown[] = ['ZRANGEBYSCORE', PREFIX + key, from, to];
      if (limit !== undefined) args.push('LIMIT', 0, limit);
      return members(await cmd(args));
    },
    async prune(key: string, before: number): Promise<number> {
      const result = await cmd(['ZREMRANGEBYSCORE', PREFIX + key, '-inf', `(${before}`]);
      return typeof result === 'number' ? result : 0;
    },
  };
}
