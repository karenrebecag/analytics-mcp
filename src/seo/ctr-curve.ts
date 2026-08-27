/**
 * How much click-through a position normally earns — measured on this site,
 * not imported.
 *
 * Published CTR-by-position curves vary enormously by industry, language and
 * which SERP features sit above the results. Importing one would be a made-up
 * number wearing a data costume: it would confidently call pages "broken" for
 * missing a benchmark they were never subject to. So the curve is built from
 * the caller's own Search Console rows, and when the caller's data is too thin
 * to say anything, the honest answer is that we cannot say.
 *
 * Pure: no I/O, no env, no config.
 */

/** Rows below this are noise; including them distorts the curve. */
export const MIN_ROW_IMPRESSIONS = 10;
/** A bucket thinner than this cannot support a verdict. */
export const MIN_BUCKET_IMPRESSIONS = 500;
/** Positions past this are pooled: the tail behaves the same. */
export const MAX_BUCKET = 20;

export interface SearchRow {
  page: string;
  clicks: number;
  impressions: number;
  position: number;
}

export interface CtrBucket {
  /** Integer position; MAX_BUCKET means "this position or worse". */
  position: number;
  ctr: number;
  clicks: number;
  impressions: number;
  pages: number;
}

export type CtrCurve = Map<number, CtrBucket>;

export function bucketOf(position: number): number {
  if (!Number.isFinite(position) || position < 1) return 1;
  return Math.min(Math.floor(position), MAX_BUCKET);
}

/**
 * Weighted per bucket: sum(clicks) / sum(impressions).
 *
 * Never the mean of per-row ctr values. CTR is a rate, and averaging rates
 * gives a page with 12 impressions the same vote as one with 12,000.
 */
export function buildCtrCurve(rows: SearchRow[]): CtrCurve {
  const curve: CtrCurve = new Map();
  for (const row of rows) {
    if (row.impressions < MIN_ROW_IMPRESSIONS) continue;
    const key = bucketOf(row.position);
    const bucket = curve.get(key) ?? {
      position: key,
      ctr: 0,
      clicks: 0,
      impressions: 0,
      pages: 0,
    };
    bucket.clicks += row.clicks;
    bucket.impressions += row.impressions;
    bucket.pages += 1;
    curve.set(key, bucket);
  }
  for (const bucket of curve.values()) {
    bucket.ctr = bucket.impressions > 0 ? bucket.clicks / bucket.impressions : 0;
  }
  return curve;
}

export interface CtrExpectation {
  ctr: number;
  /** Impressions the expectation rests on — the reader's basis for trusting it. */
  impressions: number;
  /** True when neighbouring positions were pooled to reach a usable sample. */
  widened: boolean;
}

/**
 * What this site normally earns at a position, or undefined when its own data
 * is too thin to support a verdict.
 */
export function expectedCtr(curve: CtrCurve, position: number): CtrExpectation | undefined {
  const key = bucketOf(position);
  const exact = curve.get(key);
  if (exact && exact.impressions >= MIN_BUCKET_IMPRESSIONS) {
    return { ctr: exact.ctr, impressions: exact.impressions, widened: false };
  }

  // One widening step to the immediate neighbours, then give up.
  let clicks = exact?.clicks ?? 0;
  let impressions = exact?.impressions ?? 0;
  for (const neighbour of [key - 1, key + 1]) {
    const b = curve.get(neighbour);
    if (!b) continue;
    clicks += b.clicks;
    impressions += b.impressions;
  }
  if (impressions < MIN_BUCKET_IMPRESSIONS) return undefined;
  return { ctr: clicks / impressions, impressions, widened: true };
}

/** The curve as a plain array, for rendering. */
export function curvePoints(curve: CtrCurve): CtrBucket[] {
  return [...curve.values()].sort((a, b) => a.position - b.position);
}
