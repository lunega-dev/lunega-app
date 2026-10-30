import type { IncomingMessage, ServerResponse } from 'node:http';
import compression from 'compression';

// gzip/brotli for every response, by Accept-Encoding, as it's sent. @lunega/app
// puts it in front of everything when the app has this installed.

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

// Ranges and server-sent events are left alone: a 206 body has to stay the
// bytes it says it is, and an event stream can't wait for zlib to flush.
function filter(req: IncomingMessage, res: ServerResponse): boolean {
  if (res.statusCode === 206) return false;
  if (String(res.getHeader('Content-Type') ?? '').startsWith('text/event-stream')) return false;
  return compression.filter(req as never, res as never);
}

export function compress(): Middleware {
  return compression({ filter: filter as never }) as unknown as Middleware;
}
