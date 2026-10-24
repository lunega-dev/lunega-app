import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadFileSecrets } from './index.js';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-test-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('loadFileSecrets', () => {
  test('sets X from X_FILE', () => {
    const env: Record<string, string | undefined> = { X_FILE: write('a', 's3cret\n') };
    loadFileSecrets(env);
    expect(env.X).toBe('s3cret');
  });

  test('strips only one newline', () => {
    const env: Record<string, string | undefined> = { X_FILE: write('b', 'a\n\n') };
    loadFileSecrets(env);
    expect(env.X).toBe('a\n');
  });

  test('strips a trailing CRLF', () => {
    const env: Record<string, string | undefined> = { X_FILE: write('crlf', 'a\r\n') };
    loadFileSecrets(env);
    expect(env.X).toBe('a');
  });

  test('_FILE wins over plain', () => {
    const env: Record<string, string | undefined> = { X: 'old', X_FILE: write('c', 'new') };
    loadFileSecrets(env);
    expect(env.X).toBe('new');
  });

  test('plain env untouched without _FILE', () => {
    const env: Record<string, string | undefined> = { X: 'plain' };
    loadFileSecrets(env);
    expect(env.X).toBe('plain');
  });

  test('empty _FILE value is ignored', () => {
    const env: Record<string, string | undefined> = { X: 'plain', X_FILE: '' };
    loadFileSecrets(env);
    expect(env.X).toBe('plain');
  });

  test('missing file throws', () => {
    const missing = path.join(dir, 'nope');
    const env: Record<string, string | undefined> = { X_FILE: missing };
    expect(() => loadFileSecrets(env)).toThrow(`X_FILE: cannot read secret file ${missing}`);
  });

  test('empty file throws', () => {
    const p = write('empty', '');
    const env: Record<string, string | undefined> = { X_FILE: p };
    expect(() => loadFileSecrets(env)).toThrow(`X_FILE: cannot read secret file ${p}`);
  });

  test('error never contains file content', () => {
    // A directory fails the read with EISDIR; the file next to it holds content
    // that must not leak into the message.
    const marker = 'DISTINCTIVE-SECRET-xyzzy';
    write('leaky', marker);
    const d = path.join(dir, 'a-directory');
    fs.mkdirSync(d);
    const env: Record<string, string | undefined> = { X_FILE: d };
    let message = '';
    expect(() => {
      try {
        loadFileSecrets(env);
      } catch (e) {
        message = String(e);
        throw e;
      }
    }).toThrow();
    expect(message).toContain('X_FILE');
    expect(message).toContain(d);
    expect(message).not.toContain(marker);
  });
});
