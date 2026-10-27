import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Db, Row } from '../../db.ts';
import type { Role, Sessions, Users } from '../../auth/users.ts';
import { SESSION_COOKIE, burnPasswordCheck, cookie, verifyPassword } from '../../auth/users.ts';

// Authentication for the UI port (and the API port). Ways in:
//   - session: the console's login cookie (sasb_session);
//   - password: HTTP Basic with a user name and password (scripts, curl);
//   - token: "Authorization: Bearer <API key>", owned by a user, read or write scope;
//   - open: only when authentication is switched off (SAS_AUTH=off); full access.
// A presented API key is always checked, even when authentication is off.
//
// Roles map to API scopes: viewer → read; operator and admin → write; admin alone manages users.
// An API key acts with at most its owner's role, and stops working when the owner is disabled.

export type Scope = 'read' | 'write';
export type AuthMethod = 'open' | 'session' | 'password' | 'token';

export interface Principal {
  method: AuthMethod;
  scope: Scope;
  role: Role;
  userId?: number;
  username?: string;
  tokenId?: string;
  tokenName?: string;
  /** Session id (hash of the cookie), for the stream's revocation check. */
  sessionId?: string;
  /** passwordChangedAt of the user when HTTP Basic was verified. */
  passwordAt?: number;
}

export type AuthFailure = 'missing' | 'invalid' | 'expired' | 'disabled' | 'throttled';
export type AuthResult = { ok: true; principal: Principal } | { ok: false; reason: AuthFailure; retryAfterSec?: number };

export interface TokenRecord {
  id: string;
  name: string;
  scope: Scope;
  prefix: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  lastUsedAddr: string | null;
  /** Owner; null for keys created before user accounts existed. */
  userId: number | null;
  username: string | null;
}

export const TOKEN_PREFIX = 'sasb_';
const TOUCH_EVERY_MS = 60_000;

export const scopeOf = (role: Role): Scope => (role === 'viewer' ? 'read' : 'write');
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export class ApiTokens {
  private db: Db;
  private touched = new Map<string, number>();

  constructor(db: Db) {
    this.db = db;
  }

  private out(r: Row): TokenRecord {
    return {
      id: r.id, name: r.name, scope: r.scope, prefix: r.prefix, createdAt: r.created_at, expiresAt: r.expires_at ?? null,
      lastUsedAt: r.last_used_at ?? null, lastUsedAddr: r.last_used_addr ?? null, userId: r.user_id ?? null, username: r.username ?? null,
    };
  }

  private readonly SELECT = 'SELECT t.*, u.username FROM api_tokens t LEFT JOIN users u ON u.id = t.user_id';

  /** Creates a key. The secret is returned only here; the database keeps its SHA-256 hash. */
  create(o: { name: string; scope: Scope; expiresAt: number | null; userId: number | null }): { token: string; record: TokenRecord } {
    const token = TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url');
    const id = crypto.randomUUID();
    this.db.run('INSERT INTO api_tokens(id, name, scope, token_hash, prefix, created_at, expires_at, user_id) VALUES (?,?,?,?,?,?,?,?)',
      id, o.name, o.scope, hash(token), token.slice(0, TOKEN_PREFIX.length + 6), Date.now(), o.expiresAt, o.userId);
    return { token, record: this.get(id)! };
  }

  /** Every key, or those owned by one user. */
  list(userId?: number): TokenRecord[] {
    const rows = userId === undefined ? this.db.all(`${this.SELECT} ORDER BY t.created_at`)
      : this.db.all(`${this.SELECT} WHERE t.user_id = ? ORDER BY t.created_at`, userId);
    return rows.map((r) => this.out(r));
  }

  get(id: string): TokenRecord | null {
    const r = this.db.get(`${this.SELECT} WHERE t.id = ?`, id);
    return r ? this.out(r) : null;
  }

  /** The key still exists and has not expired (for long-lived connections such as the stream). */
  active(id: string): boolean {
    const r = this.get(id);
    return !!r && (r.expiresAt === null || r.expiresAt > Date.now());
  }

  delete(id: string): boolean {
    this.touched.delete(id);
    return this.db.run('DELETE FROM api_tokens WHERE id = ?', id).changes > 0;
  }

  /** The key's record if the secret is valid and unexpired. Records last use at most once a minute. */
  verify(secret: string, addr: string | undefined): TokenRecord | 'expired' | null {
    if (!secret.startsWith(TOKEN_PREFIX)) return null;
    const r = this.db.get(`${this.SELECT} WHERE t.token_hash = ?`, hash(secret));
    if (!r) return null;
    const now = Date.now();
    if (r.expires_at != null && r.expires_at <= now) return 'expired';
    if (now - (this.touched.get(r.id) ?? 0) >= TOUCH_EVERY_MS) {
      this.touched.set(r.id, now);
      this.db.run('UPDATE api_tokens SET last_used_at = ?, last_used_addr = ? WHERE id = ?', now, addr ?? null, r.id);
      r.last_used_at = now;
      r.last_used_addr = addr ?? null;
    }
    return this.out(r);
  }
}

export interface AuthOptions {
  /** ?access_token= (EventSource cannot set headers). */
  queryToken?: string | null;
  /**
   * A Bearer credential that is not an API key (no sasb_ prefix), e.g. an OAuth token a reverse
   * proxy forwards: the API refuses it; the console ignores it.
   */
  foreignBearer?: 'reject' | 'ignore';
}

// Wrong passwords: at most FAIL_LIMIT per client address within FAIL_WINDOW_MS.
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 5 * 60_000;
const BASIC_CACHE_MS = 5 * 60_000;

export class Auth {
  readonly users: Users;
  readonly sessions: Sessions;
  readonly tokens: ApiTokens;
  /** Authentication switched off (SAS_AUTH=off): callers without credentials get full access. */
  readonly off: boolean;
  private basicCache = new Map<string, { userId: number; generation: number; changedAt: number | undefined; until: number }>();
  private failures = new Map<string, { n: number; since: number }>();

  constructor(o: { users: Users; sessions: Sessions; tokens: ApiTokens; off?: boolean }) {
    this.users = o.users;
    this.sessions = o.sessions;
    this.tokens = o.tokens;
    this.off = !!o.off;
  }

  /** Seconds until this address may try a password again (0: now). */
  throttled(addr: string | undefined): number {
    const f = this.failures.get(addr ?? '');
    if (!f) return 0;
    const left = f.since + FAIL_WINDOW_MS - Date.now();
    if (left <= 0) {
      this.failures.delete(addr ?? '');
      return 0;
    }
    return f.n >= FAIL_LIMIT ? Math.ceil(left / 1000) : 0;
  }

  private failed(addr: string | undefined) {
    const k = addr ?? '';
    const f = this.failures.get(k);
    if (!f || f.since + FAIL_WINDOW_MS <= Date.now()) this.failures.set(k, { n: 1, since: Date.now() });
    else f.n++;
  }

  /** Checks a user name and password (login form and HTTP Basic). */
  async checkPassword(username: string, password: string, addr: string | undefined): Promise<
    { ok: true; userId: number } | { ok: false; reason: 'invalid' | 'disabled' | 'throttled'; retryAfterSec?: number }> {
    const wait = this.throttled(addr);
    if (wait) return { ok: false, reason: 'throttled', retryAfterSec: wait };
    const row = this.users.row(username);
    if (!row) {
      await burnPasswordCheck(password);
      this.failed(addr);
      return { ok: false, reason: 'invalid' };
    }
    if (!(await verifyPassword(password, row.password_hash))) {
      this.failed(addr);
      return { ok: false, reason: 'invalid' };
    }
    if (!row.enabled) return { ok: false, reason: 'disabled' };
    this.failures.delete(addr ?? '');
    return { ok: true, userId: row.id };
  }

  private userPrincipal(method: 'session' | 'password', userId: number, extra: Partial<Principal> = {}): AuthResult {
    const u = this.users.get(userId);
    if (!u) return { ok: false, reason: 'invalid' };
    if (!u.enabled) return { ok: false, reason: 'disabled' };
    return { ok: true, principal: { method, role: u.role, scope: scopeOf(u.role), userId: u.id, username: u.username, ...extra } };
  }

  async authenticate(req: IncomingMessage, o: AuthOptions = {}): Promise<AuthResult> {
    const addr = req.socket.remoteAddress;
    const h = req.headers.authorization ?? '';
    let bearer = /^Bearer\s+(.+)$/i.exec(h)?.[1]?.trim() ?? (o.queryToken || null);
    if (bearer && !bearer.startsWith(TOKEN_PREFIX) && o.foreignBearer === 'ignore') bearer = null;
    if (bearer) {
      const rec = this.tokens.verify(bearer, addr);
      if (rec === 'expired') return { ok: false, reason: 'expired' };
      if (!rec) return { ok: false, reason: 'invalid' };
      const owner = rec.userId !== null ? this.users.get(rec.userId) : null;
      if (owner && !owner.enabled) return { ok: false, reason: 'disabled' };
      const ownerRole: Role = owner?.role ?? 'operator';
      const scope: Scope = rec.scope === 'read' || scopeOf(ownerRole) === 'read' ? 'read' : 'write';
      return {
        ok: true,
        principal: { method: 'token', scope, role: scope === 'read' ? 'viewer' : ownerRole, userId: owner?.id, username: owner?.username, tokenId: rec.id, tokenName: rec.name },
      };
    }

    const sid = cookie(req.headers.cookie, SESSION_COOKIE);
    if (sid) {
      const s = this.sessions.resolve(sid);
      if (s) {
        const r = this.userPrincipal('session', s.userId, { sessionId: s.id });
        if (r.ok || !this.off) return r;
      }
    }

    if (h.startsWith('Basic ') && !this.off) {
      const key = hash(h);
      const hit = this.basicCache.get(key);
      // passwordChangedAt also catches a reset made by another process (tools/reset-password.ts).
      const changedAt = hit ? this.users.get(hit.userId)?.passwordChangedAt : undefined;
      if (hit && hit.until > Date.now() && hit.generation === this.users.generation && changedAt === hit.changedAt) {
        return this.userPrincipal('password', hit.userId, { passwordAt: changedAt });
      }
      const [user = '', password = ''] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(/:(.*)/s);
      const r = await this.checkPassword(user, password, addr);
      if (!r.ok) return { ok: false, reason: r.reason, retryAfterSec: r.retryAfterSec };
      if (this.basicCache.size > 1000) this.basicCache.clear();
      const at = this.users.get(r.userId)?.passwordChangedAt;
      this.basicCache.set(key, { userId: r.userId, generation: this.users.generation, changedAt: at, until: Date.now() + BASIC_CACHE_MS });
      return this.userPrincipal('password', r.userId, { passwordAt: at });
    }

    if (this.off) return { ok: true, principal: { method: 'open', scope: 'write', role: 'admin' } };
    return { ok: false, reason: h ? 'invalid' : 'missing' };
  }

  /** Whether a principal authenticated earlier may continue (long-lived connections). */
  stillValid(p: Principal): boolean {
    const user = p.userId !== undefined ? this.users.get(p.userId) : null;
    if (p.userId !== undefined && !user?.enabled) return false;
    switch (p.method) {
      case 'token': return this.tokens.active(p.tokenId!);
      case 'session': return this.sessions.active(p.sessionId!);
      case 'password': return user?.passwordChangedAt === p.passwordAt;
      default: return this.off;
    }
  }
}
