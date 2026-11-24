import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
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

  // A site that declares API_KEY, with @lunega/secrets installed or not.
  function site(installed: boolean, lunega: object = {}) {
    const root = app({
      'package.json': pkg({ handler: 'server.js', secrets: ['API_KEY'], ...lunega }),
      'server.js': handler,
      'key': 's3cret\n',
    });
    if (installed) {
      const secrets = fileURLToPath(new URL('../../secrets', import.meta.url));
      fs.mkdirSync(path.join(root, 'node_modules/@lunega'), { recursive: true });
      fs.symlinkSync(secrets, path.join(root, 'node_modules/@lunega/secrets'));
    }
    return root;
  }

  test('a declared one comes from its file, as under launcher', async () => {
    const root = site(true);
    process.env.API_KEY_FILE = path.join(root, 'key');
    try {
      const get = await serve(root);
      expect(await (await get('/')).text()).toBe('s3cret');
    } finally {
      delete process.env.API_KEY_FILE;
      delete process.env.API_KEY;
    }
  });

  test('or is a plain variable, without @lunega/secrets', async () => {
    process.env.API_KEY = 'plain';
    try {
      const get = await serve(site(false));
      expect(await (await get('/')).text()).toBe('plain');
    } finally {
      delete process.env.API_KEY;
    }
  });

  test('a declared one without a value is refused at start, before the handler is imported', async () => {
    const root = site(true, { secrets: ['API_KEY', 'OTHER_KEY'] });
    fs.writeFileSync(path.join(root, 'server.js'), `throw new Error('imported');`);
    await expect(start({ root, port: 0 })).rejects.toThrow('secrets: no value for API_KEY, OTHER_KEY');
  });

  test('a file without @lunega/secrets is refused, and says what is needed', async () => {
    const root = site(false);
    process.env.API_KEY_FILE = path.join(root, 'key');
    try {
      await expect(start({ root, port: 0 })).rejects.toThrow(
        'secrets: no value for API_KEY (API_KEY_FILE set, which needs @lunega/secrets, and it is not installed)',
      );
    } finally {
      delete process.env.API_KEY_FILE;
    }
  });

  test('an invalid name is refused at start', async () => {
    await expect(start({ root: site(false, { secrets: ['api_key'] }), port: 0 })).rejects.toThrow(
      'secrets: invalid name "api_key"',
    );
  });

  test('a binding with the name of a secret is refused, and nothing is opened', async () => {
    const root = site(false, { bindings: { API_KEY: { type: 'kv' } } });
    process.env.API_KEY = 'plain';
    try {
      await expect(start({ root, port: 0 })).rejects.toThrow('secrets: API_KEY is also a binding');
      expect(fs.existsSync(path.join(root, 'data_secure'))).toBe(false);
    } finally {
      delete process.env.API_KEY;
    }
  });
});

describe('bindings', () => {
  const handler = `export default {
    async fetch(request, env) {
      globalThis.lunegaTestEnv = env;
      await env.DB.exec('CREATE TABLE IF NOT EXISTS hits (path TEXT)');
      const path = new URL(request.url).pathname;
      await env.DB.prepare('INSERT INTO hits (path) VALUES (?)').bind(path).run();
      await env.CACHE.put('last', path);
      return Response.json({
        hits: await env.DB.prepare('SELECT count(*) AS n FROM hits').first('n'),
        last: await env.CACHE.get('last'),
        value: env.LUNEGA_TEST_VALUE,
      });
    },
  };`;

  // A site with the given @lunega packages installed.
  function site(lunega: object, packages = ['db', 'kv']) {
    const root = app({ 'package.json': pkg({ handler: 'server.js', ...lunega }), 'server.js': handler });
    fs.mkdirSync(path.join(root, 'node_modules/@lunega'), { recursive: true });
    for (const name of packages) {
      const dir = fileURLToPath(new URL(`../../${name}`, import.meta.url));
      fs.symlinkSync(dir, path.join(root, `node_modules/@lunega/${name}`));
    }
    return root;
  }
  const both = { bindings: { DB: { type: 'db' }, CACHE: { type: 'kv' } } };

  test('a db and a kv in the env, next to the variables', async () => {
    process.env.LUNEGA_TEST_VALUE = 'from-env';
    const root = site(both);
    const get = await serve(root);
    expect(await (await get('/a')).json()).toEqual({ hits: 1, last: '/a', value: 'from-env' });
    expect(await (await get('/b')).json()).toEqual({ hits: 2, last: '/b', value: 'from-env' });
    expect(fs.existsSync(path.join(root, 'data_secure/db/DB.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'data_secure/kv/CACHE.sqlite'))).toBe(true);
  });

  test('the data is still there after a restart, and closed with the server', async () => {
    const root = site(both);
    const first = await start({ root, port: 0 });
    await fetch(`http://127.0.0.1:${portOf(first)}/a`);
    const { DB } = (globalThis as unknown as { lunegaTestEnv: { DB: { exec(sql: string): Promise<unknown> } } })
      .lunegaTestEnv;
    await new Promise((resolve) => first.close(resolve));
    await expect(DB.exec('SELECT 1')).rejects.toThrow();
    const get = await serve(root);
    expect(await (await get('/b')).json()).toMatchObject({ hits: 2, last: '/b' });
  });

  test('a binding whose package is not installed is refused at start', async () => {
    await expect(start({ root: site(both, ['db']), port: 0 })).rejects.toThrow(
      'bindings: CACHE needs @lunega/kv, which is not installed',
    );
  });

  test('a name that is not an env var name is refused', async () => {
    for (const name of ['db', 'My-DB', '1DB', '']) {
      const root = site({ bindings: { [name]: { type: 'db' } } });
      await expect(start({ root, port: 0 })).rejects.toThrow('bindings: invalid name');
    }
  });

  test('a name that an environment variable has is refused', async () => {
    process.env.LUNEGA_TEST_TAKEN = '';
    try {
      const root = site({ bindings: { LUNEGA_TEST_TAKEN: { type: 'kv' } } });
      await expect(start({ root, port: 0 })).rejects.toThrow(
        'bindings: LUNEGA_TEST_TAKEN is already an environment variable',
      );
    } finally {
      delete process.env.LUNEGA_TEST_TAKEN;
    }
  });

  test('an unknown type is refused', async () => {
    for (const binding of [{ type: 'r2' }, { type: 'constructor' }, {}, null]) {
      const root = site({ bindings: { BUCKET: binding } });
      await expect(start({ root, port: 0 })).rejects.toThrow('bindings: BUCKET has type');
    }
  });
});

describe('data folders', () => {
  test('made when the config asks for them', async () => {
    const root = app({ 'package.json': pkg({ data: true }) });
    await serve(root);
    expect(fs.existsSync(path.join(root, 'data'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'data_secure'))).toBe(false);

    const secure = app({ 'package.json': pkg({ dataSecure: true }) });
    await serve(secure);
    expect(fs.existsSync(path.join(secure, 'data'))).toBe(false);
    expect(fs.existsSync(path.join(secure, 'data_secure'))).toBe(true);
  });

  test('left alone otherwise', async () => {
    const root = app({ 'package.json': pkg({}) });
    await serve(root);
    expect(fs.readdirSync(root)).toEqual(['package.json']);
  });

  // root writes anywhere, so there is nothing to refuse.
  test.skipIf(process.getuid?.() === 0)('one that cannot be written to is refused at start', async () => {
    const root = app({ 'package.json': pkg({ dataSecure: true }), 'data_secure/keep': '' });
    fs.chmodSync(path.join(root, 'data_secure'), 0o500);
    await expect(start({ root, port: 0 })).rejects.toThrow(
      `dataSecure: ${path.join(root, 'data_secure')} is missing or not writable (EACCES)`,
    );
    fs.chmodSync(path.join(root, 'data_secure'), 0o700);
  });

  test('one that cannot be made is refused at start', async () => {
    const root = app({ 'package.json': pkg({ data: true }), 'data': 'a file' });
    await expect(start({ root, port: 0 })).rejects.toThrow(
      `data: ${path.join(root, 'data')} is missing or not writable (EEXIST)`,
    );
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

  test('the website id can come from LUNEGA_ANALYTICS_WEBSITE_ID', async () => {
    process.env.LUNEGA_ANALYTICS_WEBSITE_ID = ID;
    try {
      const get = await serve(site({}));
      expect(await (await get('/docs/')).text()).toBe(`<head>${tag}</head>docs`);
    } finally {
      delete process.env.LUNEGA_ANALYTICS_WEBSITE_ID;
    }
  });

  test('analytics: false turns it all off', async () => {
    const get = await serve(site(false));
    expect(await (await get('/')).text()).toBe('<html><head></head><body>home</body></html>');
    expect((await get('/__a/script.js')).status).toBe(404);
  });
});
