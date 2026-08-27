import type { IncomingMessage, ServerResponse } from 'http';

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export function setCors(
  res: ServerResponse,
  methods: string = 'GET, OPTIONS',
  headers: string = 'Content-Type',
): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', headers);
}

export function handlePreflight(
  req: IncomingMessage,
  res: ServerResponse,
  methods?: string,
  headers?: string,
): boolean {
  setCors(res, methods, headers);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}
