import { afterEach, expect, test } from 'vitest';
import { createServer, request, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { compress } from './index.js';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

const text = 'hello lunega '.repeat(200);

// A server that answers every request with respond(), behind compress().
async function serve(respond: (res: ServerResponse) => void) {
  const middleware = compress();
  const server = createServer((req, res) => middleware(req, res, () => respond(res)));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  // The response as sent, not decoded the way fetch does it.
  return (acceptEncoding: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; encoding?: string; vary?: string; body: Buffer }>((resolve, reject) => {
      const req = request({ port, headers: { 'accept-encoding': acceptEncoding, ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            encoding: res.headers['content-encoding'],
            vary: res.headers.vary,
            body: Buffer.concat(chunks),
          }),
        );
      });
      req.on('error', reject);
      req.end();
    });
}

const textResponse = (type: string, status = 200) => (res: ServerResponse) => {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.end(text);
};

test('brotli, gzip or plain by Accept-Encoding', async () => {
  const get = await serve(textResponse('text/html; charset=utf-8'));
  const br = await get('gzip, deflate, br');
  expect(br.encoding).toBe('br');
  expect(br.vary).toBe('Accept-Encoding');
  expect(brotliDecompressSync(br.body).toString()).toBe(text);
  const gz = await get('gzip');
  expect(gz.encoding).toBe('gzip');
  expect(gunzipSync(gz.body).toString()).toBe(text);
  const plain = await get('identity');
  expect(plain.encoding).toBeUndefined();
  expect(plain.body.toString()).toBe(text);
});

test('small responses and images are sent as they are', async () => {
  const small = await serve((res) => {
    res.setHeader('Content-Type', 'text/css');
    res.end('body{}');
  });
  expect((await small('br')).encoding).toBeUndefined();
  const image = await serve(textResponse('image/png'));
  expect((await image('br')).encoding).toBeUndefined();
});

test('ranges and server-sent events are not compressed', async () => {
  expect((await (await serve(textResponse('text/plain', 206)))('br')).encoding).toBeUndefined();
  expect((await (await serve(textResponse('text/event-stream')))('br')).encoding).toBeUndefined();
});
