import type { IncomingMessage, ServerResponse } from 'node:http';

// Minimal HTTP utilities shared by the SAS listeners and the admin/UI server.

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function readBody(req: IncomingMessage, limit = 16 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req: IncomingMessage): Promise<any> {
  const b = await readBody(req);
  if (!b.length) return {};
  try {
    return JSON.parse(b.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length, 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

export function sendBuffer(res: ServerResponse, status: number, data: Buffer | string, contentType: string, filename?: string) {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  const h: Record<string, string | number> = { 'Content-Type': contentType, 'Content-Length': buf.length, 'Cache-Control': 'no-store' };
  if (filename) h['Content-Disposition'] = `attachment; filename="${filename.replace(/"/g, '')}"`;
  res.writeHead(status, h);
  res.end(buf);
}

export type Handler = (ctx: RouteCtx) => Promise<unknown> | unknown;

export interface RouteCtx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: () => Promise<any>;
}

interface Route { method: string; re: RegExp; keys: string[]; handler: Handler }

/** Tiny path router: '/api/cbsds/:id' style patterns. Handlers return JSON-able values or write the response themselves. */
export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler) {
    const keys: string[] = [];
    const re = new RegExp('^' + pattern.replace(/\/:([A-Za-z_]+)/g, (_m, k) => {
      keys.push(k);
      return '/([^/]+)';
    }) + '/?$');
    this.routes.push({ method, re, keys, handler });
    return this;
  }
  get(p: string, h: Handler) { return this.add('GET', p, h); }
  post(p: string, h: Handler) { return this.add('POST', p, h); }
  put(p: string, h: Handler) { return this.add('PUT', p, h); }
  patch(p: string, h: Handler) { return this.add('PATCH', p, h); }
  delete(p: string, h: Handler) { return this.add('DELETE', p, h); }

  /** Returns true when a route matched (and the request was handled). */
  async handle(req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams): Promise<boolean> {
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      let bodyP: Promise<any> | null = null;
      const ctx: RouteCtx = { req, res, params, query, body: () => (bodyP ??= readJson(req)) };
      try {
        const out = await r.handler(ctx);
        if (!res.headersSent && !res.writableEnded) sendJson(res, 200, out ?? { ok: true });
      } catch (e: any) {
        if (res.headersSent) {
          res.destroy();
          return true;
        }
        const status = e instanceof HttpError ? e.status : 400;
        sendJson(res, status, { error: e?.message ?? String(e) });
      }
      return true;
    }
    return false;
  }
}
