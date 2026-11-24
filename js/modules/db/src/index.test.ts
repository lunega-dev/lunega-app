import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { dataSecure } from '@lunega/paths';
import { open, pathOf, type Database } from './index.js';

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lunega-db-'));
  db = open('DB', { dir });
  await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, age INTEGER)');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const add = (name: string, age: number | null = null) =>
  db.prepare('INSERT INTO users (name, age) VALUES (?, ?)').bind(name, age).run();

describe('open', () => {
  test('one file per name under data_secure/db', () => {
    expect(pathOf('DB')).toBe(join(dataSecure, 'db', 'DB.sqlite'));
    expect(existsSync(join(dir, 'db', 'DB.sqlite'))).toBe(true);
  });

  test('the same object for the same file, until it is closed', () => {
    expect(open('DB', { dir })).toBe(db);
    expect(open('DB', { path: join(dir, 'db', 'DB.sqlite') })).toBe(db);
    const other = open('OTHER', { dir });
    expect(other).not.toBe(db);
    other.close();
    const again = open('OTHER', { dir });
    expect(again).not.toBe(other);
    again.close();
  });

  test('WAL mode', async () => {
    expect(await db.prepare('PRAGMA journal_mode').first('journal_mode')).toBe('wal');
  });

  test('a name that could leave the folder is refused', () => {
    expect(() => open('../DB', { dir })).toThrow('invalid name');
    expect(() => open('db', { dir })).toThrow('invalid name');
  });
});

describe('statements', () => {
  test('run() reports what changed', async () => {
    const first = await add('ada', 36);
    expect(first).toMatchObject({ success: true, results: [] });
    expect(first.meta).toMatchObject({ changes: 1, last_row_id: 1, rows_written: 1, rows_read: 0 });
    expect(first.meta.duration).toBeGreaterThanOrEqual(0);
    await add('bob');
    const update = await db.prepare('UPDATE users SET age = 1').run();
    expect(update.meta).toMatchObject({ changes: 2, last_row_id: 2 });
  });

  test('all() gives the rows', async () => {
    await add('ada', 36);
    await add('bob');
    const { results, success, meta } = await db.prepare('SELECT name, age FROM users ORDER BY id').all();
    expect(success).toBe(true);
    expect(results).toEqual([
      { name: 'ada', age: 36 },
      { name: 'bob', age: null },
    ]);
    expect(meta).toMatchObject({ changes: 0, rows_read: 2, rows_written: 0 });
  });

  test('all() with RETURNING gives rows and changes', async () => {
    const { results, meta } = await db
      .prepare('INSERT INTO users (name) VALUES (?), (?) RETURNING id, name')
      .bind('ada', 'bob')
      .all();
    expect(results).toEqual([
      { id: 1, name: 'ada' },
      { id: 2, name: 'bob' },
    ]);
    expect(meta).toMatchObject({ changes: 2, last_row_id: 2 });
  });

  test('first() gives a row, a column, or null', async () => {
    await add('ada', 36);
    const select = db.prepare('SELECT name, age FROM users WHERE name = ?');
    expect(await select.bind('ada').first()).toEqual({ name: 'ada', age: 36 });
    expect(await select.bind('ada').first('age')).toBe(36);
    expect(await select.bind('nobody').first()).toBeNull();
    expect(await select.bind('nobody').first('age')).toBeNull();
    await expect(select.bind('ada').first('nope')).rejects.toThrow('D1_ERROR: Column not found');
  });

  test('raw() gives arrays, with the column names when asked', async () => {
    await add('ada', 36);
    await add('bob', 7);
    const select = db.prepare('SELECT name, age FROM users ORDER BY id');
    expect(await select.raw()).toEqual([
      ['ada', 36],
      ['bob', 7],
    ]);
    expect(await select.raw({ columnNames: true })).toEqual([
      ['name', 'age'],
      ['ada', 36],
      ['bob', 7],
    ]);
    // The same cached statement goes back to objects afterwards.
    expect(await select.first()).toEqual({ name: 'ada', age: 36 });
  });

  test('bind() leaves the statement it was called on alone', async () => {
    const insert = db.prepare('INSERT INTO users (name) VALUES (?1)');
    await insert.bind('ada').run();
    await insert.bind('bob').run();
    expect(await db.prepare('SELECT count(*) AS n FROM users').first('n')).toBe(2);
    await expect(insert.run()).rejects.toThrow('D1_ERROR');
  });

  test('numbered parameters', async () => {
    const row = await db.prepare('SELECT ?2 AS a, ?1 AS b').bind('one', 'two').first();
    expect(row).toEqual({ a: 'two', b: 'one' });
  });

  test('values convert the way D1 does', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const row = await db
      .prepare('SELECT ? AS yes, ? AS no, ? AS none, ? AS buffer, ? AS view')
      .bind(true, false, null, bytes.buffer, bytes.subarray(1))
      .first();
    expect(row).toEqual({ yes: 1, no: 0, none: null, buffer: [1, 2, 3], view: [2, 3] });
    expect(() => db.prepare('SELECT ?').bind(undefined)).toThrow("D1_TYPE_ERROR: Type 'undefined' not supported");
    expect(() => db.prepare('SELECT ?').bind({})).toThrow('D1_TYPE_ERROR');
  });

  test('bad SQL fails when it runs, as a D1_ERROR', async () => {
    const statement = db.prepare('SELECT * FROM nope');
    await expect(statement.all()).rejects.toThrow('D1_ERROR: no such table: nope');
    await add('ada');
    await expect(add('ada')).rejects.toThrow('UNIQUE constraint failed: users.name');
  });
});

describe('batch', () => {
  test('one result per statement', async () => {
    const insert = db.prepare('INSERT INTO users (name) VALUES (?)');
    const results = await db.batch([
      insert.bind('ada'),
      insert.bind('bob'),
      db.prepare('SELECT name FROM users ORDER BY id'),
    ]);
    expect(results.map((r) => r.meta.changes)).toEqual([1, 1, 0]);
    expect(results[2]?.results).toEqual([{ name: 'ada' }, { name: 'bob' }]);
    expect(await db.batch([])).toEqual([]);
  });

  test('a failure rolls all of it back', async () => {
    const insert = db.prepare('INSERT INTO users (name) VALUES (?)');
    await expect(db.batch([insert.bind('ada'), insert.bind('ada')])).rejects.toThrow('D1_ERROR: UNIQUE');
    expect(await db.prepare('SELECT count(*) AS n FROM users').first('n')).toBe(0);
    // And the next one starts clean.
    await db.batch([insert.bind('ada')]);
    expect(await db.prepare('SELECT count(*) AS n FROM users').first('n')).toBe(1);
  });
});

describe('exec', () => {
  test('runs several statements and counts them', async () => {
    const out = await db.exec(`INSERT INTO users (name) VALUES ('ada');\nINSERT INTO users (name) VALUES ('bob');\n`);
    expect(out.count).toBe(2);
    expect(out.duration).toBeGreaterThanOrEqual(0);
    expect(await db.prepare('SELECT count(*) AS n FROM users').first('n')).toBe(2);
    await expect(db.exec('NOT SQL')).rejects.toThrow('D1_ERROR');
  });
});

// The old and the new container during a switch-over.
test('two processes can write to the same file', async () => {
  const script = `import { open } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
    const db = open('DB', { dir: process.argv[1] });
    const insert = db.prepare('INSERT INTO users (name) VALUES (?)');
    for (let i = 0; i < 200; i++) await insert.bind('child-' + i).run();
    await db.batch([insert.bind('child-batch-1'), insert.bind('child-batch-2')]);
    db.close();`;
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
    await add(`parent-${written++}`);
    await new Promise((r) => setImmediate(r));
  }
  await child;
  const count = (like: string) => db.prepare('SELECT count(*) AS n FROM users WHERE name LIKE ?').bind(like).first('n');
  expect(await count('child-%')).toBe(202);
  expect(await count('parent-%')).toBe(written);
  expect(written).toBeGreaterThan(0);
});
