import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { writeCapture } from '../scripts/probe.js';

const SCRATCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scratch');
const STEM = 'test-write-capture';
const DEST = path.join(SCRATCH, `${STEM}.json`);

afterEach(() => {
  if (existsSync(DEST)) rmSync(DEST);
});

describe('writeCapture', () => {
  it('writes JSON under scratch/', () => {
    const dest = writeCapture(STEM, { ok: true });
    expect(dest).toBe(DEST);
    expect(JSON.parse(readFileSync(dest, 'utf8'))).toEqual({ ok: true });
  });

  it('rejects traversal and absolute names', () => {
    expect(() => writeCapture('../x', {})).toThrow(/bare file stem/);
    expect(() => writeCapture('foo/bar', {})).toThrow(/bare file stem/);
    expect(() => writeCapture('/tmp/x', {})).toThrow(/bare file stem/);
  });
});
