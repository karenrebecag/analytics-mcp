/**
 * inspect_page — what one page says about itself.
 *
 * The measurement tools answer what happened. This one reads the page they are
 * talking about, so a verdict can name a cause instead of prescribing blind.
 * It reports facts and rule violations only; what the wording should say is the
 * client's call.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getSite, loadSites } from '../config/sites.js';
import { jsonResult, runTool } from '../core/tool-result.js';
import { allowedHostsForSite } from '../page/allowlist.js';
import { fetchPageSnapshot } from '../page/fetch.js';
import { pageVerdicts } from '../page/verdicts.js';

export const inspectPageSchema = z.object({
  site: z.string().min(1),
  url: z.string().min(1).describe('Full https URL of a page belonging to this site.'),
});

export async function handleInspectPage(
  args: z.infer<typeof inspectPageSchema>,
): Promise<CallToolResult> {
  return runTool(async () => {
    const site = getSite(loadSites(), args.site);
    const facts = await fetchPageSnapshot(args.url, allowedHostsForSite(site));
    const verdicts = pageVerdicts(facts);

    return jsonResult({
      facts,
      verdicts,
      note:
        verdicts.length === 0
          ? 'Nothing mechanical is wrong with this page. Whether the wording earns the click is a judgement these rules do not make.'
          : 'These are mechanical findings. Whether the wording matches what a searcher wanted is a separate judgement.',
      limitation:
        'The HTML is read as served; no JavaScript is run. A page that builds its title in the browser will report none here — which is also what a crawler sees.',
    });
  });
}
