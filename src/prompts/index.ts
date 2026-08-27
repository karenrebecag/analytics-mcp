/**
 * Prompt registration. Transport-agnostic, like resources.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { INTERPRET_QUERY_PROMPT } from './interpret-query.js';
import { siteReportText } from './site-report.js';

export { INTERPRET_QUERY_TEXT, INTERPRET_QUERY_PROMPT } from './interpret-query.js';
export { siteReportText } from './site-report.js';

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    INTERPRET_QUERY_PROMPT.name,
    {
      title: INTERPRET_QUERY_PROMPT.title,
      description: INTERPRET_QUERY_PROMPT.description,
    },
    () => ({
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: INTERPRET_QUERY_PROMPT.text },
        },
      ],
    }),
  );

  server.registerPrompt(
    'site-report',
    {
      title: 'Plain-language traffic report',
      description:
        'End-to-end recipe: query every tracker for a site, reconcile the differences, and write a report for a non-technical reader.',
      argsSchema: {
        site: z.string().describe('Site id from list_sites.'),
        period: z
          .string()
          .describe(
            'Period in plain words or ISO dates, e.g. "last month" or "2026-08-01..2026-08-31".',
          ),
      },
    },
    ({ site, period }) => ({
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: siteReportText(site, period) },
        },
      ],
    }),
  );
}
