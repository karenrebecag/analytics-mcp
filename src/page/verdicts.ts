/**
 * Deterministic rules over the facts. Each verdict carries the value that
 * triggered it, so a reader can check the call rather than trust it.
 *
 * The thresholds below are CONVENTIONS about where search results get cut off
 * on a typical screen — they are not measurements of this site, the way the
 * click-through curve is. A page slightly over the limit is not broken; it is
 * a page whose ending may not be read.
 *
 * What never appears here: whether the wording matches what a searcher wanted.
 * That is judgement, it belongs to the client, and a server that guessed at it
 * would be inventing the one number this project refuses to invent.
 */
import type { PageFacts, PageVerdict } from './types.js';

const TITLE_MIN = 15;
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 160;

function sameTarget(a: string, b: string): boolean {
  const strip = (value: string): string => value.replace(/\/$/, '').toLowerCase();
  try {
    return strip(new URL(a).toString()) === strip(new URL(b).toString());
  } catch {
    return strip(a) === strip(b);
  }
}

export function pageVerdicts(facts: PageFacts): PageVerdict[] {
  const verdicts: PageVerdict[] = [];

  if (facts.redirectTo) {
    verdicts.push({
      rule: 'redirect',
      finding:
        'This URL redirects somewhere else, so the page people reach is not the one measured here.',
      fact: facts.redirectTo,
    });
    // Nothing else can be said: a redirect has no head to read.
    return verdicts;
  }

  if (facts.status !== 200) {
    verdicts.push({
      rule: 'status',
      finding:
        facts.status === 404
          ? 'This page returns "not found". Anyone arriving from search lands on an error.'
          : `The server answered with ${facts.status} rather than a normal page.`,
      fact: facts.status,
    });
    return verdicts;
  }

  if (facts.robotsMeta && /noindex/i.test(facts.robotsMeta)) {
    verdicts.push({
      rule: 'noindex',
      finding: 'This page tells search engines not to index it.',
      fact: facts.robotsMeta,
    });
  }

  if (!facts.title) {
    verdicts.push({
      rule: 'title-missing',
      finding: facts.headTruncated
        ? 'No title was found, but the page was too large to read in full — this may be a reading limit rather than a missing title.'
        : 'This page has no title, so search engines invent one from the content.',
    });
  } else if (facts.titleLength !== undefined && facts.titleLength > TITLE_MAX) {
    verdicts.push({
      rule: 'title-long',
      finding: `The title is ${facts.titleLength} characters; past about ${TITLE_MAX} it is usually cut off mid-phrase in results.`,
      fact: facts.title,
    });
  } else if (facts.titleLength !== undefined && facts.titleLength < TITLE_MIN) {
    verdicts.push({
      rule: 'title-short',
      finding: `The title is only ${facts.titleLength} characters, which leaves most of the available space unused.`,
      fact: facts.title,
    });
  }

  if (!facts.metaDescription) {
    verdicts.push({
      rule: 'description-missing',
      finding: facts.headTruncated
        ? 'No description was found, but the page was too large to read in full.'
        : 'This page has no description, so search engines quote an arbitrary sentence from it instead.',
    });
  } else if (
    facts.metaDescriptionLength !== undefined &&
    facts.metaDescriptionLength > DESCRIPTION_MAX
  ) {
    verdicts.push({
      rule: 'description-long',
      finding: `The description is ${facts.metaDescriptionLength} characters; past about ${DESCRIPTION_MAX} the ending is usually cut off.`,
      fact: facts.metaDescription,
    });
  }

  // Never accuse on a partial read: an h1 past the byte cap was not absent, it
  // was never looked at. Same discipline as headTruncated above.
  if (facts.h1s.length === 0 && !facts.headTruncated && !facts.bodyTruncated) {
    verdicts.push({
      rule: 'h1-missing',
      finding: 'This page has no main heading.',
    });
  } else if (facts.h1s.length > 1) {
    verdicts.push({
      rule: 'h1-multiple',
      finding: `This page has ${facts.h1s.length} main headings, so what it is about is ambiguous.`,
      fact: facts.h1s.join(' | '),
    });
  }

  if (facts.canonical && !sameTarget(facts.canonical, facts.url)) {
    verdicts.push({
      rule: 'canonical-elsewhere',
      finding:
        'This page names a different URL as the canonical one, so search engines credit that address instead of this one.',
      fact: facts.canonical,
    });
  }

  return verdicts;
}
