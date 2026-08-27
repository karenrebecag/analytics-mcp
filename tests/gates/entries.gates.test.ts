/**
 * F4 gates — every entry point actually boots and speaks MCP.
 *
 * Runs against dist/: these entries are the compiled artifact a deployment
 * executes, and a dormant seam that no longer compiles is worse than no seam,
 * because nobody notices until the day it is needed.
 */
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { assertBindable, createMcpHttpServer } from '../../dist/serve.js';
import { spawnBuiltServer, spawnInitialized } from './helpers.js';

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'gate', version: '1' },
  },
};

async function withServer<T>(
  options: Parameters<typeof createMcpHttpServer>[0],
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createMcpHttpServer(options);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function post(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(INIT),
  });
}

describe('S-F4-1 stdio keeps the MCP channel clean', () => {
  it('emits only JSON-RPC on stdout, with logs on stderr', async () => {
    const { client } = await spawnInitialized({ SITES_CONFIG: '[]' });
    let stdout: string;
    let stderr: string;
    try {
      await client.request('tools/list');
      stdout = client.stdout;
      stderr = client.stderr;
    } finally {
      await client.kill();
    }

    const lines = stdout.split('\n').filter((line) => line.trim());
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { jsonrpc?: string };
      expect(parsed.jsonrpc).toBe('2.0');
    }
    // The readiness log must exist, and must not have gone to stdout.
    expect(stderr).toMatch(/ready on stdio/);
    expect(stdout).not.toMatch(/ready on stdio/);
  });
});

describe('F4 long-lived entry boots and serves', () => {
  it('answers initialize on a random port', async () => {
    const body = await withServer({}, async (url) => {
      const res = await post(url);
      expect(res.status).toBeLessThan(400);
      return res.text();
    });
    expect(body).toContain('analytics-mcp');
  });

  it('requires the bearer token when one is configured', async () => {
    await withServer({ bearerToken: 'serve-secret-token' }, async (url) => {
      const anonymous = await post(url);
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get('www-authenticate')).toMatch(/^Bearer/);

      const wrong = await post(url, { authorization: 'Bearer serve-secret-WRONG' });
      expect(wrong.status).toBe(401);

      const ok = await post(url, { authorization: 'Bearer serve-secret-token' });
      expect(ok.status).toBeLessThan(400);
    });
  });

  it('refuses to bind a public interface without a token', () => {
    expect(() => assertBindable('0.0.0.0')).toThrow(/SERVE_BEARER_TOKEN/);
    expect(() => assertBindable('0.0.0.0', 'a-token')).not.toThrow();
    expect(() => assertBindable('127.0.0.1')).not.toThrow();
  });
});

describe('F4 stdio entry starts with no configuration', () => {
  it('registers cleanly when no env is set', async () => {
    const client = await spawnBuiltServer({});
    try {
      const init = (await client.request('initialize', INIT.params)) as {
        serverInfo?: { name?: string };
      };
      expect(init.serverInfo?.name).toBe('analytics-mcp');
    } finally {
      await client.kill();
    }
  });
});
