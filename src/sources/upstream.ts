export const DEFAULT_TIMEOUT_MS = 10_000;
export const ERROR_BODY_LIMIT = 300;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function resolveTimeout(timeoutMs?: number): number {
  return timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
}

/** Truncate upstream bodies; never attach request headers (they carry Bearer tokens). */
export function upstreamError(source: string, status: number, body: string): Error {
  const snippet = body.slice(0, ERROR_BODY_LIMIT);
  const suffix = body.length > ERROR_BODY_LIMIT ? '…' : '';
  return new Error(`${source} ${status}: ${snippet}${suffix}`);
}

export async function fetchUpstream(opts: {
  source: string;
  url: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<unknown> {
  let res: Response;
  try {
    res = await opts.fetchImpl(opts.url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      body: opts.body,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`${opts.source} timeout after ${opts.timeoutMs}ms`);
    }
    throw new Error(`${opts.source} request failed`);
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`${opts.source} timeout after ${opts.timeoutMs}ms`);
    }
    throw new Error(`${opts.source} request failed`);
  }
  if (!res.ok) throw upstreamError(opts.source, res.status, text);

  if (!text) throw new Error(`${opts.source} empty response`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw upstreamError(opts.source, res.status, 'invalid JSON');
  }
}

export function asRecord(source: string, json: unknown): Record<string, unknown> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error(`${source} invalid response`);
  }
  return json as Record<string, unknown>;
}
