import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataSecure } from '@lunega/paths';

// Cloudflare Workers KV's API over a SQLite file, so code ports both ways.
// One file per binding name under data_secure; @lunega/app opens the ones in
// the config's `bindings`, anything else calls open() itself. Unlike KV, a
// write is visible to the next read at once.

export type GetType = 'text' | 'json' | 'arrayBuffer' | 'stream';
/** `cacheTtl` is accepted for KV's sake; there is no cache to tune. */
export type GetOptions<Type extends GetType = GetType> = Type | { type?: Type; cacheTtl?: number };
export type Value = string | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>;

export interface PutOptions {
  /** When the key expires, in seconds since the epoch. */
  expiration?: number;
  /** When the key expires, in seconds from now. */
  expirationTtl?: number;
  /** Any JSON, up to 1024 bytes of it; comes back from getWithMetadata and list. */
  metadata?: unknown;
}

export interface ListOptions {
  prefix?: string | null;
  limit?: number;
  cursor?: string | null;
}

export interface Key<Metadata = unknown> {
  name: string;
  expiration?: number;
  metadata?: Metadata;
}

export type ListResult<Metadata = unknown> = { keys: Key<Metadata>[]; cacheStatus: null } & (
  | { list_complete: false; cursor: string }
  | { list_complete: true }
);

export interface WithMetadata<T, Metadata = unknown> {
  value: T | null;
  metadata: Metadata | null;
  cacheStatus: null;
}

export interface Namespace {
  get(key: string, options?: GetOptions<'text'>): Promise<string | null>;
  get<T = unknown>(key: string, options: GetOptions<'json'>): Promise<T | null>;
  get(key: string, options: GetOptions<'arrayBuffer'>): Promise<ArrayBuffer | null>;
  get(key: string, options: GetOptions<'stream'>): Promise<ReadableStream<Uint8Array> | null>;
  getWithMetadata<M = unknown>(key: string, options?: GetOptions<'text'>): Promise<WithMetadata<string, M>>;
  getWithMetadata<T = unknown, M = unknown>(key: string, options: GetOptions<'json'>): Promise<WithMetadata<T, M>>;
  getWithMetadata<M = unknown>(key: string, options: GetOptions<'arrayBuffer'>): Promise<WithMetadata<ArrayBuffer, M>>;
  getWithMetadata<M = unknown>(
    key: string,
    options: GetOptions<'stream'>,
  ): Promise<WithMetadata<ReadableStream<Uint8Array>, M>>;
  put(key: string, value: Value, options?: PutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list<M = unknown>(options?: ListOptions): Promise<ListResult<M>>;
  /** Not in KV: closes the file. */
  close(): void;
}

export interface OpenOptions {
  /** The data_secure folder, when it isn't the one from @lunega/paths. */
  dir?: string;
  /** The SQLite file itself; `dir` is then unused. */
  path?: string;
}

const NAME = /^[A-Z][A-Z0-9_]*$/;
// KV's own limits, so what works here works there.
const MAX_KEY = 512;
const MAX_VALUE = 25 * 1024 * 1024;
const MAX_METADATA = 1024;
const MAX_LIST = 1000;
const MIN_TTL = 60;
// The old and the new container share the file during a switch-over.
const BUSY_TIMEOUT = 5000;
// Expired keys are skipped on every read; this is how often a put also
// deletes the ones nobody asked for again.
const SWEEP_EVERY = 60;

const opened = new Map<string, Namespace>();

/** Where a binding's file is. */
export function pathOf(name: string, dir: string = dataSecure): string {
  if (!NAME.test(name)) throw new Error(`kv: invalid name ${JSON.stringify(name)}, must match ${NAME}`);
  return join(dir, 'kv', `${name}.sqlite`);
}

/** Opens (and creates) a binding's namespace; the same object for the same file. */
export function open(name: string, options: OpenOptions = {}): Namespace {
  const path = resolve(options.path ?? pathOf(name, options.dir));
  const existing = opened.get(path);
  if (existing) return existing;
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new DatabaseSync(path, { timeout: BUSY_TIMEOUT });
  try {
    // NORMAL: with WAL a power cut can lose the last writes, never the file.
    sqlite.exec(`PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, expiration INTEGER, metadata TEXT);
      CREATE INDEX IF NOT EXISTS kv_expiration ON kv (expiration) WHERE expiration IS NOT NULL;`);
  } catch (e) {
    sqlite.close();
    throw e;
  }
  const kv = wrap(sqlite, () => opened.delete(path));
  opened.set(path, kv);
  return kv;
}

interface Row {
  key: string;
  value: Uint8Array;
  expiration: number | null;
  metadata: string | null;
}

const now = () => Math.floor(Date.now() / 1000);

function wrap(sqlite: DatabaseSync, onClose: () => void): Namespace {
  const select = sqlite.prepare('SELECT value, expiration, metadata FROM kv WHERE key = ?');
  const upsert = sqlite.prepare(
    `INSERT INTO kv (key, value, expiration, metadata) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, expiration = excluded.expiration, metadata = excluded.metadata`,
  );
  const remove = sqlite.prepare('DELETE FROM kv WHERE key = ?');
  const removeExpired = sqlite.prepare('DELETE FROM kv WHERE key = ? AND expiration <= ?');
  const sweep = sqlite.prepare('DELETE FROM kv WHERE expiration <= ?');
  // Keys sort by their UTF-8 bytes, as in KV.
  const page = sqlite.prepare(
    `SELECT key, expiration, metadata FROM kv
     WHERE key > ? AND key >= ? AND (expiration IS NULL OR expiration > ?) ORDER BY key`,
  );
  let swept = 0;

  const read = (key: string): Pick<Row, 'value' | 'metadata'> | undefined => {
    checkKey(key);
    const row = select.get(key) as Omit<Row, 'key'> | undefined;
    if (!row) return undefined;
    const at = now();
    if (row.expiration !== null && row.expiration <= at) {
      // Only if it's still the expired one: the other container may have put it again.
      removeExpired.run(key, at);
      return undefined;
    }
    return row;
  };

  const getWithMetadata = async (key: string, options?: GetOptions): Promise<WithMetadata<unknown>> => {
    const type = typeOf(options);
    const row = read(key);
    if (!row) return { value: null, metadata: null, cacheStatus: null };
    return {
      value: decode(row.value, type),
      metadata: row.metadata === null ? null : (JSON.parse(row.metadata) as unknown),
      cacheStatus: null,
    };
  };

  return {
    get: (async (key: string, options?: GetOptions) =>
      (await getWithMetadata(key, options)).value) as Namespace['get'],
    getWithMetadata: getWithMetadata as Namespace['getWithMetadata'],

    async put(key, value, options = {}) {
      checkKey(key);
      const at = now();
      const expiration = expirationOf(options, at);
      const metadata = metadataOf(options.metadata);
      const bytes = await encode(value);
      if (bytes.byteLength > MAX_VALUE) {
        throw new Error(`KV PUT failed: value of ${bytes.byteLength} bytes is over the limit of ${MAX_VALUE}`);
      }
      upsert.run(key, bytes, expiration, metadata);
      if (at - swept >= SWEEP_EVERY) {
        swept = at;
        sweep.run(at);
      }
    },

    async delete(key) {
      checkKey(key);
      remove.run(key);
    },

    async list<M>(options: ListOptions = {}): Promise<ListResult<M>> {
      const limit = options.limit ?? MAX_LIST;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) {
        throw new Error(`KV LIST failed: limit must be between 1 and ${MAX_LIST}, not ${limit}`);
      }
      const prefix = options.prefix ?? '';
      const after = options.cursor ? decodeCursor(options.cursor) : '';
      const keys: Key<M>[] = [];
      let more = false;
      for (const row of page.iterate(after, prefix, now()) as Iterable<Omit<Row, 'value'>>) {
        // Sorted, so the keys with the prefix are all next to each other.
        if (!row.key.startsWith(prefix)) break;
        if (keys.length === limit) {
          more = true;
          break;
        }
        const key: Key<M> = { name: row.key };
        if (row.expiration !== null) key.expiration = row.expiration;
        if (row.metadata !== null) key.metadata = JSON.parse(row.metadata) as M;
        keys.push(key);
      }
      const last = keys.at(-1);
      return more && last
        ? { keys, list_complete: false, cursor: encodeCursor(last.name), cacheStatus: null }
        : { keys, list_complete: true, cacheStatus: null };
    },

    close() {
      onClose();
      if (sqlite.isOpen) sqlite.close();
    },
  };
}

function checkKey(key: string): void {
  if (typeof key !== 'string' || key === '') throw new TypeError('KV: a key must be a non-empty string');
  if (key === '.' || key === '..') throw new TypeError(`KV: "${key}" is not a valid key`);
  const length = Buffer.byteLength(key);
  if (length > MAX_KEY) throw new Error(`KV: a key of ${length} bytes is over the limit of ${MAX_KEY}`);
}

function typeOf(options: GetOptions | undefined): GetType {
  const type = (typeof options === 'string' ? options : options?.type) ?? 'text';
  if (type !== 'text' && type !== 'json' && type !== 'arrayBuffer' && type !== 'stream') {
    throw new TypeError(`KV: unknown type "${String(type)}", must be text, json, arrayBuffer or stream`);
  }
  return type;
}

function expirationOf({ expiration, expirationTtl }: PutOptions, at: number): number | null {
  if (expirationTtl != null) {
    if (!Number.isInteger(expirationTtl) || expirationTtl < MIN_TTL) {
      throw new Error(`KV PUT failed: expirationTtl of ${expirationTtl}, must be at least ${MIN_TTL} seconds`);
    }
    return at + expirationTtl;
  }
  if (expiration != null) {
    if (!Number.isInteger(expiration) || expiration < at + MIN_TTL) {
      throw new Error(`KV PUT failed: expiration of ${expiration}, must be at least ${MIN_TTL} seconds from now`);
    }
    return expiration;
  }
  return null;
}

function metadataOf(metadata: unknown): string | null {
  if (metadata == null) return null;
  const json = JSON.stringify(metadata);
  if (json === undefined) throw new TypeError('KV PUT failed: metadata must be JSON');
  const length = Buffer.byteLength(json);
  if (length > MAX_METADATA) {
    throw new Error(`KV PUT failed: metadata of ${length} bytes is over the limit of ${MAX_METADATA}`);
  }
  return json;
}

async function encode(value: Value): Promise<Uint8Array> {
  if (typeof value === 'string') return Buffer.from(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
  throw new TypeError('KV PUT failed: a value must be a string, ArrayBuffer, ArrayBufferView or ReadableStream');
}

function decode(value: Uint8Array, type: GetType): unknown {
  switch (type) {
    case 'text':
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString();
    case 'json':
      return JSON.parse(Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString());
    case 'arrayBuffer':
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    case 'stream':
      return new Blob([value as Uint8Array<ArrayBuffer>]).stream();
  }
}

// Opaque to callers: the last key of the page before.
const encodeCursor = (key: string) => Buffer.from(key).toString('base64url');

function decodeCursor(cursor: string): string {
  const key = Buffer.from(cursor, 'base64url').toString();
  if (key === '' || encodeCursor(key) !== cursor) throw new Error('KV LIST failed: invalid cursor');
  return key;
}
