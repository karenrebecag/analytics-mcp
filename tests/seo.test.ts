import { describe, expect, it } from 'vitest';
import {
  MIN_BUCKET_IMPRESSIONS,
  bucketOf,
  buildCtrCurve,
  expectedCtr,
  type SearchRow,
} from '../src/seo/ctr-curve.js';
import { ctrGaps, decayed, strikingDistance } from '../src/seo/opportunities.js';
import { AI_REFERRAL_CAVEAT, matchAssistant } from '../src/seo/ai-sources.js';

function row(page: string, clicks: number, impressions: number, position: number): SearchRow {
  return { page, clicks, impressions, position };
}

describe('ctr curve', () => {
  it('weights by impressions instead of averaging rates', () => {
    // A tiny page at 50% and a large one at 1%. The mean of the rates would be
    // ~25%; the weighted rate is barely above 1%, which is the truthful one.
    const curve = buildCtrCurve([row('/small', 5, 10, 6), row('/big', 100, 10_000, 6)]);
    const bucket = curve.get(6)!;
    expect(bucket.ctr).toBeCloseTo(105 / 10_010, 5);
    expect(bucket.ctr).toBeLessThan(0.02);
  });

  it('ignores rows too small to mean anything', () => {
    const curve = buildCtrCurve([row('/noise', 1, 2, 3)]);
    expect(curve.get(3)).toBeUndefined();
  });

  it('pools everything past the tail into one bucket', () => {
    expect(bucketOf(21)).toBe(20);
    expect(bucketOf(87)).toBe(20);
    expect(bucketOf(0.4)).toBe(1);
  });

  it('refuses a verdict when the caller own data is thin', () => {
    const curve = buildCtrCurve([row('/a', 10, 100, 4)]);
    expect(expectedCtr(curve, 4)).toBeUndefined();
  });

  it('widens to neighbours once before giving up', () => {
    const curve = buildCtrCurve([
      row('/a', 20, 300, 4),
      row('/b', 30, 300, 5),
      row('/c', 10, 300, 6),
    ]);
    const wide = expectedCtr(curve, 5);
    expect(wide?.widened).toBe(true);
    expect(wide!.impressions).toBeGreaterThanOrEqual(MIN_BUCKET_IMPRESSIONS);
  });
});

describe('opportunities', () => {
  const rows = [
    row('/healthy-a', 60, 1000, 6),
    row('/healthy-b', 55, 1000, 6),
    row('/starved', 2, 5000, 6),
    row('/close', 5, 800, 9),
  ];
  const curve = buildCtrCurve(rows);

  it('ranks ctr gaps by missed clicks and explains the fix', () => {
    const gaps = ctrGaps(rows, curve);
    expect(gaps[0].page).toBe('/starved');
    expect(gaps[0].missedClicks).toBeGreaterThan(50);
    expect(gaps[0].reason).toMatch(/less/i);
  });

  it('leaves pages performing at their position alone', () => {
    const pages = ctrGaps(rows, curve).map((g) => g.page);
    expect(pages).not.toContain('/healthy-a');
  });

  it('surfaces striking distance ranked by audience already looking', () => {
    const striking = strikingDistance(rows);
    expect(striking.map((s) => s.page)).toContain('/close');
    expect(striking[0].reason).toMatch(/lower positions are better/i);
  });

  it('reports no decay rather than guessing one without a previous period', () => {
    expect(decayed(rows, [])).toEqual([]);
  });

  it('finds pages that slipped', () => {
    const before = [row('/starved', 400, 5000, 3)];
    const losses = decayed(rows, before);
    expect(losses[0].page).toBe('/starved');
    expect(losses[0].lostClicks).toBe(398);
    expect(losses[0].reason).toMatch(/higher is worse/i);
  });
});

describe('assistant matching', () => {
  it('recognises the spellings analytics actually reports', () => {
    expect(matchAssistant('chatgpt.com')).toBe('ChatGPT');
    expect(matchAssistant('chat.openai.com')).toBe('ChatGPT');
    expect(matchAssistant('www.perplexity.ai')).toBe('Perplexity');
    expect(matchAssistant('claude.ai')).toBe('Claude');
  });

  it('does not mistake ordinary search for an assistant', () => {
    expect(matchAssistant('google')).toBeUndefined();
    expect(matchAssistant('bing')).toBeUndefined();
    expect(matchAssistant('l.facebook.com')).toBeUndefined();
  });

  it('states that arrivals are not citations', () => {
    expect(AI_REFERRAL_CAVEAT).toMatch(/not measure/i);
    expect(AI_REFERRAL_CAVEAT).toMatch(/cite/i);
  });
});
