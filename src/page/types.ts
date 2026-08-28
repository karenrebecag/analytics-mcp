/**
 * What a page says about itself.
 *
 * Every field the page did not state stays undefined. "The tag is absent" and
 * "we never read that far" are different findings, and `headTruncated` is what
 * keeps them apart — without it a truncated read would look like a missing tag
 * and the verdicts would accuse a page that is fine.
 */
export interface PageFacts {
  url: string;
  fetchedAt: string;
  status: number;
  /** Set when the response was a 3xx. Reported, never followed. */
  redirectTo?: string;
  title?: string;
  titleLength?: number;
  metaDescription?: string;
  metaDescriptionLength?: number;
  canonical?: string;
  h1s: string[];
  robotsMeta?: string;
  ogTitle?: string;
  ogDescription?: string;
  headTruncated: boolean;
  /** sha256 over the normalized facts — see extract.ts for what is included. */
  contentHash: string;
}

/**
 * One deterministic rule that fired, carrying the fact that triggered it.
 * There is no score and no ranking of pages against each other: whether the
 * wording matches what a searcher wanted is judgement, and judgement is the
 * client's job.
 */
export interface PageVerdict {
  rule: string;
  finding: string;
  fact?: string | number;
}
