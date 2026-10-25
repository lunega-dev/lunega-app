import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { root as appRoot, temp } from '@lunega/paths';
import sirv from 'sirv';
import { loadConfig, type Config } from './config.js';
import { loadHandler, type Listener } from './handler.js';
import { importOptional } from './optional.js';

export type { Config } from './config.js';
export type { ExecutionContext, FetchHandler } from './handler.js';

// The part of @lunega/analytics this uses; it's optional, so no dependency.
interface AnalyticsModule {
  setup(options: Config['analytics']): Analytics | undefined;
  inject(html: string): string;
}
interface Analytics {
  readonly inject: boolean;
  handle(req: IncomingMessage, res: ServerResponse): boolean;
}

export interface StartOptions {
  root?: string;
  port?: number;
}

export async function start({
  root = appRoot,
  port = Number(process.env.PORT ?? 3000),
}: StartOptions = {}): Promise<Server> {
  // Before the handler is imported, so it sees its secrets at import time.
  const secrets = await importOptional<{ loadFileSecrets(): void }>(root, '@lunega/secrets');
  secrets?.loadFileSecrets();

  const config = await loadConfig(root);

  const analyticsModule = await importOptional<AnalyticsModule>(root, '@lunega/analytics');
  if (config.analytics && !analyticsModule) {
    console.warn('analytics: configured, but @lunega/analytics is not installed');
  }
  const analytics = analyticsModule?.setup(config.analytics);
  const inject = analytics?.inject ? analyticsModule?.inject : undefined;

  // Pages-style routing: /about -> about.html, /docs/ -> docs/index.html.
  const staticDir = config.static ? join(root, config.static) : undefined;
  const serveDir = (dir: string) => sirv(dir, { extensions: ['html'], etag: true });
  const original = staticDir ? serveDir(staticDir) : undefined;
  // With the tracker injected, the HTML pages are served from rewritten copies
  // and everything else falls through to the original files.
  const pages = staticDir && inject ? serveDir(injectedCopies(staticDir, inject)) : undefined;
  const files = pages && original ? chain(pages, original) : original;
  const notFoundPath = staticDir ? join(staticDir, '404.html') : undefined;
  const notFoundHtml = notFoundPath && existsSync(notFoundPath) ? readFileSync(notFoundPath, 'utf8') : undefined;
  const notFoundPage = notFoundHtml !== undefined && inject ? inject(notFoundHtml) : notFoundHtml;

  const handler = config.handler
    ? await loadHandler(root, config.handler, () =>
        notFoundPage !== undefined
          ? new Response(notFoundPage, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
          : new Response('Not Found', { status: 404 }),
      )
    : undefined;

  const notFound = (res: ServerResponse) => {
    res.statusCode = 404;
    if (notFoundPage) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(notFoundPage);
    } else {
      res.end('Not Found');
    }
  };

  const callHandler = (h: Listener, req: Parameters<Listener>[0], res: ServerResponse) => {
    Promise.resolve(h(req, res)).catch((e: unknown) => {
      console.error(e);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  };

  const server = createServer((req, res) => {
    if (req.url === '/__health') {
      res.end('ok');
      return;
    }
    if (analytics?.handle(req, res)) return;
    // Files first, then the handler, then the 404 page.
    const next = () => (handler ? callHandler(handler, req, res) : notFound(res));
    if (files) files(req, res, next);
    else next();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve());
  });
  return server;
}

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

const chain =
  (first: Middleware, second: Middleware): Middleware =>
  (req, res, next) =>
    first(req, res, () => second(req, res, next));

// Copies of the .html files under dir, rewritten, in a fresh dir under temp.
function injectedCopies(dir: string, rewrite: (html: string) => string): string {
  const out = mkdtempSync(join(temp, 'static-'));
  for (const file of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    if (!file.endsWith('.html')) continue;
    const target = join(out, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, rewrite(readFileSync(join(dir, file), 'utf8')));
  }
  return out;
}

export function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
}
