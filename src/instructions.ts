export const INSTRUCTIONS =
  'Unified web analytics (GA4, Cloudflare, Vercel, GSC). ' +
  'Start with list_sites. query is the primary tool. query_raw is the escape hatch for native payloads. ' +
  'Before interpreting any result, read the resource analytics://metrics — it carries what each number ' +
  'means in plain business language and how far two trackers normally differ. Use the interpret-query ' +
  'prompt when explaining results to a non-technical reader, and the site-report prompt for a full ' +
  'traffic report. Discrepancies between independent trackers are expected: run explain_discrepancy ' +
  'before calling one a problem. validate_query is advisory and flags silently truncated ranges or ' +
  'metrics a site cannot answer. ' +
  'For search questions use seo_opportunities (ranked by missed clicks) and ' +
  'explain_ctr_gap; both compare against the site own click-through curve rather ' +
  'than an industry benchmark. ai_referrals reports traffic arriving from AI ' +
  'assistants — arrivals, never citations. ' +
  'When explain_ctr_gap reports a page as underperforming, inspect_page reads what that page ' +
  'actually says about itself, so the cause can be named instead of guessed. It reports mechanical ' +
  'findings only and runs no JavaScript. ' +
  'page_changes answers whether an edit helped: it reports what this server recorded ' +
  'changing on a page and the search numbers either side. It is optional — without a ' +
  'history store it says so rather than guessing.';
