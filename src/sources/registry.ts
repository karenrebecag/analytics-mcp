import { SOURCE_IDS, type AnalyticsSource } from './types.js';
import { createGa4Source } from './ga4.js';
import { createCloudflareSource } from './cloudflare.js';
import { createVercelSource } from './vercel.js';
import { createGscSource } from './gsc.js';

let injected: AnalyticsSource[] | null = null;

export function setSourcesForTests(list: AnalyticsSource[] | null): void {
  injected = list;
}

export function allSources(): AnalyticsSource[] {
  if (injected !== null) return injected;
  return [createGa4Source(), createCloudflareSource(), createVercelSource(), createGscSource()];
}

export function getSource(id: string): AnalyticsSource {
  const source = allSources().find((s) => s.id === id);
  if (!source) {
    throw new Error(`Unknown source '${id}'. Valid: ${SOURCE_IDS.join(', ')}`);
  }
  return source;
}
