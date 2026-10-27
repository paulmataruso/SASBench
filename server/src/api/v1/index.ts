import crypto from 'node:crypto';
import net from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readBody } from '../../net/http.ts';
import { NotFound } from '../../sas/admin.ts';
import type { Principal } from './auth.ts';
import { ApiError, Reply, SENT, type Ctx, type Route, type V1Deps } from './http.ts';
import { coerceQuery, validate, type Issue } from './schema.ts';
import { COMPONENTS } from './components.ts';
import { ROUTES } from './routes/index.ts';

// /api/v1 dispatcher: CORS and origin check → route match (404/405) → authentication and scope →
// path, query and body validation → handler → JSON (or the handler's own response).
// The same route table produces the OpenAPI document (openapi.ts).

export const BASE = '/api/v1';

interface Compiled {
  route: Route;
  re: RegExp;
  keys: string[];
  rank: number[];
}

function compile(route: Route): Compiled {
  const keys: string[] = [];
  const rank: number[] = [];
  const segs = route.path.split('/').filter(Boolean);
  const re = segs.map((s) => {
    const m = /^\{([A-Za-z]+)(\+?)\}$/.exec(s);
    if (!m) {
      rank.push(3);
      return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    keys.push(m[1]);
    rank.push(m[2] ? 1 : 2);
    return m[2] ? '(.+?)' : '([^/]+)';
  });
  return { route, keys, rank, re: new RegExp(`^/${re.join('/')}/?$`) };
}

/** Literal segments outrank parameters, which outrank catch-alls. */
function byRank(a: Compiled, b: Compiled): number {
  for (let i = 0; i < Math.max(a.rank.length, b.rank.length); i++) {
    const d = (b.rank[i] ?? 0) - (a.rank[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function sameOrigin(origin: string, req: IncomingMessage): boolean {
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const fwd = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
  return host === req.headers.host || (!!fwd && host === fwd);
}

/** The Host header names this SAS: an IP address, localhost, or one of its configured host names. */
function knownHost(host: string, names: string[]): boolean {
  let name: string;
  try {
    name = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (name.startsWith('[')) name = name.slice(1, -1);
  return net.isIP(name) !== 0 || name === 'localhost' || names.some((n) => n.toLowerCase() === name);
}

const STATUS_CODE: Record<number, string> = {
  400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 405: 'method_not_allowed',
  409: 'conflict', 413: 'payload_too_large', 429: 'too_many_attempts', 500: 'internal_error', 503: 'service_unavailable',
};

function toApiError(e: any): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof HttpError) return new ApiError(e.status, STATUS_CODE[e.status] ?? 'error', e.message);
  if (e instanceof NotFound) return new ApiError(404, 'not_found', e.message);
  if (e instanceof SyntaxError) return new ApiError(400, 'bad_request', e.message);
  if ((e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError) && !(e as NodeJS.ErrnoException).code) {
    return new ApiError(500, 'internal_error', e.message);
  }
  return new ApiError(400, 'operation_failed', e?.message ?? String(e));
}

export function buildApiV1(d: V1Deps) {
  const compiled = ROUTES.map(compile).sort(byRank);
  const seen = new Set<string>();
  for (const c of compiled) {
    for (const key of [`${c.route.method} ${c.route.path}`, c.route.operationId]) {
      if (seen.has(key)) throw new Error(`Duplicate API route ${key}`);
      seen.add(key);
    }
  }

  const send = (res: ServerResponse, status: number, body: unknown, head: boolean, headers: Record<string, string> = {}) => {
    if (status === 204 || body === undefined) {
      res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
      res.end();
      return;
    }
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', ...headers });
    res.end(head ? undefined : data);
  };

  const fail = (res: ServerResponse, e: ApiError, requestId: string, head: boolean, headers: Record<string, string> = {}) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const error: Record<string, unknown> = { status: e.status, code: e.code, message: e.message, requestId };
    if (e.details !== undefined) error.details = e.details;
    send(res, e.status, { error }, head, headers);
  };

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const given = String(req.headers['x-request-id'] ?? '');
    const requestId = /^[\w.:-]{1,128}$/.test(given) ? given : crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);
    const method = (req.method ?? 'GET').toUpperCase();
    const head = method === 'HEAD';
    const sub = url.pathname.slice(BASE.length) || '/';

    // Browsers send Origin on cross-site requests; scripts do not. Refuse cross-site writes unless
    // the origin is allowed, so a web page cannot drive an open SAS (CSRF).
    const origin = req.headers.origin;
    let corsHeaders: Record<string, string> = {};
    if (origin) {
      const same = sameOrigin(origin, req);
      const any = d.corsOrigins.includes('*');
      const allowed = same || any || d.corsOrigins.includes(origin);
      if (allowed && !same) {
        corsHeaders = {
          'Access-Control-Allow-Origin': any ? '*' : origin,
          'Access-Control-Expose-Headers': 'X-Request-Id, X-Operation-Id, Location, Content-Disposition',
          Vary: 'Origin',
        };
        for (const [k, v] of Object.entries(corsHeaders)) res.setHeader(k, v);
      }
      if (!allowed && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        await readBody(req).catch(() => undefined);
        return fail(res, new ApiError(403, 'origin_not_allowed', `Requests from ${origin} are not allowed (set SAS_API_CORS_ORIGINS to allow a browser origin)`), requestId, head);
      }
    }

    const matches = compiled.filter((c) => c.re.test(sub));
    if (!matches.length) {
      await readBody(req).catch(() => undefined);
      return fail(res, new ApiError(404, 'route_not_found', `No API route ${method} ${url.pathname}. IDs that contain "/" must be percent-encoded (%2F). See ${BASE}/openapi.json.`), requestId, head);
    }
    const allow: string[] = [...new Set(matches.map((m) => m.route.method))];
    if (allow.includes('GET')) allow.push('HEAD');
    allow.push('OPTIONS');
    if (method === 'OPTIONS') {
      const h: Record<string, string> = { Allow: allow.join(', ') };
      if (corsHeaders['Access-Control-Allow-Origin']) {
        h['Access-Control-Allow-Methods'] = allow.join(', ');
        h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, X-Request-Id';
        h['Access-Control-Max-Age'] = '600';
      }
      res.writeHead(204, h);
      return void res.end();
    }
    const want = head ? 'GET' : method;
    const hit = matches.find((m) => m.route.method === want);
    if (!hit) {
      await readBody(req).catch(() => undefined);
      return fail(res, new ApiError(405, 'method_not_allowed', `${method} is not allowed on ${url.pathname}; use ${allow.join(', ')}`), requestId, head, { Allow: allow.join(', ') });
    }
    const route = hit.route;
    res.setHeader('X-Operation-Id', route.operationId);

    // DNS rebinding: a page on another domain that re-resolves to this SAS is same-origin to the
    // browser, so requests made by a page must name the SAS by a known host name or an IP address,
    // unless their origin is explicitly allowed. Scripts and direct navigation are not affected.
    const fetchSite = String(req.headers['sec-fetch-site'] ?? '');
    const fromPage = !!origin || (fetchSite !== '' && fetchSite !== 'none');
    const originAllowed = !!origin && (d.corsOrigins.includes('*') || d.corsOrigins.includes(origin));
    if (route.scope !== 'public' && fromPage && !originAllowed && !knownHost(String(req.headers.host ?? ''), d.hostnames)) {
      await readBody(req).catch(() => undefined);
      return fail(res, new ApiError(403, 'host_not_allowed',
        `Requests from a web page must reach the SAS by an IP address or a known host name; ${req.headers.host ?? '(none)'} is not one (add it to SAS_HOSTNAMES)`), requestId, head);
    }

    try {
      // ---------------------------------------------------------------- authentication
      let principal: Principal = { method: 'open', scope: 'read', role: 'viewer' };
      if (route.scope !== 'public') {
        const queryToken = route.query?.access_token ? url.searchParams.get('access_token') : null;
        const a = await d.auth.authenticate(req, { queryToken });
        if (!a.ok) {
          await readBody(req).catch(() => undefined);
          if (a.reason === 'throttled') {
            return fail(res, new ApiError(429, 'too_many_attempts', `Too many wrong passwords from this address; try again in ${a.retryAfterSec} s`), requestId, head,
              { 'Retry-After': String(a.retryAfterSec) });
          }
          const [code, msg] = a.reason === 'expired' ? ['unauthorized', 'The API key has expired']
            : a.reason === 'disabled' ? ['account_disabled', 'This user account is disabled']
              : a.reason === 'invalid' ? ['unauthorized', 'Invalid user name, password or API key']
                : ['unauthorized', 'Authentication required: send "Authorization: Bearer <API key>" or HTTP Basic with a user name and password'];
          // A script or an address typed into the browser gets the Basic challenge; the console's
          // own requests (fetch: Sec-Fetch-Mode cors/same-origin) do not, so no browser password
          // dialog covers its sign-in form when a session ends.
          const mode = String(req.headers['sec-fetch-mode'] ?? '');
          const basic = !mode || mode === 'navigate' ? ', Basic realm="SASBench", charset="UTF-8"' : '';
          return fail(res, new ApiError(401, code, msg), requestId, head, { 'WWW-Authenticate': `Bearer realm="SASBench"${basic}` });
        }
        principal = a.principal;
        if (route.scope === 'write' && principal.scope !== 'write') {
          await readBody(req).catch(() => undefined);
          throw new ApiError(403, 'forbidden', `${route.operationId} needs write access; ${principal.method === 'token' ? 'this API key is read-only' : 'viewers have read-only access'}`);
        }
        if (route.scope === 'admin' && (principal.role !== 'admin' || principal.scope !== 'write')) {
          await readBody(req).catch(() => undefined);
          throw new ApiError(403, 'forbidden', `${route.operationId} is for admins${principal.method === 'token' && principal.role === 'admin' ? ' (with a write API key)' : ''}`);
        }
      }

      // ---------------------------------------------------------------- input
      const issues: Issue[] = [];
      const params: Record<string, any> = {};
      const m = hit.re.exec(sub)!;
      hit.keys.forEach((k, i) => {
        let v: unknown;
        try {
          v = decodeURIComponent(m[i + 1]);
        } catch {
          issues.push({ path: k, message: 'is not valid percent-encoding' });
          return;
        }
        const spec = route.params?.[k];
        if (spec?.schema) {
          v = coerceQuery(spec.schema, v as string);
          issues.push(...validate(spec.schema, v, COMPONENTS, k));
        }
        params[k] = v;
      });

      const query: Record<string, any> = {};
      for (const key of new Set(url.searchParams.keys())) {
        if (!route.query || !Object.hasOwn(route.query, key)) issues.push({ path: key, message: 'is not a known query parameter' });
      }
      for (const [k, spec] of Object.entries(route.query ?? {})) {
        const raw = url.searchParams.get(k);
        if (raw === null) {
          if (spec.required) issues.push({ path: k, message: 'is required' });
          else if (spec.schema.default !== undefined) query[k] = spec.schema.default;
          continue;
        }
        const v = coerceQuery(spec.schema, raw);
        issues.push(...validate(spec.schema, v, COMPONENTS, k));
        query[k] = v;
      }

      let body: any = undefined;
      if (method !== 'GET' && !head) {
        const raw = await readBody(req);
        if (route.body) {
          if (!raw.length) {
            if (route.body.required) throw new ApiError(400, 'bad_request', 'A JSON request body is required');
            body = route.body.schema.type === 'object' ? {} : undefined;
          } else {
            try {
              body = JSON.parse(raw.toString('utf8'));
            } catch {
              throw new ApiError(400, 'invalid_json', 'The request body is not valid JSON');
            }
          }
          if (body !== undefined) issues.push(...validate(route.body.schema, body, COMPONENTS, ''));
        }
      }
      if (issues.length) {
        throw new ApiError(400, 'validation_failed', issues.map((i) => `${i.path || '(body)'} ${i.message}`).join('; '), issues);
      }

      // ---------------------------------------------------------------- handler
      const c: Ctx = {
        d, req, res, url, route, params, query, body, principal, requestId, head,
        requireWrite: (what) => {
          if (principal.scope !== 'write') {
            throw new ApiError(403, 'forbidden', `${what} needs write access; ${principal.method === 'token' ? 'this API key is read-only' : 'viewers have read-only access'}`);
          }
        },
        requireAdmin: (what) => {
          if (principal.role !== 'admin' || principal.scope !== 'write') throw new ApiError(403, 'forbidden', `${what} is for admins`);
        },
      };
      const out = await route.handler(c);
      if (out === SENT) {
        if (!res.writableEnded && !res.headersSent) res.end();
        return;
      }
      if (out instanceof Reply) return send(res, out.status, out.body, head, out.headers);
      if (out === undefined) return send(res, 204, undefined, head);
      return send(res, 200, out, head);
    } catch (e: any) {
      const err = toApiError(e);
      if (err.status >= 500) d.bus.event('error', 'api', `${method} ${url.pathname} failed: ${e?.stack ?? e}`);
      return fail(res, err, requestId, head);
    }
  }

  return { handle, routes: compiled.map((c) => c.route) };
}
