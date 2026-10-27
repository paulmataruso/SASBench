import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Db } from '../src/db.ts';
import { startSas, type TestSas } from './helpers.ts';

// Sign-in around the edges: the first-start admin account, the wrong-password throttle, the
// command-line password reset, and SAS_AUTH=off. The users, roles, sessions and API keys
// themselves are tested in api-v1.test.ts.

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const basic = (user: string, pw: string) => ({ Authorization: `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}` });

describe('authentication', () => {
  const started: TestSas[] = [];
  const dirs: string[] = [];
  const start = async (env: Record<string, string> = {}, opts: { dataDir?: string; adminPassword?: string } = {}) => {
    const s = await startSas(env, opts);
    started.push(s);
    return s;
  };
  const tempDir = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sasbench-auth-'));
    dirs.push(d);
    return d;
  };
  after(async () => {
    for (const s of started) await s.stop();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  const v1 = (s: TestSas, p: string, headers: Record<string, string> = {}, init: { method?: string; body?: unknown } = {}) =>
    fetch(`http://127.0.0.1:${s.uiPort}/api/v1${p}`, {
      method: init.method, headers: { ...headers, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  const login = (s: TestSas, username: string, password: string) =>
    fetch(`http://127.0.0.1:${s.uiPort}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });

  it('creates admin / admin on first start, resets passwords from the command line, and throttles guessing', async () => {
    const sas = await start();
    assert.match(sas.log(), /Created the admin account: user name admin, password admin/);
    const me = await (await fetch(`http://127.0.0.1:${sas.uiPort}/api/auth/me`, { headers: { Authorization: sas.authHeader } })).json() as any;
    assert.deepEqual([me.method, me.user.username, me.user.role, me.user.defaultPassword], ['password', 'admin', 'admin', true]);
    assert.ok((await sas.api('GET', '/api/v1/events?category=auth&q=admin%20account')).items.length >= 1);

    // The reset tool works against the running SAS: the old password (even cached) and the
    // account's sessions stop working at once.
    const cookie = ((await login(sas, 'admin', 'admin')).headers.get('set-cookie') ?? '').split(';')[0];
    assert.equal((await v1(sas, '/status', { Cookie: cookie })).status, 200);
    assert.equal((await v1(sas, '/status', basic('admin', 'admin'))).status, 200);
    const run = (...args: string[]) => promisify(execFile)(process.execPath, [path.join(ROOT, 'server/src/tools/reset-password.ts'), ...args], { env: { ...process.env, SAS_DATA_DIR: sas.dataDir } });
    assert.match((await run('admin', 'reset pw 123')).stdout, /Password set for admin \(admin\); 1 session ended/);
    assert.equal((await v1(sas, '/status', basic('admin', 'admin'))).status, 401);
    assert.equal((await v1(sas, '/status', { Cookie: cookie })).status, 401);
    const A = basic('admin', 'reset pw 123');
    assert.equal(((await (await v1(sas, '/users/1', A)).json()) as any).defaultPassword, false);
    // Without a password it prints a random one; an unknown user name becomes a new admin.
    const out = (await run('rescue')).stdout;
    assert.match(out, /Created admin user rescue/);
    const pw = /New password: (\S+)/.exec(out)![1];
    assert.equal(((await (await v1(sas, '/auth/whoami', basic('rescue', pw))).json()) as any).role, 'admin');
    await assert.rejects(run('admin', 'short'), /at least 8 characters/);
    await assert.rejects(run(), /usage/);

    // Ten wrong passwords from one address within five minutes: further attempts get 429, even
    // with the right password, on the sign-in form, HTTP Basic and the console alike.
    for (let i = 0; i < 10; i++) assert.equal((await login(sas, 'admin', `guess ${i}`)).status, 401);
    const blocked = await login(sas, 'admin', 'reset pw 123');
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 200);
    const basicBlocked = await v1(sas, '/status', basic('Rescue', pw)); // right password, not checked yet
    assert.equal(basicBlocked.status, 429);
    assert.equal(((await basicBlocked.json()) as any).error.code, 'too_many_attempts');
    assert.equal((await fetch(`http://127.0.0.1:${sas.uiPort}/api/status`, { headers: basic('admin', 'nope') })).status, 429);
    // A password checked before the lockout keeps working; changing it needs a fresh check.
    assert.equal((await v1(sas, '/status', A)).status, 200);
    const change = await v1(sas, '/auth/password', A, { method: 'POST', body: { currentPassword: 'reset pw 123', newPassword: 'another pw 1' } });
    assert.equal(change.status, 429);
    // API keys are not passwords: not throttled.
    const key = await (await v1(sas, '/tokens', A, { method: 'POST', body: { name: 'during lockout' } })).json() as any;
    assert.equal((await v1(sas, '/status', { Authorization: `Bearer ${key.token}` })).status, 200);
  });

  it('takes the first admin password from SAS_ADMIN_PASSWORD, or from the UI password of earlier versions', async () => {
    const dataDir = tempDir();
    const sas = await start({ SAS_ADMIN_PASSWORD: 'from the env 1' }, { dataDir });
    assert.match(sas.log(), /Created the admin account \(user name admin, password from SAS_ADMIN_PASSWORD\)/);
    assert.equal((await v1(sas, '/status', basic('admin', 'admin'))).status, 401);
    assert.equal(((await (await v1(sas, '/users/1', { Authorization: sas.authHeader })).json()) as any).defaultPassword, false);
    await sas.stop();
    // Only the first start creates the account: a later SAS_ADMIN_PASSWORD changes nothing.
    const again = await start({ SAS_ADMIN_PASSWORD: 'changed later' }, { dataDir, adminPassword: 'from the env 1' });
    assert.equal((await v1(again, '/status', { Authorization: again.authHeader })).status, 200);
    assert.equal((await v1(again, '/status', basic('admin', 'changed later'))).status, 401);
    assert.doesNotMatch(again.log(), /Created the admin account/);

    // Upgrading: the old single console password becomes the admin's password, and the old
    // setting is removed.
    const legacyDir = tempDir();
    const db = new Db(path.join(legacyDir, 'sas.db'));
    db.run("INSERT INTO settings(key, value) VALUES ('uiPassword', ?)", JSON.stringify('legacy pw 1'));
    db.sql.close();
    const upgraded = await start({}, { dataDir: legacyDir, adminPassword: 'legacy pw 1' });
    assert.match(upgraded.log(), /password from the previous UI password/);
    const rows = await upgraded.api('GET', '/api/v1/data/tables/settings/rows?column=key&value=uiPassword');
    assert.equal(rows.total, 0);
  });

  it('SAS_AUTH=off opens the UI and the API to anyone', async () => {
    const sas = await start({ SAS_AUTH: 'off', SAS_API_STREAM_PING_MS: '200' });
    assert.match(sas.log(), /SAS_AUTH=off/);
    const who = await (await v1(sas, '/auth/whoami')).json() as any;
    assert.deepEqual([who.method, who.role, who.scope, who.authEnabled], ['open', 'admin', 'write', false]);
    assert.equal((await fetch(`http://127.0.0.1:${sas.uiPort}/api/status`)).status, 200);
    const me = await (await fetch(`http://127.0.0.1:${sas.uiPort}/api/auth/me`)).json() as any;
    assert.deepEqual([me.method, me.authEnabled, me.user], ['open', false, null]);
    assert.equal((await v1(sas, '/registry/user-ids', {}, { method: 'POST', body: { userId: 'open-user' } })).status, 201);
    // Wrong passwords are ignored, but a presented API key is still checked.
    assert.equal((await v1(sas, '/status', basic('admin', 'wrong'))).status, 200);
    assert.equal((await v1(sas, '/status', { Authorization: 'Bearer sasb_not-a-key' })).status, 401);
    // An open stream stays open (it is checked at every keep-alive).
    const st = await v1(sas, '/stream?types=changed').then((r) => r.body!.getReader());
    let got = '';
    while (!got.includes(': ping')) got += Buffer.from((await st.read()).value!).toString('utf8');
    await st.cancel();
    // Even without sign-in there is always an enabled admin to sign in with.
    const lastAdmin = await v1(sas, '/users/1', {}, { method: 'DELETE' });
    assert.deepEqual([lastAdmin.status, ((await lastAdmin.json()) as any).error.code], [409, 'conflict']);
    // Signing in still works, as that user.
    const cookie = ((await login(sas, 'admin', 'admin')).headers.get('set-cookie') ?? '').split(';')[0];
    assert.equal(((await (await v1(sas, '/auth/whoami', { Cookie: cookie })).json()) as any).method, 'session');
  });
});
