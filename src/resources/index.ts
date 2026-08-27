/**
 * Resource registration. Transport-agnostic: it receives the server and
 * attaches read handlers, knowing nothing about how the server is served.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadSites } from '../config/sites.js';
import { renderMetricsDocument, renderSiteMetricsDocument } from './metrics.js';

export { renderMetricsDocument, renderSiteMetricsDocument } from './metrics.js';

export function registerResources(server: McpServer): void {
  server.registerResource(
    'metrics',
    'analytics://metrics',
    {
      title: 'Metric meanings and expected gaps',
      description:
        'What each metric means in plain business language, how each source counts it, and how far two sources normally differ.',
      mimeType: 'application/json',
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: renderMetricsDocument() }],
    }),
  );

  server.registerResource(
    'site-metrics',
    new ResourceTemplate('analytics://metrics/{siteId}', {
      list: () => ({
        resources: loadSites().map((site) => ({
          uri: `analytics://metrics/${site.id}`,
          name: `Metric meanings for ${site.name}`,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      title: 'Per-site metric meanings',
      description: 'The same guidance, plus any expectations measured for one site.',
      mimeType: 'application/json',
    },
    (uri, variables) => {
      const raw = variables.siteId;
      const siteId = Array.isArray(raw) ? raw[0] : raw;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: renderSiteMetricsDocument(String(siteId)),
          },
        ],
      };
    },
  );
}
