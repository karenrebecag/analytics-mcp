/**
 * pnpm capture — the stdio equivalent of the cron.
 *
 * No scheduler exists locally, so a capture runs on demand or from whatever the
 * operator already uses. Prints a summary rather than logging silently: run by
 * hand, it should say what it did.
 */
import { captureAllSites } from '../src/page/capture.js';

const summaries = await captureAllSites();
for (const summary of summaries) {
  if (summary.skipped) {
    process.stdout.write(`${summary.site}: skipped — ${summary.skipped}\n`);
    continue;
  }
  process.stdout.write(
    `${summary.site}: ${summary.changed} changed, ${summary.unchanged} unchanged, ` +
      `${summary.failures.length} failed (of ${summary.pagesConsidered} pages)\n`,
  );
  for (const failure of summary.failures) {
    process.stdout.write(`  ! ${failure.page} — ${failure.reason}\n`);
  }
}
