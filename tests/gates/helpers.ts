import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST_ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../dist/index.js',
);

const INIT_PARAMS = {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'analytics-mcp-gates', version: '0.0.0' },
};

export interface RpcClient {
  stdout: string;
  stderr: string;
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  kill(): Promise<void>;
}

export async function spawnBuiltServer(env: NodeJS.ProcessEnv = {}): Promise<RpcClient> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [DIST_ENTRY], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    stdout += `${line}\n`;
    if (!line.trim()) return;
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) {
      waiter.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      return;
    }
    waiter.resolve(msg.result);
  });

  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const killed = new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`server did not become ready: ${stderr}`));
    }, 8000);
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}: ${stderr}`));
    };
    child.once('exit', onExit);
    const check = () => {
      if (stderr.includes('ready')) {
        clearTimeout(timer);
        child.off('exit', onExit);
        resolve();
      }
    };
    child.stderr.on('data', check);
    check();
  });

  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    request(method: string, params?: unknown): Promise<unknown> {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }, 10_000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method: string, params?: unknown): void {
      const msg: Record<string, unknown> = { jsonrpc: '2.0', method };
      if (params !== undefined) msg.params = params;
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    },
    async kill(): Promise<void> {
      rl.close();
      if (!child.killed) child.kill('SIGTERM');
      const giveUp = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 2000);
      await killed;
      clearTimeout(giveUp);
    },
  };
}

export async function spawnInitialized(env: NodeJS.ProcessEnv = {}): Promise<{
  client: RpcClient;
  initMs: number;
  init: unknown;
}> {
  const started = Date.now();
  const client = await spawnBuiltServer(env);
  const init = await client.request('initialize', INIT_PARAMS);
  client.notify('notifications/initialized');
  return { client, init, initMs: Date.now() - started };
}
