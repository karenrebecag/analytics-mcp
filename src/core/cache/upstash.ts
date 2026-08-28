import type { CacheStore } from './types.js';

export interface UpstashFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type UpstashFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<UpstashFetchResponse>;

// A cache is an optimisation. Without a deadline a slow Upstash stops being one
// and becomes the thing the caller waits for, on a request it could have served
// from the source instead.
const DEFAULT_TIMEOUT_MS = 3_000;

export function createUpstashCache(opts: {
  url: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: UpstashFetch;
}): CacheStore {
  const url = opts.url.replace(/\/$/, '');
  const token = opts.token;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl: UpstashFetch =
    opts.fetchImpl ??
    (async (href, init) => {
      const res = await fetch(href, init);
      return { ok: res.ok, status: res.status, json: () => res.json() };
    });

  async function cmd(body: unknown[]): Promise<unknown> {
    let res: UpstashFetchResponse;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Swallow the cause: fetch errors and URLs can embed the token.
      throw new Error('Upstash request failed');
    }
    if (!res.ok) {
      throw new Error(`Upstash REST ${res.status}`);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new Error('Upstash request failed');
    }
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed && parsed.error) {
      throw new Error('Upstash command failed');
    }
    if (typeof parsed === 'object' && parsed !== null && 'result' in parsed) {
      return (parsed as { result: unknown }).result;
    }
    return null;
  }

  return {
    async get(key: string): Promise<string | null> {
      const result = await cmd(['GET', key]);
      return typeof result === 'string' ? result : null;
    },
    async set(key: string, value: string, ttlSec: number): Promise<void> {
      await cmd(['SET', key, value, 'EX', ttlSec]);
    },
  };
}
