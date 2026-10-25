import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inject, scriptTag, setup, track, type Analytics } from './index.js';

const prod = { NODE_ENV: 'production' };
const ID = '6832f7b0-33ba-4a73-b507-d15b1433b181';

interface Received {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: string;
}

// A stand-in for collect.analytics.lunega.io.
let umami: Server;
let collectUrl: string;
let received: Received[];
let scriptStatus: number;

beforeEach(async () => {
  received = [];
  scriptStatus = 200;
  umami = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.url === '/script.js') {
      res.statusCode = scriptStatus;
      res.end(`tracker ${received.length}`);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"cache":"c"}');
    }
  });
  await new Promise<void>((resolve) => umami.listen(0, resolve));
  collectUrl = `http://127.0.0.1:${(umami.address() as AddressInfo).port}`;
});

const sites: Server[] = [];
afterEach(() => {
  umami.close();
  for (const s of sites.splice(0)) s.close();
  setup(false);
});

// A site that serves only /__a/*.
async function site(analytics: Analytics) {
  const server = createServer((req, res) => {
    if (!analytics.handle(req, res)) {
      res.statusCode = 418;
      res.end();
    }
  });
  sites.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (p: string, init?: RequestInit) => fetch(base + p, init);
}

describe('setup', () => {
  test('off outside production', () => {
    expect(setup({ websiteId: ID }, { NODE_ENV: 'development' })).toBeUndefined();
  });

  test('off with analytics: false or without a websiteId', () => {
    expect(setup(false, prod)).toBeUndefined();
    expect(setup({}, prod)).toBeUndefined();
  });

  test('injects by default', () => {
    expect(setup({ websiteId: ID }, prod)?.inject).toBe(true);
    expect(setup({ websiteId: ID, inject: false }, prod)?.inject).toBe(false);
  });
});

describe('inject', () => {
  const tag = scriptTag(ID);

  test('before </head>', () => {
    expect(inject('<html><head><title>x</title></head><body></body></html>', ID)).toBe(
      `<html><head><title>x</title>${tag}</head><body></body></html>`,
    );
  });

  test('before </body> without a head, else at the end', () => {
    expect(inject('<body>x</BODY>', ID)).toBe(`<body>x${tag}</BODY>`);
    expect(inject('x', ID)).toBe(`x${tag}`);
  });

  test('not twice', () => {
    const once = inject('<head></head>', ID);
    expect(inject(once, ID)).toBe(once);
  });

  test('nothing without a website id', () => {
    expect(inject('<head></head>')).toBe('<head></head>');
  });
});

describe('proxy', () => {
  test('script.js, cached', async () => {
    const get = await site(setup({ websiteId: ID, collectUrl }, prod)!);
    const res = await get('/__a/script.js');
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect(await res.text()).toBe('tracker 1');
    expect(await (await get('/__a/script.js')).text()).toBe('tracker 1');
    expect(received).toHaveLength(1);
  });

  test('script.js gives a 502 when Umami fails and nothing is cached', async () => {
    scriptStatus = 500;
    const get = await site(setup({ websiteId: ID, collectUrl }, prod)!);
    expect((await get('/__a/script.js')).status).toBe(502);
  });

  test('send passes the visitor on', async () => {
    const get = await site(setup({ websiteId: ID, collectUrl }, prod)!);
    const body = JSON.stringify({ type: 'event', payload: { website: ID, url: '/' } });
    const res = await get('/__a/api/send', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Visitor/1.0',
        'x-forwarded-for': '81.82.83.84, 10.0.0.1',
        'x-umami-cache': 'c',
        cookie: 'session=private',
      },
    });
    expect(await res.json()).toEqual({ cache: 'c' });
    const [sent] = received;
    expect(sent?.url).toBe('/api/send');
    expect(sent?.body).toBe(body);
    expect(sent?.headers['x-lunega-client-ip']).toBe('81.82.83.84');
    expect(sent?.headers['user-agent']).toBe('Visitor/1.0');
    expect(sent?.headers['x-umami-cache']).toBe('c');
    expect(sent?.headers.cookie).toBeUndefined();
  });

  test('X-Real-Ip wins over X-Forwarded-For', async () => {
    const get = await site(setup({ websiteId: ID, collectUrl }, prod)!);
    await get('/__a/api/send', {
      method: 'POST',
      body: '{}',
      headers: { 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' },
    });
    expect(received[0]?.headers['x-lunega-client-ip']).toBe('1.2.3.4');
  });

  test('a body over 64 KiB is refused', async () => {
    const get = await site(setup({ websiteId: ID, collectUrl }, prod)!);
    const res = await get('/__a/api/send', { method: 'POST', body: 'x'.repeat(65 * 1024) });
    expect(res.status).toBe(413);
    expect(received).toHaveLength(0);
  });

  test('other /__a paths are 404, other paths are left alone', async () => {
    const get = await site(setup({ websiteId: ID, collectUrl }, prod)!);
    expect((await get('/__a/login')).status).toBe(404);
    expect((await get('/__a/api/send')).status).toBe(404);
    expect((await get('/about')).status).toBe(418);
    expect((await get('/__about')).status).toBe(418);
  });
});

describe('track', () => {
  test('sends an event as the visitor of a request', async () => {
    setup({ websiteId: ID, collectUrl }, prod);
    const request = new Request('https://example.com/signup?ref=x', {
      headers: { 'x-real-ip': '1.2.3.4', 'user-agent': 'Visitor/1.0', 'accept-language': 'nl-BE,nl;q=0.9' },
    });
    await track('signup', { plan: 'free' }, request);
    const [sent] = received;
    expect(sent?.headers['x-lunega-client-ip']).toBe('1.2.3.4');
    expect(JSON.parse(sent?.body ?? '')).toEqual({
      type: 'event',
      payload: {
        website: ID,
        name: 'signup',
        data: { plan: 'free' },
        hostname: 'example.com',
        url: '/signup?ref=x',
        language: 'nl-BE',
      },
    });
  });

  test('does nothing when off', async () => {
    setup(false);
    await track('signup');
    expect(received).toHaveLength(0);
  });

  test('never throws', async () => {
    setup({ websiteId: ID, collectUrl: 'http://127.0.0.1:1' }, prod);
    await expect(track('signup')).resolves.toBeUndefined();
  });
});
