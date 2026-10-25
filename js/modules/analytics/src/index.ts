import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

// Umami, proxied under each site's own /__a/ so the tracker is first-party.
// @lunega/app calls setup() at start; handlers import track() for server-side
// events. Off unless NODE_ENV=production, so local runs record nothing.

export interface AnalyticsOptions {
  /** The site's website id in Umami. Without one, analytics stays off. */
  websiteId?: string;
  /** Add the tracker to every HTML page served from `static` (default true). */
  inject?: boolean;
  /** Where Umami's public endpoints are. */
  collectUrl?: string;
}

export interface Analytics {
  readonly websiteId: string;
  readonly inject: boolean;
  /** Serves /__a/*; returns false for any other path. */
  handle(req: IncomingMessage, res: ServerResponse): boolean;
}

export const PREFIX = '/__a';
const DEFAULT_COLLECT_URL = 'https://collect.analytics.lunega.io';
const SCRIPT_TTL = 60 * 60 * 1000;
const MAX_BODY = 64 * 1024;
const TIMEOUT = 5000;
// Umami's tracker sends these; the cache one keeps a visit's events together.
const FORWARDED_HEADERS = ['x-umami-website-id', 'x-umami-hostname', 'x-umami-cache'];

let active: (Analytics & { collectUrl: string }) | undefined;

export function setup(
  options: AnalyticsOptions | false | undefined,
  env: Record<string, string | undefined> = process.env,
): Analytics | undefined {
  active = undefined;
  if (options === false || env.NODE_ENV !== 'production') return undefined;
  if (!options?.websiteId) {
    console.warn('analytics: no websiteId in the config, not tracking');
    return undefined;
  }
  const collectUrl = (options.collectUrl ?? DEFAULT_COLLECT_URL).replace(/\/$/, '');
  const script = scriptCache(collectUrl);
  active = {
    websiteId: options.websiteId,
    inject: options.inject ?? true,
    collectUrl,
    handle(req, res) {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
      const fail = (e: unknown) => {
        console.error('analytics:', e);
        if (!res.headersSent) res.statusCode = 502;
        res.end();
      };
      if (path === `${PREFIX}/script.js` && (req.method === 'GET' || req.method === 'HEAD')) {
        serveScript(script, req, res).catch(fail);
      } else if (path === `${PREFIX}/api/send` && req.method === 'POST') {
        forward(collectUrl, req, res).catch(fail);
      } else {
        res.statusCode = 404;
        res.end();
      }
      return true;
    },
  };
  return active;
}

/** The tracker tag; the tracker derives its endpoint from the script's URL. */
export function scriptTag(websiteId = active?.websiteId): string {
  return websiteId ? `<script defer src="${PREFIX}/script.js" data-website-id="${websiteId}"></script>` : '';
}

/** Puts the tracker in an HTML page, before </head> when there is one. */
export function inject(html: string, websiteId = active?.websiteId): string {
  const tag = scriptTag(websiteId);
  if (!tag || html.includes(`${PREFIX}/script.js`)) return html;
  for (const close of [/<\/head>/i, /<\/body>/i]) {
    const match = close.exec(html);
    if (match) return html.slice(0, match.index) + tag + html.slice(match.index);
  }
  return html + tag;
}

type Visitor = Request | IncomingMessage;

/**
 * Records a custom event, optionally as the visitor of a request (their IP,
 * browser and page). Never throws: a failed send is only logged.
 */
export async function track(name: string, data?: Record<string, unknown>, request?: Visitor): Promise<void> {
  if (!active) return;
  const { headers, url } = visitorOf(request);
  try {
    const res = await fetch(`${active.collectUrl}/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...clientHeaders(headers) },
      body: JSON.stringify({
        type: 'event',
        payload: {
          website: active.websiteId,
          name,
          data,
          hostname: url?.hostname,
          url: url ? url.pathname + url.search : undefined,
          referrer: headers.referer,
          language: headers['accept-language']?.split(',')[0],
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) console.error(`analytics: track ${name}: ${res.status}`);
  } catch (e) {
    console.error(`analytics: track ${name}:`, e);
  }
}

function visitorOf(request?: Visitor): { headers: Record<string, string | undefined>; url?: URL } {
  if (!request) return { headers: {} };
  if (request instanceof Request) {
    return { headers: Object.fromEntries(request.headers), url: new URL(request.url) };
  }
  const headers = flatten(request.headers);
  const host = headers['x-forwarded-host'] ?? headers.host;
  return { headers, url: host ? new URL(request.url ?? '/', `https://${host}`) : undefined };
}

function flatten(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]));
}

// Traefik sets X-Real-Ip and X-Forwarded-For to the visitor's address. Umami
// reads it from X-Lunega-Client-IP (see admin's analytics stack).
function clientHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const ip = headers['x-real-ip'] ?? headers['x-forwarded-for']?.split(',')[0]?.trim();
  const out: Record<string, string> = {};
  if (ip) out['x-lunega-client-ip'] = ip;
  if (headers['user-agent']) out['user-agent'] = headers['user-agent'];
  return out;
}

interface ScriptCache {
  get(): Promise<string>;
}

// Kept for an hour; a stale copy beats a broken tracker while Umami is down.
function scriptCache(collectUrl: string): ScriptCache {
  let body: string | undefined;
  let fetchedAt = 0;
  let pending: Promise<string> | undefined;
  const refresh = async () => {
    const res = await fetch(`${collectUrl}/script.js`, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw new Error(`script.js: ${res.status}`);
    body = await res.text();
    fetchedAt = Date.now();
    return body;
  };
  return {
    get() {
      if (body !== undefined && Date.now() - fetchedAt < SCRIPT_TTL) return Promise.resolve(body);
      pending ??= refresh()
        .catch((e: unknown) => {
          if (body === undefined) throw e;
          console.error('analytics: serving a stale script.js:', e);
          return body;
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}

async function serveScript(script: ScriptCache, req: IncomingMessage, res: ServerResponse) {
  const body = await script.get();
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function forward(collectUrl: string, req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  if (body === undefined) {
    res.statusCode = 413;
    res.end();
    return;
  }
  const headers = flatten(req.headers);
  const upstream = await fetch(`${collectUrl}/api/send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...clientHeaders(headers),
      ...Object.fromEntries(FORWARDED_HEADERS.flatMap((h) => (headers[h] ? [[h, headers[h]]] : []))),
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  res.statusCode = upstream.status;
  const type = upstream.headers.get('content-type');
  if (type) res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

// undefined when the body is over MAX_BODY.
async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
