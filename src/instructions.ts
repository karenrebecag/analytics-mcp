export const INSTRUCTIONS =
  'Unified web analytics (GA4, Cloudflare, Vercel, GSC). ' +
  'Start with list_sites. query is the primary tool. query_raw is the escape hatch for native payloads. ' +
  'Before interpreting any result, read the resource analytics://metrics — it carries what each number ' +
  'means in plain business language and how far two trackers normally differ. Use the interpret-query ' +
  'prompt when explaining results to a non-technical reader, and the site-report prompt for a full ' +
  'traffic report. Discrepancies between independent trackers are expected: run explain_discrepancy ' +
  'before calling one a problem. validate_query is advisory and flags silently truncated ranges or ' +
  'metrics a site cannot answer.';
