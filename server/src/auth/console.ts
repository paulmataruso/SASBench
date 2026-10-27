import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { readBody, sendJson } from '../net/http.ts';
import type { Bus } from '../bus.ts';
import type { Auth, Principal } from '../api/v1/auth.ts';
import { DOWNLOAD_FORMATS } from '../api/v1/routes/certs.ts';
import { SESSION_COOKIE, SESSION_MAX_MS, cookie } from './users.ts';

// The web console's sign-in (a session cookie) and the gate in front of everything it loads:
// /api/* and the map tiles. The page itself and its scripts load without signing in, so the
// browser can show the sign-in form; they contain no data.

const KEY_FORMATS = new Set(DOWNLOAD_FORMATS.filter((f) => f.key).map((f) => f.format));

const secure = (req: IncomingMessage) =>
  !!(req.socket as TLSSocket).encrypted || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';

function sessionCookie(req: IncomingMessage, value: string, maxAgeSec: number) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure(req) ? '; Secure' : ''}`;
}

/**
 * A request a page on another origin made the browser send. State-changing requests must come
 * from the console itself: browsers send Origin with them, and Sec-Fetch-Site from modern ones.
 * Scripts send neither and are not affected.
 */
export function crossOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin) {
    try {
      return new URL(origin).host !== req.headers.host;
    } catch {
      return true;
    }
  }
  const site = String(req.headers['sec-fetch-site'] ?? '');
  return site === 'cross-site' || site === 'same-site';
}

const addrOf = (req: IncomingMessage) => req.socket.remoteAddress ?? null;

/**
 * Lets a request to the console's data through, or answers it (401, 403, 429) and returns null.
 * Viewers and read-only API keys may read, except private keys; changes need write access.
 */
export async function gate(auth: Auth, req: IncomingMessage, res: ServerResponse, url: URL): Promise<Principal | null> {
  const a = await auth.authenticate(req, { foreignBearer: 'ignore' });
  if (!a.ok) {
    await readBody(req).catch(() => undefined);
    if (a.reason === 'throttled') {
      sendJson(res, 429, { error: `Too many wrong passwords; try again in ${a.retryAfterSec} s`, code: 'too_many_attempts' }, { 'Retry-After': String(a.retryAfterSec) });
    } else {
      // No WWW-Authenticate challenge: the console shows its own sign-in form instead of the browser's.
      sendJson(res, 401, { error: a.reason === 'disabled' ? 'This user account is disabled' : a.reason === 'missing' ? 'Sign in required' : 'Invalid credentials', code: 'unauthorized' });
    }
    return null;
  }
  const p = a.principal;
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET');
  const refuse = async (status: number, code: string, error: string) => {
    await readBody(req).catch(() => undefined);
    sendJson(res, status, { error, code });
    return null;
  };
  if (write && crossOrigin(req)) return refuse(403, 'origin_not_allowed', 'Changes must come from the SASBench console itself');
  const readOnly = p.method === 'token' ? 'This API key is read-only' : 'Viewers have read-only access';
  if (write && p.scope !== 'write') return refuse(403, 'forbidden', readOnly);
  if (p.scope !== 'write' && /^\/api\/certs\/[^/]+\/download$/.test(url.pathname) && KEY_FORMATS.has(url.searchParams.get('format') ?? 'pem')) {
    return refuse(403, 'forbidden', `${readOnly}: downloading a private key needs write access`);
  }
  return p;
}

/** /api/auth/login, /logout and /me. Returns false for other paths. */
export async function handleAuthRoute(auth: Auth, bus: Bus, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const method = req.method ?? 'GET';
  const only = async (m: string) => {
    if (method === m) return true;
    await readBody(req).catch(() => undefined);
    sendJson(res, 405, { error: `Use ${m}`, code: 'method_not_allowed' }, { Allow: m });
    return false;
  };
  switch (url.pathname) {
    case '/api/auth/login': {
      if (!(await only('POST'))) return true;
      if (crossOrigin(req)) {
        await readBody(req).catch(() => undefined);
        sendJson(res, 403, { error: 'Sign in from the SASBench console itself', code: 'origin_not_allowed' });
        return true;
      }
      let b: any;
      try {
        b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      } catch {
        sendJson(res, 400, { error: 'The request body is not valid JSON', code: 'invalid_json' });
        return true;
      }
      const username = typeof b?.username === 'string' ? b.username.trim().slice(0, 64) : '';
      const password = typeof b?.password === 'string' ? b.password : '';
      if (!username || !password) {
        sendJson(res, 400, { error: 'Enter a user name and password', code: 'validation_failed' });
        return true;
      }
      const r = await auth.checkPassword(username, password, req.socket.remoteAddress);
      if (!r.ok) {
        if (r.reason === 'throttled') {
          sendJson(res, 429, { error: `Too many wrong passwords; try again in ${r.retryAfterSec} s`, code: 'too_many_attempts' }, { 'Retry-After': String(r.retryAfterSec) });
        } else if (r.reason === 'disabled') {
          bus.event('warn', 'auth', `Sign-in refused for disabled user ${username} from ${addrOf(req)}`);
          sendJson(res, 403, { error: 'This user account is disabled', code: 'account_disabled' });
        } else {
          bus.event('warn', 'auth', `Failed sign-in as ${JSON.stringify(username)} from ${addrOf(req)}`);
          sendJson(res, 401, { error: 'Wrong user name or password', code: 'unauthorized' });
        }
        return true;
      }
      const s = auth.sessions.create(r.userId, addrOf(req), String(req.headers['user-agent'] ?? '') || null);
      auth.users.recordLogin(r.userId, addrOf(req));
      const user = auth.users.get(r.userId)!;
      bus.event('info', 'auth', `${user.username} signed in from ${addrOf(req)}`);
      bus.changed('users');
      sendJson(res, 200, { user, authEnabled: !auth.off }, { 'Set-Cookie': sessionCookie(req, s.secret, Math.floor(SESSION_MAX_MS / 1000)) });
      return true;
    }
    case '/api/auth/logout': {
      if (!(await only('POST'))) return true;
      await readBody(req).catch(() => undefined);
      const sid = cookie(req.headers.cookie, SESSION_COOKIE);
      const s = sid ? auth.sessions.resolve(sid) : null;
      if (s) {
        auth.sessions.revoke(s.id);
        bus.emit('auth-changed', s.userId);
        bus.event('info', 'auth', `${auth.users.get(s.userId)?.username ?? 'A user'} signed out`);
        bus.changed('users');
      }
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
      return true;
    }
    case '/api/auth/me': {
      if (!(await only('GET'))) return true;
      const a = await auth.authenticate(req, { foreignBearer: 'ignore' });
      if (!a.ok) {
        sendJson(res, 401, { error: 'Sign in required', code: 'unauthorized', authEnabled: !auth.off });
        return true;
      }
      const p = a.principal;
      sendJson(res, 200, {
        method: p.method, role: p.role, scope: p.scope, tokenName: p.tokenName ?? null,
        user: p.userId !== undefined ? auth.users.get(p.userId) : null, authEnabled: !auth.off,
      });
      return true;
    }
    default:
      return false;
  }
}
