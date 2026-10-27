import crypto from 'node:crypto';
import type { Db, Row } from '../db.ts';

// User accounts and console sessions. Passwords are stored as scrypt hashes; session cookies and
// API tokens as SHA-256 hashes of their secrets. Nothing secret is stored in the clear.

export type Role = 'admin' | 'operator' | 'viewer';
export const ROLES: Role[] = ['admin', 'operator', 'viewer'];
export const ROLE_INFO: Record<Role, string> = {
  admin: 'Everything, including user accounts and every API key.',
  operator: 'Runs the SAS: changes settings, CBSDs, certificates, registry and faults. Cannot manage users.',
  viewer: 'Read-only: sees everything except private keys, backups and other people\'s API keys.',
};

/** The account created on first start (password from SAS_ADMIN_PASSWORD, else this default). */
export const DEFAULT_ADMIN = { username: 'admin', password: 'admin' };

export const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;
const USERNAME = /^[A-Za-z0-9._@-]{1,64}$/;

export interface UserRecord {
  id: number;
  username: string;
  displayName: string | null;
  role: Role;
  enabled: boolean;
  /** Still using the password it was created with by default (admin/admin). */
  defaultPassword: boolean;
  createdAt: number;
  updatedAt: number;
  passwordChangedAt: number;
  lastLoginAt: number | null;
  lastLoginAddr: string | null;
}

export class UserError extends Error {
  field: string | null;
  constructor(message: string, field: string | null = null) {
    super(message);
    this.field = field;
  }
}

// ---------------------------------------------------------------- passwords

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function scrypt(password: string, salt: Buffer, keylen: number, o: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize('NFKC'), salt, keylen, { ...o, maxmem: 128 * o.N * o.r * 2 }, (e, key) => (e ? reject(e) : resolve(key)));
  });
}

/** "scrypt$N$r$p$salt$hash" (base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  try {
    const got = await scrypt(password, Buffer.from(salt, 'base64'), want.length, { N: Number(n), r: Number(r), p: Number(p) });
    return crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

// Verifying an unknown user name against this costs the same as a real check, so response times
// do not reveal which user names exist.
let dummyHash: Promise<string> | null = null;
export const burnPasswordCheck = async (password: string) => {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummyHash);
};

export function checkNewPassword(password: unknown, field = 'password'): string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new UserError(`Use at least ${MIN_PASSWORD} characters`, field);
  if (password.length > MAX_PASSWORD) throw new UserError(`Use at most ${MAX_PASSWORD} characters`, field);
  return password;
}

export function checkUsername(username: unknown): string {
  if (typeof username !== 'string' || !USERNAME.test(username)) {
    throw new UserError('Use 1–64 letters, digits and . _ @ - (no spaces)', 'username');
  }
  return username;
}

// ---------------------------------------------------------------- users

export class Users {
  private db: Db;
  /** Bumped on every change, so caches of verified credentials can tell when to re-check. */
  generation = 0;

  constructor(db: Db) {
    this.db = db;
  }

  out(r: Row): UserRecord {
    return {
      id: r.id, username: r.username, displayName: r.display_name ?? null, role: r.role, enabled: !!r.enabled,
      defaultPassword: !!r.default_password, createdAt: r.created_at, updatedAt: r.updated_at, passwordChangedAt: r.password_changed_at,
      lastLoginAt: r.last_login_at ?? null, lastLoginAddr: r.last_login_addr ?? null,
    };
  }

  count(): number {
    return this.db.get('SELECT COUNT(*) AS n FROM users')?.n ?? 0;
  }

  list(): UserRecord[] {
    return this.db.all('SELECT * FROM users ORDER BY username COLLATE NOCASE').map((r) => this.out(r));
  }

  get(id: number): UserRecord | null {
    const r = this.db.get('SELECT * FROM users WHERE id = ?', id);
    return r ? this.out(r) : null;
  }

  /** The row with its password hash, by user name (case-insensitive). */
  row(username: string): Row | undefined {
    return this.db.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', username);
  }

  async create(o: { username: string; password: string; role: Role; displayName?: string | null; enabled?: boolean; defaultPassword?: boolean }): Promise<UserRecord> {
    const username = checkUsername(o.username);
    if (!ROLES.includes(o.role)) throw new UserError(`Role must be one of ${ROLES.join(', ')}`, 'role');
    if (this.row(username)) throw new UserError(`User name ${username} is taken`, 'username');
    const now = Date.now();
    const r = this.db.run(`INSERT INTO users(username, display_name, role, password_hash, enabled, default_password, created_at, updated_at, password_changed_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, username, o.displayName || null, o.role, await hashPassword(o.password), o.enabled === false ? 0 : 1,
    o.defaultPassword ? 1 : 0, now, now, now);
    this.generation++;
    return this.get(Number(r.lastInsertRowid))!;
  }

  /** Display name, role and enabled flag. Refuses a change that would leave no enabled admin. */
  update(id: number, patch: { displayName?: string | null; role?: Role; enabled?: boolean }): UserRecord {
    const cur = this.get(id);
    if (!cur) throw new UserError('No such user');
    if (patch.role !== undefined && !ROLES.includes(patch.role)) throw new UserError(`Role must be one of ${ROLES.join(', ')}`, 'role');
    const role = patch.role ?? cur.role;
    const enabled = patch.enabled ?? cur.enabled;
    if (cur.role === 'admin' && cur.enabled && (role !== 'admin' || !enabled) && this.enabledAdmins() <= 1) {
      throw new UserError('This is the only enabled admin: make another user an admin first', patch.role !== undefined ? 'role' : 'enabled');
    }
    this.db.run('UPDATE users SET display_name = ?, role = ?, enabled = ?, updated_at = ? WHERE id = ?',
      patch.displayName !== undefined ? patch.displayName || null : cur.displayName, role, enabled ? 1 : 0, Date.now(), id);
    this.generation++;
    return this.get(id)!;
  }

  async setPassword(id: number, password: string, o: { isDefault?: boolean } = {}): Promise<void> {
    const now = Date.now();
    this.db.run('UPDATE users SET password_hash = ?, default_password = ?, password_changed_at = ?, updated_at = ? WHERE id = ?',
      await hashPassword(password), o.isDefault ? 1 : 0, now, now, id);
    this.generation++;
  }

  /** Deletes the user with their sessions and API tokens. Refuses to delete the last enabled admin. */
  delete(id: number): boolean {
    const cur = this.get(id);
    if (!cur) return false;
    if (cur.role === 'admin' && cur.enabled && this.enabledAdmins() <= 1) throw new UserError('This is the only enabled admin: make another user an admin first');
    this.db.tx(() => {
      this.db.run('DELETE FROM api_tokens WHERE user_id = ?', id);
      this.db.run('DELETE FROM sessions WHERE user_id = ?', id);
      this.db.run('DELETE FROM users WHERE id = ?', id);
    });
    this.generation++;
    return true;
  }

  enabledAdmins(): number {
    return this.db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND enabled = 1")?.n ?? 0;
  }

  recordLogin(id: number, addr: string | null) {
    this.db.run('UPDATE users SET last_login_at = ?, last_login_addr = ? WHERE id = ?', Date.now(), addr, id);
  }
}

// ---------------------------------------------------------------- sessions

export const SESSION_COOKIE = 'sasb_session';
/** A session ends after this long without a request, and in any case after SESSION_MAX_MS. */
export const SESSION_IDLE_MS = 7 * 86400e3;
export const SESSION_MAX_MS = 30 * 86400e3;
const TOUCH_EVERY_MS = 60_000;

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export interface SessionInfo {
  id: string;
  userId: number;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  addr: string | null;
  userAgent: string | null;
}

export class Sessions {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** A new session; returns the cookie secret (only its hash is stored). */
  create(userId: number, addr: string | null, userAgent: string | null): { secret: string; id: string } {
    const now = Date.now();
    this.db.run('DELETE FROM sessions WHERE expires_at <= ? OR created_at <= ?', now, now - SESSION_MAX_MS);
    const secret = crypto.randomBytes(32).toString('base64url');
    const id = sha256(secret);
    this.db.run('INSERT INTO sessions(id, user_id, created_at, last_seen_at, expires_at, addr, user_agent) VALUES (?,?,?,?,?,?,?)',
      id, userId, now, now, now + SESSION_IDLE_MS, addr, userAgent?.slice(0, 256) ?? null);
    return { secret, id };
  }

  /** The live session for a cookie secret, extending it at most once a minute. */
  resolve(secret: string): SessionInfo | null {
    const id = sha256(secret);
    const r = this.db.get('SELECT * FROM sessions WHERE id = ?', id);
    const now = Date.now();
    if (!r || r.expires_at <= now || r.created_at <= now - SESSION_MAX_MS) return null;
    if (now - r.last_seen_at >= TOUCH_EVERY_MS) {
      const expires = Math.min(now + SESSION_IDLE_MS, r.created_at + SESSION_MAX_MS);
      this.db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', now, expires, id);
      r.last_seen_at = now;
      r.expires_at = expires;
    }
    return this.out(r);
  }

  private out(r: Row): SessionInfo {
    return { id: r.id, userId: r.user_id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at, addr: r.addr ?? null, userAgent: r.user_agent ?? null };
  }

  active(id: string): boolean {
    const r = this.db.get('SELECT expires_at, created_at FROM sessions WHERE id = ?', id);
    const now = Date.now();
    return !!r && r.expires_at > now && r.created_at > now - SESSION_MAX_MS;
  }

  forUser(userId: number): SessionInfo[] {
    return this.db.all('SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC', userId, Date.now()).map((r) => this.out(r));
  }

  revoke(id: string) {
    this.db.run('DELETE FROM sessions WHERE id = ?', id);
  }

  /** Ends every session of a user, except `keep` (the caller's own, after a password change). */
  revokeUser(userId: number, keep?: string): number {
    return Number(this.db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', userId, keep ?? '').changes);
  }
}

/** Cookie value by name from a Cookie header. */
export function cookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
