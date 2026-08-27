import { z } from 'zod';
import type { Site } from '../sources/types.js';

const ga4BindingSchema = z.object({ propertyId: z.string().min(1) }).strict();
const cloudflareBindingSchema = z
  .object({ zoneId: z.string().min(1), host: z.string().min(1).optional() })
  .strict();
const vercelBindingSchema = z
  .object({ projectId: z.string().min(1), teamId: z.string().min(1).optional() })
  .strict();
const gscBindingSchema = z.object({ siteUrl: z.string().min(1) }).strict();

const siteSourcesSchema = z
  .object({
    ga4: ga4BindingSchema.optional(),
    cloudflare: cloudflareBindingSchema.optional(),
    vercel: vercelBindingSchema.optional(),
    gsc: gscBindingSchema.optional(),
  })
  .strict();

// Per-site "normal gap" overrides. The generic source-pair criterion lives in
// semantics/knowledge.ts; anything specific to one site is runtime config, so
// no site's numbers ever reach the open-source tree.
const expectationSchema = z
  .object({
    metric: z.string().min(1),
    sourceA: z.string().min(1),
    sourceB: z.string().min(1),
    maxRatio: z.number().min(0).max(1),
    reason: z.string().min(1).optional(),
  })
  .strict();

const siteSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    sources: siteSourcesSchema,
    expectations: z.array(expectationSchema).optional(),
  })
  .strict();

const sitesConfigSchema = z.array(siteSchema);

export function loadSites(env: Record<string, string | undefined> = process.env): Site[] {
  const raw = env.SITES_CONFIG;
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Do not echo raw: env tooling colocates this var with secrets.
    throw new Error('SITES_CONFIG is not valid JSON');
  }

  const result = sitesConfigSchema.safeParse(parsed);
  if (!result.success) {
    const paths = result.error.issues.map((issue) => issue.path.join('.') || '<root>');
    throw new Error(`SITES_CONFIG shape error at: ${paths.join(', ')}`);
  }
  return result.data;
}

export function getSite(sites: Site[], id: string): Site {
  const site = sites.find((s) => s.id === id);
  if (!site) {
    const available = sites.map((s) => s.id).join(', ') || '(none)';
    throw new Error(`Unknown site '${id}'. Available: ${available}`);
  }
  return site;
}
