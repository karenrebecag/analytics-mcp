/**
 * Which referrers are AI assistants.
 *
 * Codified criterion, pure data. Matching is on substrings because analytics
 * reports the same engine under several spellings (`chatgpt.com`,
 * `chat.openai.com`, `openai`).
 */
export interface AssistantMatcher {
  engine: string;
  patterns: string[];
}

export const AI_ASSISTANT_SOURCES: AssistantMatcher[] = [
  { engine: 'ChatGPT', patterns: ['chatgpt', 'chat.openai', 'openai.com'] },
  { engine: 'Perplexity', patterns: ['perplexity'] },
  { engine: 'Claude', patterns: ['claude.ai', 'anthropic'] },
  { engine: 'Gemini', patterns: ['gemini.google', 'bard.google'] },
  { engine: 'Copilot', patterns: ['copilot.microsoft', 'bing.com/chat'] },
  { engine: 'You.com', patterns: ['you.com'] },
  { engine: 'Poe', patterns: ['poe.com'] },
  { engine: 'Mistral', patterns: ['chat.mistral', 'lechat'] },
  { engine: 'Grok', patterns: ['grok.com', 'x.ai'] },
];

export function matchAssistant(source: string): string | undefined {
  const needle = source.toLowerCase();
  for (const { engine, patterns } of AI_ASSISTANT_SOURCES) {
    if (patterns.some((p) => needle.includes(p))) return engine;
  }
  return undefined;
}

/**
 * The sentence that must accompany every assistant-referral report.
 *
 * Arrivals are not citations. No API reports whether an assistant mentioned
 * you, and Search Console folds AI Overview appearances into ordinary
 * impressions — so a low number here means little traffic arrived, not that
 * you are absent from AI answers.
 */
export const AI_REFERRAL_CAVEAT =
  'This counts visits that arrived from an AI assistant. It does not measure ' +
  'whether assistants cite or recommend you: no API reports that, and many ' +
  'people read an answer without clicking through. Treat it as a floor, not a ' +
  'visibility score.';
