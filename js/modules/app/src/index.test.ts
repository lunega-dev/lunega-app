import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

  test('loaded before the handler when the app has @lunega-dev/secrets', async () => {
    const root = app({ 'package.json': pkg({ handler: 'server.js' }), 'server.js': handler, 'key': 's3cret\n' });
    const secrets = fileURLToPath(new URL('../../secrets', import.meta.url));
    fs.mkdirSync(path.join(root, 'node_modules/@lunega-dev'), { recursive: true });
    fs.symlinkSync(secrets, path.join(root, 'node_modules/@lunega-dev/secrets'));
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
