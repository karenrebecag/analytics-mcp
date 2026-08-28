/**
 * page_changes — what changed on a page, when, and what the search numbers did
 * on either side of it.
 *
 * This is the loop F8 and F9 exist to close: a verdict, a change, and evidence
 * about whether the change helped. The evidence is a correlation in time and is
 * labelled as one — other things move too, and a tool that quietly implied
 * causation would be inventing the certainty this project refuses to invent.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getSite, loadSites } from '../config/sites.js';
import { getHistoryStore } from '../core/history/index.js';
import type { HistoryEntry, HistoryStore } from '../core/history/types.js';
import { jsonResult, runTool } from '../core/tool-result.js';
import { historyKey } from '../page/capture.js';
import type { PageFacts } from '../page/types.js';
import type { BindingFor, DateRange } from '../sources/types.js';
import { fetchSearchRows } from './seo-opportunities.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be yyyy-mm-dd');

export const pageChangesSchema = z.object({
  site: z.string().min(1),
  page: z
    .string()
    .min(1)
    .optional()
    .describe('Full URL or a distinctive part of the path. Omit to cover the busiest pages.'),
  range: z.object({ start: isoDate, end: isoDate }).strict().optional(),
  limit: z.number().int().positive().max(50).optional(),
});

const NO_STORE =
  'No history store is configured, so there is nothing to compare against. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to start recording.';

/** Fields whose movement a reader would call "the page changed". */
const TRACKED = [
  'title',
  'metaDescription',
  'canonical',
  'robotsMeta',
  'ogTitle',
  'ogDescription',
  'status',
  'redirectTo',
] as const;

export interface FieldChange {
  field: string;
  from: string | number | null;
  to: string | number | null;
}

function diff(before: PageFacts, after: PageFacts): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of TRACKED) {
    const from = before[field] ?? null;
    const to = after[field] ?? null;
    if (from !== to) changes.push({ field, from, to });
  }
  const beforeH1 = before.h1s.join(' | ');
  const afterH1 = after.h1s.join(' | ');
  if (beforeH1 !== afterH1) changes.push({ field: 'h1s', from: beforeH1, to: afterH1 });
  return changes;
}

/**
 * Reads from the beginning of the key, not from the window, so the first entry
 * can be recognised as the baseline. Without that, the day capture first ran
 * would be reported as the day the page changed.
 */
async function readEntries(history: HistoryStore, key: string, to: number): Promise<PageFacts[]> {
  const entries = await history.range(key, 0, to);
  return entries
    .map((entry: HistoryEntry) => {
      try {
        return JSON.parse(entry.value) as PageFacts;
      } catch {
        return null;
      }
    })
    .filter((facts): facts is PageFacts => facts !== null);
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Search numbers for the fortnight before and after a change. */
async function searchAround(
  siteId: string,
  binding: BindingFor<'gsc'>,
  page: string,
  changedAt: number,
): Promise<{ before: SearchSlice; after: SearchSlice } | null> {
  const span = 14 * 86_400_000;
  const beforeRange: DateRange = { start: day(changedAt - span), end: day(changedAt - 86_400_000) };
  const afterRange: DateRange = { start: day(changedAt + 86_400_000), end: day(changedAt + span) };
  if (new Date(afterRange.start).getTime() > Date.now()) return null;

  const [beforeRows, afterRows] = await Promise.all([
    fetchSearchRows(siteId, binding, beforeRange),
    fetchSearchRows(siteId, binding, afterRange),
  ]);
  const pick = (rows: Awaited<ReturnType<typeof fetchSearchRows>>): SearchSlice => {
    const row = rows.find((candidate) => candidate.page === page);
    if (!row) return { clicks: 0, impressions: 0, ctrPct: 0, position: null };
    return {
      clicks: row.clicks,
      impressions: row.impressions,
      ctrPct: row.impressions > 0 ? Number(((row.clicks / row.impressions) * 100).toFixed(2)) : 0,
      position: row.position,
    };
  };
  return { before: pick(beforeRows), after: pick(afterRows) };
}

interface SearchSlice {
  clicks: number;
  impressions: number;
  ctrPct: number;
  position: number | null;
}

export async function handlePageChanges(
  args: z.infer<typeof pageChangesSchema>,
): Promise<CallToolResult> {
  return runTool(async () => {
    const site = getSite(loadSites(), args.site);
    const history = getHistoryStore();
    if (!history) return jsonResult({ site: args.site, changes: [], reason: NO_STORE });

    const binding = site.sources.gsc;
    if (!binding) throw new Error(`Site '${args.site}' has no Search Console binding.`);

    const to = args.range ? new Date(`${args.range.end}T23:59:59Z`).getTime() : Date.now();
    const from = args.range ? new Date(`${args.range.start}T00:00:00Z`).getTime() : 0;

    const lookback: DateRange = {
      start: day(Date.now() - 28 * 86_400_000),
      end: day(Date.now()),
    };
    const rows = await fetchSearchRows(args.site, binding, lookback);
    const needle = args.page?.toLowerCase();
    const targets = (needle ? rows.filter((row) => row.page.toLowerCase().includes(needle)) : rows)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, args.limit ?? (needle ? 5 : 20));

    if (targets.length === 0) {
      return jsonResult({
        site: args.site,
        changes: [],
        reason: needle
          ? 'No page matching that text has search data in the last 28 days.'
          : 'This site has no pages with search data in the last 28 days.',
      });
    }

    const results = [];
    for (const target of targets) {
      const facts = await readEntries(history, historyKey(args.site, target.page), to);
      if (facts.length === 0) {
        results.push({ page: target.page, recorded: false });
        continue;
      }
      const changes = [];
      for (let index = 1; index < facts.length; index += 1) {
        const at = new Date(facts[index].fetchedAt).getTime();
        if (at < from || at > to) continue;
        changes.push({
          at: facts[index].fetchedAt,
          fields: diff(facts[index - 1], facts[index]),
        });
      }
      results.push({
        page: target.page,
        recorded: true,
        firstSeen: facts[0].fetchedAt,
        changes,
      });
    }

    // Search evidence is expensive (two extra queries) and only meaningful for
    // one page at a time, so it is attached only when one page was asked for.
    let evidence: unknown;
    if (needle && results.length === 1 && results[0].recorded) {
      const changes = results[0].changes ?? [];
      const last = changes[changes.length - 1];
      if (last) {
        const around = await searchAround(
          args.site,
          binding,
          results[0].page,
          new Date(last.at).getTime(),
        );
        if (around) {
          evidence = {
            changedAt: last.at,
            ...around,
            caveat:
              'These are the fortnights either side of the change. A move here is a coincidence in time, not proof of cause: rankings, seasonality and other edits move too.',
          };
        }
      }
    }

    return jsonResult({
      site: args.site,
      pages: results,
      ...(evidence ? { searchAroundLastChange: evidence } : {}),
      note: 'Only changes are recorded, so a page with no entries after the first has not changed since capture began.',
    });
  });
}
