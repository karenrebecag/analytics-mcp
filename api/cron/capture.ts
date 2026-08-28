/**
 * GET /api/cron/capture — the scheduled page capture.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` when a project defines that
 * variable. An UNSET secret must read as closed, never as open: a deployment
 * that forgot to set it would otherwise expose a job that makes outbound
 * requests to anyone who guesses the path.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'node:crypto';
import { acquireCaptureLock, captureAllSites } from '../../src/page/capture.js';

export const config = { runtime: 'nodejs', maxDuration: 300 };

function authorized(header: string | undefined): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(header ?? '');
  // timingSafeEqual throws on a length mismatch, which is itself an answer.
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req.headers.authorization)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  if (!(await acquireCaptureLock(randomUUID()))) {
    // A previous invocation is still going. Overlapping runs are safe — the
    // capture is idempotent — but doing the work twice is waste, not safety.
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ skipped: 'A capture is already running.' }));
    return;
  }

  try {
    const summaries = await captureAllSites();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, summaries }));
  } catch (err) {
    // Vercel never retries a failed cron, so the log is the only record.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`capture cron failed: ${message}\n`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'capture failed' }));
  }
}
