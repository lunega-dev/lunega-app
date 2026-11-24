import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { dataSecure } from '@lunega/paths';
import { open, pathOf, type Namespace } from './index.js';

let dir: string;
let kv: Namespace;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lunega-kv-'));
  kv = open('CACHE', { dir });
});

afterEach(() => {
  vi.useRealTimers();
  kv.close();
  rmSync(dir, { recursive: true, force: true });
});

const START = new Date('2026-01-01T00:00:00Z');
const startSeconds = START.getTime() / 1000;
// Only Date: SQLite and streams keep their real timers.
const clock = () => vi.useFakeTimers({ toFake: ['Date'], now: START });
const later = (seconds: number) => vi.setSystemTime(START.getTime() + seconds * 1000);

// What is in the file, expired or not.
function stored(): string[] {
  const sqlite = new DatabaseSync(join(dir, 'kv', 'CACHE.sqlite'));
  try {
    return sqlite
      .prepare('SELECT key FROM kv ORDER BY key')
      .all()
      .map((row) => row.key as string);
  } finally {
    sqlite.close();
  }
}

describe('open', () => {
  test('one file per name under data_secure/kv', () => {
    expect(pathOf('CACHE')).toBe(join(dataSecure, 'kv', 'CACHE.sqlite'));
    expect(existsSync(join(dir, 'kv', 'CACHE.sqlite'))).toBe(true);
  });

  test('the same object for the same file, until it is closed', () => {
    expect(open('CACHE', { dir })).toBe(kv);
    expect(open('CACHE', { path: join(dir, 'kv', 'CACHE.sqlite') })).toBe(kv);
    const other = open('OTHER', { dir });
    expect(other).not.toBe(kv);
    other.close();
  });

  test('a name that could leave the folder is refused', () => {
    expect(() => open('../CACHE', { dir })).toThrow('invalid name');
  });

  test('values survive a reopen', async () => {
    await kv.put('a', '1');
    kv.close();
    kv = open('CACHE', { dir });
    expect(await kv.get('a')).toBe('1');
  });
});

describe('get and put', () => {
  test('text by default, null for a missing key', async () => {
    await kv.put('greeting', 'héllo');
    expect(await kv.get('greeting')).toBe('héllo');
    expect(await kv.get('greeting', 'text')).toBe('héllo');
    expect(await kv.get('greeting', { type: 'text', cacheTtl: 60 })).toBe('héllo');
    expect(await kv.get('nope')).toBeNull();
    expect(await kv.get('nope', 'json')).toBeNull();
  });

  test('json', async () => {
    await kv.put('user', JSON.stringify({ name: 'ada', tags: ['a'] }));
    expect(await kv.get('user', 'json')).toEqual({ name: 'ada', tags: ['a'] });
    expect(await kv.get<{ name: string }>('user', { type: 'json' })).toMatchObject({ name: 'ada' });
  });

  test('arrayBuffer, from a buffer or a view', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    await kv.put('buffer', bytes.buffer);
    await kv.put('view', bytes.subarray(1, 3));
    const buffer = await kv.get('buffer', 'arrayBuffer');
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(buffer!)).toEqual(bytes);
    expect(new Uint8Array((await kv.get('view', { type: 'arrayBuffer' }))!)).toEqual(new Uint8Array([1, 2]));
  });

  test('stream, both ways', async () => {
    await kv.put('stream', new Blob(['from ', 'a stream']).stream());
    expect(await kv.get('stream')).toBe('from a stream');
    const stream = await kv.get('stream', 'stream');
    expect(stream).toBeInstanceOf(ReadableStream);
    expect(await new Response(stream).text()).toBe('from a stream');
  });

  test('put replaces the value, its expiration and its metadata', async () => {
    clock();
    await kv.put('a', '1', { expirationTtl: 60, metadata: { v: 1 } });
    await kv.put('a', '2');
    later(3600);
    expect(await kv.getWithMetadata('a')).toEqual({ value: '2', metadata: null, cacheStatus: null });
  });

  test('an unknown type is refused', async () => {
    await expect(kv.get('a', 'blob' as 'text')).rejects.toThrow('unknown type "blob"');
  });

  test('a value that is not text or bytes is refused', async () => {
    await expect(kv.put('a', { not: 'a value' } as never)).rejects.toThrow('a value must be');
  });
});

describe('getWithMetadata', () => {
  test('the value with its metadata', async () => {
    await kv.put('a', '{"n":1}', { metadata: { by: 'ada', tags: [1, 2] } });
    await kv.put('plain', 'x');
    expect(await kv.getWithMetadata('a')).toEqual({
      value: '{"n":1}',
      metadata: { by: 'ada', tags: [1, 2] },
      cacheStatus: null,
    });
    expect((await kv.getWithMetadata('a', 'json')).value).toEqual({ n: 1 });
    expect(await kv.getWithMetadata('plain')).toEqual({ value: 'x', metadata: null, cacheStatus: null });
    expect(await kv.getWithMetadata('nope')).toEqual({ value: null, metadata: null, cacheStatus: null });
  });

  test('metadata over 1024 bytes is refused', async () => {
    await expect(kv.put('a', 'x', { metadata: 'm'.repeat(1023) })).rejects.toThrow('metadata of 1025 bytes');
    await kv.put('a', 'x', { metadata: 'm'.repeat(1022) });
  });
});

describe('keys', () => {
  test('up to 512 bytes', async () => {
    await kv.put('k'.repeat(512), 'x');
    expect(await kv.get('k'.repeat(512))).toBe('x');
    await expect(kv.put('k'.repeat(513), 'x')).rejects.toThrow('over the limit of 512');
    // Bytes, not characters.
    await expect(kv.put('é'.repeat(257), 'x')).rejects.toThrow('514 bytes');
    await expect(kv.get('k'.repeat(513))).rejects.toThrow('over the limit of 512');
  });

  test('not empty, "." or ".."', async () => {
    await expect(kv.put('', 'x')).rejects.toThrow('non-empty');
    await expect(kv.put('.', 'x')).rejects.toThrow('not a valid key');
    await expect(kv.delete('..')).rejects.toThrow('not a valid key');
  });
});

describe('delete', () => {
  test('removes the key; a missing one is fine', async () => {
    await kv.put('a', '1');
    await kv.delete('a');
    await kv.delete('never-there');
    expect(await kv.get('a')).toBeNull();
    expect(stored()).toEqual([]);
  });
});

describe('expiration', () => {
  test('expirationTtl: gone once the time has passed', async () => {
    clock();
    await kv.put('a', '1', { expirationTtl: 60 });
    later(59);
    expect(await kv.get('a')).toBe('1');
    later(60);
    expect(await kv.get('a')).toBeNull();
    expect(await kv.getWithMetadata('a')).toEqual({ value: null, metadata: null, cacheStatus: null });
  });

  test('expiration: seconds since the epoch, and it shows in list', async () => {
    clock();
    await kv.put('a', '1', { expiration: startSeconds + 100 });
    await kv.put('b', '2');
    expect((await kv.list()).keys).toEqual([{ name: 'a', expiration: startSeconds + 100 }, { name: 'b' }]);
    later(100);
    expect((await kv.list()).keys).toEqual([{ name: 'b' }]);
    expect(await kv.get('a')).toBeNull();
  });

  test('under 60 seconds away is refused, as on KV', async () => {
    clock();
    await expect(kv.put('a', '1', { expirationTtl: 59 })).rejects.toThrow('at least 60 seconds');
    await expect(kv.put('a', '1', { expirationTtl: 60.5 })).rejects.toThrow('at least 60 seconds');
    await expect(kv.put('a', '1', { expiration: startSeconds + 59 })).rejects.toThrow('at least 60 seconds from now');
    expect(await kv.get('a')).toBeNull();
  });

  test('a read deletes the expired key it found', async () => {
    clock();
    await kv.put('a', '1', { expirationTtl: 60 });
    await kv.put('b', '2', { expirationTtl: 60 });
    later(61);
    expect(stored()).toEqual(['a', 'b']);
    await kv.get('a');
    expect(stored()).toEqual(['b']);
  });

  test('a put sweeps the expired keys nobody read, once a minute', async () => {
    clock();
    await kv.put('a', '1', { expirationTtl: 60 });
    await kv.put('b', '2', { expirationTtl: 120 });
    later(90);
    await kv.put('c', '3');
    expect(stored()).toEqual(['b', 'c']);
    later(130);
    await kv.put('d', '4');
    // Not a minute since the last sweep yet.
    expect(stored()).toEqual(['b', 'c', 'd']);
    later(150);
    await kv.put('e', '5');
    expect(stored()).toEqual(['c', 'd', 'e']);
  });
});

describe('list', () => {
  const names = async (options?: Parameters<Namespace['list']>[0]) =>
    (await kv.list(options)).keys.map((k) => k.name);

  test('every key in order, with its metadata', async () => {
    await kv.put('b', '2', { metadata: { n: 2 } });
    await kv.put('a', '1');
    expect(await kv.list()).toEqual({
      keys: [{ name: 'a' }, { name: 'b', metadata: { n: 2 } }],
      list_complete: true,
      cacheStatus: null,
    });
    expect(await kv.list<{ n: number }>({ prefix: null, cursor: null })).toMatchObject({ list_complete: true });
  });

  test('prefix, taken literally', async () => {
    for (const key of ['user:1', 'user:2', 'user', 'users', 'USER:3', 'a%b', 'a_b', 'axb', 'é1', 'é2', 'f']) {
      await kv.put(key, 'x');
    }
    expect(await names({ prefix: 'user:' })).toEqual(['user:1', 'user:2']);
    expect(await names({ prefix: 'user' })).toEqual(['user', 'user:1', 'user:2', 'users']);
    expect(await names({ prefix: 'a%' })).toEqual(['a%b']);
    expect(await names({ prefix: 'a_' })).toEqual(['a_b']);
    expect(await names({ prefix: 'é' })).toEqual(['é1', 'é2']);
    expect(await names({ prefix: 'nope' })).toEqual([]);
  });

  test('limit and cursor page through all of it', async () => {
    for (let i = 0; i < 25; i++) await kv.put(`key:${String(i).padStart(2, '0')}`, 'x');
    await kv.put('other', 'x');
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await kv.list({ prefix: 'key:', limit: 10, cursor });
      seen.push(...page.keys.map((k) => k.name));
      cursor = page.list_complete ? undefined : page.cursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(25);
    expect(seen).toEqual([...seen].sort());
    expect(seen[24]).toBe('key:24');
  });

  test('a page that ends on the last key is complete', async () => {
    await kv.put('a', '1');
    await kv.put('b', '2');
    const page = await kv.list({ limit: 2 });
    expect(page.list_complete).toBe(true);
    expect('cursor' in page).toBe(false);
    expect(await kv.list({ limit: 1 })).toMatchObject({ keys: [{ name: 'a' }], list_complete: false });
  });

  test('limit is 1 to 1000, and 1000 by default', async () => {
    await expect(kv.list({ limit: 0 })).rejects.toThrow('limit must be between 1 and 1000');
    await expect(kv.list({ limit: 1001 })).rejects.toThrow('limit must be between 1 and 1000');
    await expect(kv.list({ limit: 1.5 })).rejects.toThrow('limit must be');
    const sqlite = new DatabaseSync(join(dir, 'kv', 'CACHE.sqlite'));
    const insert = sqlite.prepare(`INSERT INTO kv (key, value) VALUES (?, 'x')`);
    sqlite.exec('BEGIN');
    for (let i = 0; i < 1001; i++) insert.run(`k${String(i).padStart(4, '0')}`);
    sqlite.exec('COMMIT');
    sqlite.close();
    const page = await kv.list();
    expect(page.keys).toHaveLength(1000);
    expect(page.list_complete).toBe(false);
  });

  test('a made-up cursor is refused', async () => {
    await expect(kv.list({ cursor: '!!' })).rejects.toThrow('invalid cursor');
  });
});

// The old and the new container during a switch-over.
test('two processes can write to the same file', async () => {
  const script = `import { open } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
    const kv = open('CACHE', { dir: process.argv[1] });
    for (let i = 0; i < 200; i++) await kv.put('child:' + i, 'x');
    kv.close();`;
  let running = true;
  const child = promisify(execFile)(process.execPath, [
    '--conditions=development',
    '--input-type=module',
    '-e',
    script,
    dir,
  ]).finally(() => (running = false));
  // Keeps writing for as long as the child does, so the two overlap.
  let written = 0;
  while (running) {
    await kv.put(`parent:${String(written++).padStart(8, '0')}`, 'x');
    await new Promise((r) => setImmediate(r));
  }
  await child;
  expect((await kv.list({ prefix: 'child:' })).keys).toHaveLength(200);
  const last = `parent:${String(written - 1).padStart(8, '0')}`;
  expect(await kv.get(last)).toBe('x');
});
