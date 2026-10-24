import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { root as appRoot } from '@lunega-dev/paths';
import sirv from 'sirv';
import { loadConfig } from './config.js';
import { loadHandler, type Listener } from './handler.js';
import { importOptional } from './optional.js';

export type { Config } from './config.js';
export type { ExecutionContext, FetchHandler } from './handler.js';

export interface StartOptions {
  root?: string;
  port?: number;
}

export async function start({
  root = appRoot,
  port = Number(process.env.PORT ?? 3000),
}: StartOptions = {}): Promise<Server> {
  // Before the handler is imported, so it sees its secrets at import time.
  const secrets = await importOptional<{ loadFileSecrets(): void }>(root, '@lunega-dev/secrets');
  secrets?.loadFileSecrets();

  const config = await loadConfig(root);
  const handler = config.handler ? await loadHandler(root, config.handler) : undefined;

  // Pages-style routing: /about -> about.html, /docs/ -> docs/index.html.
  const staticDir = config.static ? join(root, config.static) : undefined;
  const files = staticDir ? sirv(staticDir, { extensions: ['html'], etag: true }) : undefined;
  const notFoundPath = staticDir ? join(staticDir, '404.html') : undefined;
  const notFoundPage = notFoundPath && existsSync(notFoundPath) ? readFileSync(notFoundPath) : undefined;

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

export function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
}
