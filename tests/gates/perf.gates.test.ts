import { describe, expect, it } from 'vitest';
import { spawnInitialized } from './helpers.js';

describe('P-F0-1 cold initialize', () => {
  it('completes initialize in under 3000 ms', async () => {
    const { client, initMs, init } = await spawnInitialized();
    try {
      expect(init).toMatchObject({ serverInfo: { name: 'analytics-mcp' } });
      expect(initMs).toBeLessThan(3000);
    } finally {
      await client.kill();
    }
  });
});
