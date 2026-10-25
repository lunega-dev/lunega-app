import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getRequestListener } from '@hono/node-server';

export type Listener = (req: IncomingMessage, res: ServerResponse) => unknown;

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface FetchHandler {
  /** Returning nothing falls through to the 404 page (like Pages' next()). */
  fetch(
    request: Request,
    env: Record<string, string | undefined>,
    ctx: ExecutionContext,
  ): Response | undefined | void | Promise<Response | undefined | void>;
}

// Enough of the Workers ctx for code ported from Cloudflare: there is no
// request lifetime to extend, so waitUntil only makes sure failures are logged.
const ctx: ExecutionContext = {
  waitUntil(promise) {
    promise.catch((e: unknown) => console.error('waitUntil:', e));
  },
  passThroughOnException() {},
};

// The default export is either Workers-style ({ fetch }, which a Hono app is
// too) or a plain (req, res) function, which an Express app is.
export async function loadHandler(root: string, file: string, notFound: () => Response): Promise<Listener> {
  const mod = (await import(pathToFileURL(join(root, file)).href)) as { default?: unknown };
  const handler = mod.default;
  if (handler && typeof (handler as FetchHandler).fetch === 'function') {
    const fetchHandler = handler as FetchHandler;
    return getRequestListener(async (request) => (await fetchHandler.fetch(request, process.env, ctx)) ?? notFound());
  }
  if (typeof handler === 'function') return handler as Listener;
  throw new Error(`${file}: default export must have a fetch() method or be a (req, res) function`);
}
