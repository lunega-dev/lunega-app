import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import compression from 'compression';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

// Text formats. Images, woff2 and archives are compressed already.
const COMPRESSIBLE = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.json', '.map', '.svg', '.xml',
  '.txt', '.md', '.csv', '.webmanifest', '.wasm', '.ico', '.ttf', '.otf',
]);

// Below this the headers outweigh the savings; compression's threshold too.
const MIN_SIZE = 1024;

export const isCompressible = (file: string) => COMPRESSIBLE.has(extname(file).toLowerCase());

export interface Variants {
  br?: Buffer;
  gz?: Buffer;
}

// Static files are compressed once, so at the highest levels. A variant is
// left out when it isn't smaller.
export async function precompress(data: Buffer): Promise<Variants> {
  if (data.length < MIN_SIZE) return {};
  const [br, gzipped] = await Promise.all([
    brotli(data, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
      },
    }),
    gz(data, { level: constants.Z_BEST_COMPRESSION }),
  ]);
  return {
    br: br.length < data.length ? br : undefined,
    gz: gzipped.length < data.length ? gzipped : undefined,
  };
}

// Everything else (handler responses, the 404 page) is compressed as it's
// sent. Ranges and server-sent events are left alone: a 206 body has to stay
// the bytes it says it is, and an event stream can't wait for zlib to flush.
export const compressResponses = compression({
  filter(req, res) {
    if (res.statusCode === 206) return false;
    if (String(res.getHeader('Content-Type') ?? '').startsWith('text/event-stream')) return false;
    return compression.filter(req, res);
  },
}) as unknown as (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
