/**
 * Which environment names count as "a Redis is configured", in one place.
 *
 * Two stores read this — the cache and the history — and they disagreeing once
 * already produced a deployment that half worked. One source of truth is the
 * fix for the class, not just the instance.
 *
 * A DECLARED BUT EMPTY variable is the case that matters. Vercel projects
 * routinely carry a placeholder with no value, and `??` does not fall through
 * an empty string: `'' ?? 'other'` is `''`. Left that way, an empty
 * UPSTASH_REDIS_REST_URL beats a populated KV_REST_API_URL and the store
 * silently falls back to memory. Empty means absent here.
 */
export interface RedisRestConfig {
  url: string;
  token: string;
}

function firstValue(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim() !== '');
}

/**
 * A Marketplace install injects KV_REST_API_*; a database made in the Upstash
 * console gives UPSTASH_REDIS_REST_*. KV_REST_API_READ_ONLY_TOKEN is
 * deliberately NOT accepted: it reads and cannot write, so taking it would let
 * captures fail one at a time while every read looked healthy.
 */
export function redisRestConfig(
  env: Record<string, string | undefined> = process.env,
): RedisRestConfig | null {
  const url = firstValue(env.UPSTASH_REDIS_REST_URL, env.KV_REST_API_URL);
  const token = firstValue(env.UPSTASH_REDIS_REST_TOKEN, env.KV_REST_API_TOKEN);
  return url && token ? { url, token } : null;
}
