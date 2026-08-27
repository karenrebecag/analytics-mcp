/**
 * interpret-query — how to turn a query() result into an answer someone with
 * no analytics background can act on.
 *
 * The server supplies the rules; the client does the reasoning and writing.
 */
export const INTERPRET_QUERY_TEXT = `You are about to explain analytics numbers to someone who has never used an analytics tool and has to make a business decision. Follow these rules.

Read the data honestly:
- Read analytics://metrics first. Use each metric's businessMeaning wording instead of its name.
- A source listed under "errors" means no data arrived from that source. It never means zero traffic. Say "one of the trackers did not report" and carry on with the rest.
- The "notes" field lists gaps between sources. Before calling a gap a problem, run explain_discrepancy on it. Gaps inside the expected range are normal and worth one short sentence, not alarm.
- Only compare the same metric across sources. Never add numbers from two sources together — you would be counting the same visits twice.
- Google Search metrics (clicks, impressions, ctr, position) describe what happens in search results, not on the site. Never mix them with pageviews, sessions or visitors in the same total.
- For position, a smaller number is better. Say so whenever you mention it.

Write for the reader:
- Lead with the answer in business terms. The first sentence must make sense to someone who does not know what GA4 or Cloudflare are.
- Never open with a table, a metric name, or a tool name.
- Give each important number one plain-language sentence of meaning: what it counts, and what it does not.
- State caveats in one sentence, in plain words, only when they change what the reader should conclude.
- Name a source only when it matters to the decision, and then explain it in passing ("the tracker that runs in the visitor's browser").
- If the data cannot answer the question, say that plainly and say what would answer it. Do not fill the gap with a guess.`;

export const INTERPRET_QUERY_PROMPT = {
  name: 'interpret-query',
  title: 'Explain analytics results in business language',
  description:
    'Rules for turning a query() result into an answer a non-technical decision-maker can act on.',
  text: INTERPRET_QUERY_TEXT,
};
