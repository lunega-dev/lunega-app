import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';
import { portOf, start } from './index.js';

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// An app root built from { 'relative/path': content }.
function app(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunega-app-'));
  dirs.push(root);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

async function serve(root: string) {
  const server = await start({ root, port: 0 });
  servers.push(server);
  const base = `http://127.0.0.1:${portOf(server)}`;
  return (p: string, init?: RequestInit) => fetch(base + p, init);
}

const pkg = (lunega: object) => JSON.stringify({ name: 'site', lunega });

describe('static', () => {
  const site = () =>
    app({
      'package.json': pkg({ static: 'dist' }),
      'dist/index.html': 'home',
      'dist/about.html': 'about',
      'dist/docs/index.html': 'docs',
      'dist/404.html': 'custom 404',
    });

  test('Pages-style routing', async () => {
    const get = await serve(site());
    expect(await (await get('/')).text()).toBe('home');
    expect(await (await get('/about')).text()).toBe('about');
    expect(await (await get('/docs/')).text()).toBe('docs');
  });

  test('404.html for a missing page', async () => {
    const get = await serve(site());
    const res = await get('/nope');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('custom 404');
  });

  test('plain 404 without a 404.html', async () => {
    const get = await serve(app({ 'package.json': pkg({ static: 'dist' }), 'dist/index.html': 'home' }));
    expect((await get('/nope')).status).toBe(404);
  });

  test('lunega.config.js wins over package.json', async () => {
    const get = await serve(
      app({
        'package.json': pkg({ static: 'dist' }),
        'lunega.config.js': `export default { static: 'public' };`,
        'dist/index.html': 'dist',
        'public/index.html': 'public',
      }),
    );
    expect(await (await get('/')).text()).toBe('public');
  });
});

describe('handler', () => {
  test('Workers-style fetch gets what no file matched, with env and ctx', async () => {
    process.env.LUNEGA_TEST_VALUE = 'from-env';
    const get = await serve(
      app({
        'package.json': pkg({ static: 'public', handler: 'server.js' }),
        'public/index.html': 'home',
        'server.js': `export default {
          fetch(request, env, ctx) {
            ctx.waitUntil(Promise.resolve());
            const url = new URL(request.url);
            return Response.json({ path: url.pathname, method: request.method, value: env.LUNEGA_TEST_VALUE });
          },
        };`,
      }),
    );
    expect(await (await get('/')).text()).toBe('home');
    const res = await get('/download/macos', { method: 'POST' });
    expect(await res.json()).toEqual({ path: '/download/macos', method: 'POST', value: 'from-env' });
  });

  test('(req, res) function, the way an Express app is', async () => {
    const get = await serve(
      app({
        'package.json': pkg({ handler: 'server.js' }),
        'server.js': `export default (req, res) => { res.setHeader('x-app', 'node'); res.end(req.url); };`,
      }),
    );
    const res = await get('/anything');
    expect(res.headers.get('x-app')).toBe('node');
    expect(await res.text()).toBe('/anything');
  });

  test('a fetch handler returning nothing falls through to 404.html', async () => {
    const get = await serve(
      app({
        'package.json': pkg({ static: 'public', handler: 'server.js' }),
        'public/404.html': 'custom 404',
        'server.js': `export default {
          fetch(request) {
            if (new URL(request.url).pathname === '/api') return new Response('api');
          },
        };`,
      }),
    );
    expect(await (await get('/api')).text()).toBe('api');
    const res = await get('/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toBe('custom 404');
  });

  test('a throwing handler gives a 500', async () => {
    const get = await serve(
      app({
        'package.json': pkg({ handler: 'server.js' }),
        'server.js': `export default { fetch() { throw new Error('boom'); } };`,
      }),
    );
    expect((await get('/')).status).toBe(500);
  });

  test('anything else is refused at start', async () => {
    const root = app({ 'package.json': pkg({ handler: 'server.js' }), 'server.js': `export default 42;` });
    await expect(start({ root, port: 0 })).rejects.toThrow('server.js: default export must have a fetch()');
  });
});

test('/__health', async () => {
  const get = await serve(app({ 'package.json': pkg({}) }));
  const res = await get('/__health');
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('ok');
});

describe('secrets', () => {
  const handler = `export default { fetch(request, env) { return new Response(env.API_KEY ?? 'unset'); } };`;

  test('loaded before the handler when the app has @lunega/secrets', async () => {
    const root = app({ 'package.json': pkg({ handler: 'server.js' }), 'server.js': handler, 'key': 's3cret\n' });
    const secrets = fileURLToPath(new URL('../../secrets', import.meta.url));
    fs.mkdirSync(path.join(root, 'node_modules/@lunega'), { recursive: true });
    fs.symlinkSync(secrets, path.join(root, 'node_modules/@lunega/secrets'));
    process.env.API_KEY_FILE = path.join(root, 'key');
    try {
      const get = await serve(root);
      expect(await (await get('/')).text()).toBe('s3cret');
    } finally {
      delete process.env.API_KEY_FILE;
      delete process.env.API_KEY;
    }
  });

  test('skipped when it is not installed', async () => {
    const root = app({ 'package.json': pkg({ handler: 'server.js' }), 'server.js': handler });
    process.env.API_KEY_FILE = '/does/not/exist';
    try {
      const get = await serve(root);
      expect(await (await get('/')).text()).toBe('unset');
    } finally {
      delete process.env.API_KEY_FILE;
    }
  });
});

describe('analytics', () => {
  const ID = '6832f7b0-33ba-4a73-b507-d15b1433b181';
  const tag = `<script defer src="/__a/script.js" data-website-id="${ID}"></script>`;
  let umami: Server;
  let collectUrl: string;
  let env: string | undefined;

  beforeEach(async () => {
    umami = createServer((req, res) => res.end(req.url === '/script.js' ? 'tracker' : '{}'));
    await new Promise<void>((resolve) => umami.listen(0, resolve));
    collectUrl = `http://127.0.0.1:${portOf(umami)}`;
    env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    umami.close();
    process.env.NODE_ENV = env;
  });

  // A site with @lunega/analytics installed.
  function site(analytics: object | false) {
    const root = app({
      'package.json': pkg({ static: 'dist', analytics: analytics && { ...analytics, collectUrl } }),
      'dist/index.html': '<html><head></head><body>home</body></html>',
      'dist/docs/index.html': '<head></head>docs',
      'dist/style.css': 'body{}',
      'dist/404.html': '<head></head>missing',
    });
    const analyticsDir = fileURLToPath(new URL('../../analytics', import.meta.url));
    fs.mkdirSync(path.join(root, 'node_modules/@lunega'), { recursive: true });
    fs.symlinkSync(analyticsDir, path.join(root, 'node_modules/@lunega/analytics'));
    return root;
  }

  test('the tracker goes in every page, the rest is untouched', async () => {
    const get = await serve(site({ websiteId: ID }));
    expect(await (await get('/')).text()).toBe(`<html><head>${tag}</head><body>home</body></html>`);
    expect(await (await get('/docs/')).text()).toBe(`<head>${tag}</head>docs`);
    expect(await (await get('/style.css')).text()).toBe('body{}');
    const missing = await get('/nope');
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe(`<head>${tag}</head>missing`);
  });

  test('/__a/ is proxied to Umami', async () => {
    const get = await serve(site({ websiteId: ID }));
    expect(await (await get('/__a/script.js')).text()).toBe('tracker');
  });

  test('inject: false leaves the pages alone but keeps the proxy', async () => {
    const get = await serve(site({ websiteId: ID, inject: false }));
    expect(await (await get('/')).text()).toBe('<html><head></head><body>home</body></html>');
    expect(await (await get('/__a/script.js')).text()).toBe('tracker');
  });

  test('analytics: false turns it all off', async () => {
    const get = await serve(site(false));
    expect(await (await get('/')).text()).toBe('<html><head></head><body>home</body></html>');
    expect((await get('/__a/script.js')).status).toBe(404);
  });
});

describe('compress', () => {
  const page = `<html><body>${'hello lunega '.repeat(200)}</body></html>`;

  // A site with static files, a handler and a 404 page; with @lunega/compress
  // installed unless installed is false.
  function site(lunega: object = {}, installed = true) {
    const root = app({
      'package.json': pkg({ static: 'dist', handler: 'server.js', ...lunega }),
      'dist/index.html': page,
      'dist/404.html': page,
      'server.js': `export default {
        fetch(request) {
          if (new URL(request.url).pathname === '/api') return new Response(${JSON.stringify(page)});
        },
      };`,
    });
    if (installed) {
      const compressDir = fileURLToPath(new URL('../../compress', import.meta.url));
      fs.mkdirSync(path.join(root, 'node_modules/@lunega'), { recursive: true });
      fs.symlinkSync(compressDir, path.join(root, 'node_modules/@lunega/compress'));
    }
    return root;
  }

  // Content-Encoding and the decoded body of each path, asking for brotli.
  async function brotli(root: string, paths: string[]) {
    const server = await start({ root, port: 0 });
    servers.push(server);
    const get = (p: string) =>
      new Promise<[string | undefined, string]>((resolve, reject) => {
        const req = request({ port: portOf(server), path: p, headers: { 'accept-encoding': 'br' } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks);
            const encoding = res.headers['content-encoding'];
            resolve([encoding, (encoding === 'br' ? brotliDecompressSync(body) : body).toString()]);
          });
        });
        req.on('error', reject);
        req.end();
      });
    return Promise.all(paths.map(get));
  }

  const paths = ['/', '/api', '/nope'];

  test('files, handler responses and the 404 page are compressed', async () => {
    expect(await brotli(site(), paths)).toEqual(paths.map(() => ['br', page]));
  });

  test('compress: false turns it off', async () => {
    expect(await brotli(site({ compress: false }), paths)).toEqual(paths.map(() => [undefined, page]));
  });

  test('nothing is compressed without the package', async () => {
    expect(await brotli(site({}, false), paths)).toEqual(paths.map(() => [undefined, page]));
  });
});
