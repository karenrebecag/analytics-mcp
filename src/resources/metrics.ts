/**
 * analytics://metrics — passive context so the client understands what it is
 * comparing before it compares. Rendering only; the criterion lives in
 * semantics/knowledge.ts.
 */
import { getSite, loadSites } from '../config/sites.js';
import { EXPECTED_DISCREPANCY, METRIC_SEMANTICS, SOURCE_ROW_CAPS } from '../semantics/knowledge.js';

const AUDIENCE_NOTE =
  'Every businessMeaning below is written for a reader with no analytics background. ' +
  'Prefer that wording over the metric name when you explain a number.';

export function renderMetricsDocument(): string {
  return JSON.stringify(
    {
      note: AUDIENCE_NOTE,
      metrics: METRIC_SEMANTICS,
      expectedDiscrepancies: EXPECTED_DISCREPANCY,
      rowCaps: SOURCE_ROW_CAPS,
      howToRead: [
        'Two trackers never agree exactly. A gap inside the expected range is not a bug.',
        'A source missing from a result means no data from that source — never zero traffic.',
        'Google Search numbers and on-site numbers measure different things; do not add them together.',
      ],
    },
    null,
    2,
  );
}

export function renderSiteMetricsDocument(siteId: string): string {
  const site = getSite(loadSites(), siteId);
  return JSON.stringify(
    {
      note: AUDIENCE_NOTE,
      site: { id: site.id, name: site.name, sources: Object.keys(site.sources) },
      siteExpectations: site.expectations ?? [],
      expectationsNote: site.expectations?.length
        ? 'These override the generic expectations for this site.'
        : 'This site has no measured expectations of its own; the generic ones apply.',
      metrics: METRIC_SEMANTICS,
      expectedDiscrepancies: EXPECTED_DISCREPANCY,
    },
    null,
    2,
  );
}
