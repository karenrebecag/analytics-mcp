import { SOURCE_IDS, type AnalyticsSource } from './types.js';

let injected: AnalyticsSource[] | null = null;

export function setSourcesForTests(list: AnalyticsSource[] | null): void {
  injected = list;
}

export function allSources(): AnalyticsSource[] {
  if (injected !== null) return injected;
  // Adapters are registered in F1. F0 keeps the seam empty so tools still load.
  return [];
}

export function getSource(id: string): AnalyticsSource {
  const source = allSources().find((s) => s.id === id);
  if (!source) {
    throw new Error(`Unknown source '${id}'. Valid: ${SOURCE_IDS.join(', ')}`);
  }
  return source;
}
