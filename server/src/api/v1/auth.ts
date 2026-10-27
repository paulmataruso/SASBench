import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Db, Row } from '../../db.ts';
import type { SettingsStore } from '../../settings.ts';

// Authentication for the UI port. Three ways in:
//   - open: no UI password is set (the lab default); every caller has write access;
//   - password: HTTP Basic with the UI password (any user name); write access;
//   - token: "Authorization: Bearer <API token>"; read or write access per token.
// A presented token is always checked, even when the port is open.

export type Scope = 'read' | 'write';

export interface Principal {
  method: 'open' | 'password' | 'token';
  scope: Scope;
  tokenId?: string;
  tokenName?: string;
}

export interface TokenRecord {
  id: string;
  name: string;
  scope: Scope;
  prefix: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  lastUsedAddr: string | null;
}

export type AuthResult = { ok: true; principal: Principal } | { ok: false; reason: 'missing' | 'invalid' | 'expired' };

const TOKEN_PREFIX = 'sasb_';
const TOUCH_EVERY_MS = 60_000;

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
      lastUsedAt: r.last_used_at ?? null, lastUsedAddr: r.last_used_addr ?? null,
    };
  }

  /** Creates a token. The secret is returned only here; the database keeps its SHA-256 hash. */
  create(o: { name: string; scope: Scope; expiresAt: number | null }): { token: string; record: TokenRecord } {
    const token = TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url');
    const id = crypto.randomUUID();
    this.db.run('INSERT INTO api_tokens(id, name, scope, token_hash, prefix, created_at, expires_at) VALUES (?,?,?,?,?,?,?)',
      id, o.name, o.scope, hash(token), token.slice(0, TOKEN_PREFIX.length + 6), Date.now(), o.expiresAt);
    return { token, record: this.get(id)! };
  }

  list(): TokenRecord[] {
    return this.db.all('SELECT * FROM api_tokens ORDER BY created_at').map((r) => this.out(r));
  }

  get(id: string): TokenRecord | null {
    const r = this.db.get('SELECT * FROM api_tokens WHERE id = ?', id);
    return r ? this.out(r) : null;
  }

  /** The token still exists and has not expired (for long-lived connections such as the stream). */
  active(id: string): boolean {
    const r = this.get(id);
    return !!r && (r.expiresAt === null || r.expiresAt > Date.now());
  }

  delete(id: string): boolean {
    this.touched.delete(id);
    return this.db.run('DELETE FROM api_tokens WHERE id = ?', id).changes > 0;
  }

  /** The token's record if the secret is valid and unexpired. Records last use at most once a minute. */
  verify(secret: string, addr: string | undefined): TokenRecord | 'expired' | null {
    if (!secret.startsWith(TOKEN_PREFIX)) return null;
    const r = this.db.get('SELECT * FROM api_tokens WHERE token_hash = ?', hash(secret));
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

function passwordMatches(header: string, password: string): boolean {
  const [, given = ''] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(/:(.*)/s);
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(password).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Who is calling. `queryToken` accepts ?access_token= (for EventSource, which cannot set headers).
 * `foreignBearer`: what to do with a Bearer credential that is not an API token (no sasb_ prefix),
 * e.g. an OAuth token a reverse proxy forwards. The API refuses it; the console ignores it, as it
 * did before API tokens existed.
 */
export function authenticate(req: IncomingMessage, settings: SettingsStore, tokens: ApiTokens, queryToken?: string | null,
  foreignBearer: 'reject' | 'ignore' = 'reject'): AuthResult {
  const h = req.headers.authorization ?? '';
  let bearer = /^Bearer\s+(.+)$/i.exec(h)?.[1]?.trim() ?? (queryToken || null);
  if (bearer && !bearer.startsWith(TOKEN_PREFIX) && foreignBearer === 'ignore') bearer = null;
  if (bearer) {
    const rec = tokens.verify(bearer, req.socket.remoteAddress);
    if (rec === 'expired') return { ok: false, reason: 'expired' };
    if (!rec) return { ok: false, reason: 'invalid' };
    return { ok: true, principal: { method: 'token', scope: rec.scope, tokenId: rec.id, tokenName: rec.name } };
  }
  const pw = settings.get().uiPassword;
  if (!pw) return { ok: true, principal: { method: 'open', scope: 'write' } };
  if (h.startsWith('Basic ') && passwordMatches(h, pw)) return { ok: true, principal: { method: 'password', scope: 'write' } };
  return { ok: false, reason: h ? 'invalid' : 'missing' };
}
