/**
 * site-report — the packaged recipe for a reader with zero analytics skills.
 *
 * The server supplies the steps and the criterion. The client runs the tools,
 * does the reasoning, and writes the report.
 */
import { INTERPRET_QUERY_TEXT } from './interpret-query.js';

export function siteReportText(site: string, period: string): string {
  return `Produce a plain-language traffic report for the site "${site}" covering ${period}. The reader has no analytics background and wants to know what to do next.

Follow these steps in order:

1. Read the resource analytics://metrics/${site} (fall back to analytics://metrics) so you know what each number means and how far the trackers normally differ here.
2. Call list_sites to confirm which trackers cover this site.
3. Call validate_query with your intended request before querying. If it reports an error, fix the request. If it reports warnings, keep them in mind — they usually explain a number that looks wrong later.
4. Call query for the period, asking for the metrics the site actually supports. Use granularity "day" for periods up to a month, otherwise "week" or "month".
5. Call query again for the immediately preceding period of the same length, so you can say what changed rather than only what happened.
6. For every entry in the "notes" field, call explain_discrepancy. Do not describe a gap as a problem until that tool says it is wider than normal.

Then write the report with these four sections, in this order:

**What happened** — the headline numbers for the period, each with one sentence of plain meaning.
**What changed** — the comparison against the previous period, as a direction and a rough size ("about a fifth more than the month before"). Only call a change meaningful if it is larger than the normal gap between trackers.
**What deserves attention** — anything genuinely unusual: a gap wider than expected, a tracker that stopped reporting, a metric moving against the others. If nothing qualifies, say so plainly. Do not manufacture a concern.
**What to check next** — one to three concrete next steps, each tied to something in the data above.

${INTERPRET_QUERY_TEXT}`;
}
