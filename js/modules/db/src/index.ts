import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { dataSecure } from '@lunega/paths';

// Cloudflare D1's API over a SQLite file, so code ports both ways. One file
// per binding name under data_secure; @lunega/app opens the ones in the
// config's `bindings`, anything else calls open() itself.

export interface Meta {
  /** Milliseconds spent in SQLite. */
  duration: number;
  /** Rows inserted, updated or deleted. */
  changes: number;
  last_row_id: number;
  /** Rows returned: SQLite doesn't say how many it scanned. */
  rows_read: number;
  rows_written: number;
}

export interface Result<T = Record<string, unknown>> {
  results: T[];
  success: true;
  meta: Meta;
}

export interface ExecResult {
  count: number;
  duration: number;
}

export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  first<T = unknown>(column: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<Result<T>>;
  run<T = Record<string, unknown>>(): Promise<Result<T>>;
  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
}

export interface Database {
  prepare(sql: string): PreparedStatement;
  /** All of them in one transaction: any failure rolls the lot back. */
  batch<T = Record<string, unknown>>(statements: PreparedStatement[]): Promise<Result<T>[]>;
  /** Runs SQL as is, without parameters. */
  exec(sql: string): Promise<ExecResult>;
  /** Not in D1: closes the file. */
  close(): void;
}

export interface OpenOptions {
  /** The data_secure folder, when it isn't the one from @lunega/paths. */
  dir?: string;
  /** The database file itself; `dir` is then unused. */
  path?: string;
}

const NAME = /^[A-Z][A-Z0-9_]*$/;
// The old and the new container share the file during a switch-over, so a
// writer waits for the other one instead of failing.
const BUSY_TIMEOUT = 5000;
const STATEMENT_CACHE = 100;

const opened = new Map<string, Database>();

/** Where a binding's file is. */
export function pathOf(name: string, dir: string = dataSecure): string {
  if (!NAME.test(name)) throw new Error(`db: invalid name ${JSON.stringify(name)}, must match ${NAME}`);
  return join(dir, 'db', `${name}.sqlite`);
}

/** Opens (and creates) a binding's database; the same object for the same file. */
export function open(name: string, options: OpenOptions = {}): Database {
  const path = resolve(options.path ?? pathOf(name, options.dir));
  const existing = opened.get(path);
  if (existing) return existing;
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new DatabaseSync(path, { timeout: BUSY_TIMEOUT });
  try {
    sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  } catch (e) {
    sqlite.close();
    throw e;
  }
  const db = wrap(sqlite, () => opened.delete(path));
  opened.set(path, db);
  return db;
}

type Run = <T>(fn: (statement: StatementSync) => T) => { value: T; meta: Meta };

function wrap(sqlite: DatabaseSync, onClose: () => void): Database {
  const statements = new Map<string, StatementSync>();
  const counters = sqlite.prepare('SELECT total_changes() AS changes, last_insert_rowid() AS id');
  const read = () => counters.get() as { changes: number; id: number };

  // Prepared on first use, as on D1, where bad SQL fails when it's run.
  const statementFor = (sql: string) => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = sqlite.prepare(sql);
      if (statements.size >= STATEMENT_CACHE) statements.delete(statements.keys().next().value as string);
      statements.set(sql, statement);
    }
    return statement;
  };

  const runner =
    (sql: string): Run =>
    (fn) => {
      try {
        const before = read().changes;
        const start = performance.now();
        const value = fn(statementFor(sql));
        const duration = performance.now() - start;
        const after = read();
        const changes = after.changes - before;
        const rows = Array.isArray(value) ? value.length : value == null ? 0 : 1;
        return {
          value,
          meta: { duration, changes, last_row_id: after.id, rows_read: rows, rows_written: changes },
        };
      } catch (e) {
        throw d1Error(e);
      }
    };

  const transaction = <T>(fn: () => T): T => {
    // IMMEDIATE: take the write lock up front, where busy_timeout applies.
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      if (sqlite.isTransaction) sqlite.exec('ROLLBACK');
      throw e;
    }
  };

  return {
    prepare(sql) {
      return new Statement(runner(sql), []);
    },
    async batch<T>(list: PreparedStatement[]) {
      for (const s of list) {
        if (!(s instanceof Statement)) throw new TypeError('D1_ERROR: batch() takes statements from prepare()');
      }
      try {
        return transaction(() => (list as Statement[]).map((s) => s.allSync<T>()));
      } catch (e) {
        throw d1Error(e);
      }
    },
    async exec(sql) {
      const start = performance.now();
      try {
        sqlite.exec(sql);
      } catch (e) {
        throw d1Error(e);
      }
      // D1 runs one statement per line, and counts those.
      const count = sql.split('\n').filter((line) => line.trim() !== '').length;
      return { count, duration: performance.now() - start };
    },
    close() {
      onClose();
      if (sqlite.isOpen) sqlite.close();
    },
  };
}

class Statement implements PreparedStatement {
  readonly #run: Run;
  readonly #values: SQLInputValue[];

  constructor(run: Run, values: SQLInputValue[]) {
    this.#run = run;
    this.#values = values;
  }

  bind(...values: unknown[]): PreparedStatement {
    return new Statement(this.#run, values.map(toSqlite));
  }

  async first<T>(column?: string): Promise<T | null> {
    const { value: row } = this.#run((s) => {
      s.setReturnArrays(false);
      return s.get(...this.#values);
    });
    if (row === undefined) return null;
    if (column === undefined) return fromRow(row) as T;
    if (!(column in row)) throw new Error(`D1_ERROR: Column not found (${column})`);
    return fromSqlite(row[column]) as T;
  }

  allSync<T>(): Result<T> {
    const { value, meta } = this.#run((s) => {
      s.setReturnArrays(false);
      return s.all(...this.#values);
    });
    return { results: value.map(fromRow) as T[], success: true, meta };
  }

  async all<T>(): Promise<Result<T>> {
    return this.allSync<T>();
  }

  // The same as all(), as on D1.
  async run<T>(): Promise<Result<T>> {
    return this.allSync<T>();
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw(options?: { columnNames?: boolean }): Promise<unknown[]> {
    const { value } = this.#run((s) => {
      s.setReturnArrays(true);
      const rows = (s.all(...this.#values) as unknown as unknown[][]).map((row) => row.map(fromSqlite));
      return options?.columnNames ? [s.columns().map((c) => c.name), ...rows] : rows;
    });
    return value;
  }
}

// What D1 takes: null, numbers, strings, booleans (as 1/0) and binary.
function toSqlite(value: unknown): SQLInputValue {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'bigint':
      return value;
    case 'boolean':
      return value ? 1 : 0;
    case 'object':
      if (value === null) return null;
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(`D1_TYPE_ERROR: Type '${typeof value}' not supported for value '${String(value)}'`);
}

// D1 gives a BLOB back as an array of numbers.
function fromSqlite(value: unknown): unknown {
  return value instanceof Uint8Array ? Array.from(value) : value;
}

function fromRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key in row) out[key] = fromSqlite(row[key]);
  return out;
}

// D1's prefix, so code that matches on the message ports unchanged.
function d1Error(e: unknown): Error {
  if (e instanceof Error && e.message.startsWith('D1_')) return e;
  return new Error(`D1_ERROR: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
}
