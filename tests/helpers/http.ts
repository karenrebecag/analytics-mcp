import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'http';

export interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Minimal ServerResponse double: records status, headers and body. */
export function mockResponse(): ServerResponse & { captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: '' };
  const res = {
    captured,
    headersSent: false,
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = String(value);
    },
    getHeader(name: string) {
      return captured.headers[name.toLowerCase()];
    },
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      for (const [k, v] of Object.entries(headers ?? {})) {
        captured.headers[k.toLowerCase()] = String(v);
      }
      (res as { headersSent: boolean }).headersSent = true;
      return res;
    },
    end(chunk?: string) {
      if (chunk) captured.body += chunk;
      return res;
    },
    write(chunk: string) {
      captured.body += chunk;
      return true;
    },
    on() {
      return res;
    },
  };
  return res as unknown as ServerResponse & { captured: CapturedResponse };
}

export function mockRequest(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): IncomingMessage & { body?: unknown } {
  const req = new EventEmitter() as IncomingMessage & { body?: unknown };
  req.method = opts.method ?? 'GET';
  req.url = opts.url ?? '/';
  req.headers = { host: 'analytics.example', ...(opts.headers ?? {}) };
  if (opts.body !== undefined) req.body = opts.body;
  return req;
}

export function json(res: { captured: CapturedResponse }): Record<string, unknown> {
  return JSON.parse(res.captured.body || '{}') as Record<string, unknown>;
}
