/**
 * Ranked SEO opportunities, all measured in estimated missed clicks.
 *
 * A score out of 100 tells a reader nothing they can act on. "This page is
 * leaving about 430 clicks a month on the table" tells them whether it is
 * worth an afternoon. Pure functions over Search Console rows plus the site's
 * own CTR curve — no I/O, no env.
 */
import { expectedCtr, type CtrCurve, type SearchRow } from './ctr-curve.js';

/** Below this an opportunity is noise dressed as a finding. */
export const MIN_MISSED_CLICKS = 5;
/** Close enough to the top that pushing beats writing something new. */
export const STRIKING_MIN_POSITION = 5;
export const STRIKING_MAX_POSITION = 15;
export const STRIKING_MIN_IMPRESSIONS = 100;

export interface CtrGap {
  page: string;
  position: number;
  impressions: number;
  clicks: number;
  actualCtr: number;
  expectedCtr: number;
  missedClicks: number;
  basedOnImpressions: number;
  reason: string;
}

/**
 * Pages that rank but do not get clicked: they appear where this site normally
 * earns far more. That is a title and description problem, not a ranking one —
 * the distinction matters because the fixes are completely different.
 */
export function ctrGaps(rows: SearchRow[], curve: CtrCurve): CtrGap[] {
  const out: CtrGap[] = [];
  for (const row of rows) {
    if (row.impressions <= 0) continue;
    const expectation = expectedCtr(curve, row.position);
    if (!expectation) continue;
    const actualCtr = row.clicks / row.impressions;
    if (actualCtr >= expectation.ctr) continue;
    const missedClicks = row.impressions * (expectation.ctr - actualCtr);
    if (missedClicks < MIN_MISSED_CLICKS) continue;
    const times = actualCtr > 0 ? expectation.ctr / actualCtr : Infinity;
    out.push({
      page: row.page,
      position: row.position,
      impressions: row.impressions,
      clicks: row.clicks,
      actualCtr,
      expectedCtr: expectation.ctr,
      missedClicks: Math.round(missedClicks),
      basedOnImpressions: expectation.impressions,
      reason:
        times === Infinity
          ? `Shown ${row.impressions} times and never clicked, at a position where this site usually earns ${(expectation.ctr * 100).toFixed(1)}%.`
          : `Earns ${(actualCtr * 100).toFixed(2)}% where this site usually earns ${(expectation.ctr * 100).toFixed(1)}% at the same position — about ${times.toFixed(1)}x less.`,
    });
  }
  return out.sort((a, b) => b.missedClicks - a.missedClicks);
}

export interface StrikingDistance {
  page: string;
  position: number;
  impressions: number;
  clicks: number;
  reason: string;
}

/**
 * Pages sitting just outside the places that get clicked. Ranked by the
 * audience already seeing them: the same rank push is worth more where more
 * people are looking.
 */
export function strikingDistance(rows: SearchRow[]): StrikingDistance[] {
  return rows
    .filter(
      (row) =>
        row.position >= STRIKING_MIN_POSITION &&
        row.position <= STRIKING_MAX_POSITION &&
        row.impressions >= STRIKING_MIN_IMPRESSIONS,
    )
    .map((row) => ({
      page: row.page,
      position: row.position,
      impressions: row.impressions,
      clicks: row.clicks,
      reason: `Averages position ${row.position.toFixed(1)} with ${row.impressions} appearances. Moving it up a few places costs less than writing a new page, because the audience is already there. Lower positions are better.`,
    }))
    .sort((a, b) => b.impressions - a.impressions);
}

export interface Decay {
  page: string;
  positionBefore: number;
  positionAfter: number;
  clicksBefore: number;
  clicksAfter: number;
  lostClicks: number;
  reason: string;
}

/**
 * Pages that got worse between two periods. Requires both: with no previous
 * data the honest output is an empty list, never an inferred trend.
 */
export function decayed(current: SearchRow[], previous: SearchRow[]): Decay[] {
  if (previous.length === 0) return [];
  const before = new Map(previous.map((row) => [row.page, row]));
  const out: Decay[] = [];
  for (const row of current) {
    const was = before.get(row.page);
    if (!was) continue;
    const lostClicks = was.clicks - row.clicks;
    const droppedPosition = row.position - was.position;
    if (lostClicks < MIN_MISSED_CLICKS && droppedPosition <= 1) continue;
    out.push({
      page: row.page,
      positionBefore: was.position,
      positionAfter: row.position,
      clicksBefore: was.clicks,
      clicksAfter: row.clicks,
      lostClicks: Math.max(0, Math.round(lostClicks)),
      reason:
        droppedPosition > 1
          ? `Slipped from position ${was.position.toFixed(1)} to ${row.position.toFixed(1)} (higher is worse) and lost ${Math.max(0, Math.round(lostClicks))} clicks.`
          : `Held its position but lost ${Math.round(lostClicks)} clicks — demand for the topic may have moved, or a competitor now answers it better.`,
    });
  }
  return out.sort((a, b) => b.lostClicks - a.lostClicks);
}
