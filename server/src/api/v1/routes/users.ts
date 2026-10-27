import type { Ctx, Route } from '../http.ts';
import { ApiError, conflict, created, forbidden, invalid, noContent, notFound } from '../http.ts';
import { S, ref } from '../schema.ts';
import { createdRef, noContentResp, ok, okRef } from './common.ts';
import { MIN_PASSWORD, ROLES, UserError, checkNewPassword, type Role } from '../../../auth/users.ts';

// User accounts (admins only) and the caller's own password.

const userId = { userId: { description: 'User id (from the user list).', schema: S.int({ minimum: 1 }) } };
const role = S.enum(ROLES, { description: 'admin: everything; operator: everything except users; viewer: read-only.' });
const password = S.str({ minLength: MIN_PASSWORD, maxLength: 256, writeOnly: true, description: `At least ${MIN_PASSWORD} characters.` });

/** UserError → 409 when the change conflicts with other users, else 400 on the field. */
function userError(e: unknown): never {
  if (e instanceof UserError) {
    if (/taken|only enabled admin/.test(e.message)) throw conflict(e.message);
    throw e.field ? invalid(e.field, e.message.replace(/^./, (c) => c.toLowerCase())) : new ApiError(400, 'bad_request', e.message);
  }
  throw e;
}

function userOr404(c: Ctx, id: number) {
  const u = c.d.auth.users.get(id);
  if (!u) throw notFound('User');
  return u;
}

/** Ends a user's open streams and sessions after a change that takes their access away. */
function signOut(c: Ctx, id: number, keep?: string) {
  const n = c.d.auth.sessions.revokeUser(id, keep);
  c.d.bus.emit('auth-changed', id);
  return n;
}

/** The console's user and key lists refetch on these. */
function usersChanged(c: Ctx) {
  c.d.bus.changed('users');
  c.d.bus.changed('tokens');
}

export const userRoutes: Route[] = [
  {
    method: 'GET', path: '/users', operationId: 'listUsers', tag: 'Users', scope: 'admin',
    summary: 'List users',
    description: 'Every account, by user name. Password hashes are never returned.',
    responses: ok('All users.', S.obj({ items: S.arr(ref('User')) }, ['items'])),
    handler: ({ d }) => ({ items: d.auth.users.list() }),
  },
  {
    method: 'POST', path: '/users', operationId: 'createUser', tag: 'Users', scope: 'admin',
    summary: 'Create a user',
    description: '409 when the user name is taken (user names are case-insensitive).',
    body: {
      required: true,
      schema: S.obj({
        username: S.str({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._@-]+$', description: 'Letters, digits and . _ @ -' }),
        password, role,
        displayName: S.nullable(S.str({ maxLength: 100 })),
        enabled: S.bool({ default: true }),
      }, ['username', 'password', 'role']),
      example: { username: 'jsmith', password: 'correct horse battery', role: 'operator', displayName: 'J. Smith' },
    },
    responses: createdRef('The new user.', 'User'),
    errors: [409],
    handler: async (c) => {
      const { d, body } = c;
      const u = await d.auth.users.create({ username: body.username, password: checkNewPassword(body.password), role: body.role, displayName: body.displayName, enabled: body.enabled }).catch(userError);
      d.bus.event('info', 'auth', `User ${u.username} (${u.role}) created by ${c.principal.username ?? c.principal.method}`);
      usersChanged(c);
      return created(u, `/users/${u.id}`);
    },
  },
  {
    method: 'GET', path: '/users/{userId}', operationId: 'getUser', tag: 'Users', scope: 'admin',
    summary: 'Get a user', params: userId,
    responses: okRef('The user.', 'User'),
    handler: (c) => userOr404(c, Number(c.params.userId)),
  },
  {
    method: 'PATCH', path: '/users/{userId}', operationId: 'updateUser', tag: 'Users', scope: 'admin',
    summary: 'Change a user',
    description: 'Display name, role, enabled flag and/or a new password. Disabling a user or setting their password signs them out everywhere (except the caller\'s own session). 409 when the change would leave no enabled admin.',
    params: userId,
    body: {
      required: true,
      schema: S.obj({ displayName: S.nullable(S.str({ maxLength: 100 })), role, enabled: S.bool(), password }),
      example: { role: 'viewer' },
    },
    responses: okRef('The user.', 'User'),
    errors: [409],
    handler: async (c) => {
      const { d, params, body } = c;
      const before = userOr404(c, Number(params.userId));
      const pw = body.password !== undefined ? checkNewPassword(body.password) : null;
      let u = before;
      try {
        if (body.displayName !== undefined || body.role !== undefined || body.enabled !== undefined) {
          u = d.auth.users.update(Number(params.userId), { displayName: body.displayName, role: body.role as Role | undefined, enabled: body.enabled });
        }
      } catch (e) {
        userError(e);
      }
      if (pw !== null) await d.auth.users.setPassword(Number(params.userId), pw);
      const changes = [
        body.role !== undefined && body.role !== before.role && `role ${before.role} → ${body.role}`,
        body.enabled !== undefined && body.enabled !== before.enabled && (body.enabled ? 'enabled' : 'disabled'),
        pw !== null && 'password set',
        body.displayName !== undefined && body.displayName !== before.displayName && 'display name',
      ].filter(Boolean);
      if (pw !== null || body.enabled === false || (body.role !== undefined && body.role !== before.role)) {
        signOut(c, Number(params.userId), c.principal.userId === Number(params.userId) ? c.principal.sessionId : undefined);
      }
      if (changes.length) d.bus.event('info', 'auth', `User ${u.username} changed by ${c.principal.username ?? c.principal.method}: ${changes.join(', ')}`);
      usersChanged(c);
      return d.auth.users.get(Number(params.userId))!;
    },
  },
  {
    method: 'DELETE', path: '/users/{userId}', operationId: 'deleteUser', tag: 'Users', scope: 'admin',
    summary: 'Delete a user',
    description: 'Deletes the account with its sessions and API keys. 409 for your own account and for the last enabled admin.',
    params: userId,
    responses: noContentResp('Deleted.'),
    errors: [409],
    handler: (c) => {
      const u = userOr404(c, Number(c.params.userId));
      if (c.principal.userId === u.id) throw conflict('You cannot delete your own account');
      for (const t of c.d.tokens.list(u.id)) c.d.bus.emit('api-token-revoked', t.id);
      try {
        c.d.auth.users.delete(u.id);
      } catch (e) {
        userError(e);
      }
      c.d.bus.emit('auth-changed', u.id);
      c.d.bus.event('warn', 'auth', `User ${u.username} deleted by ${c.principal.username ?? c.principal.method}`);
      usersChanged(c);
      return noContent();
    },
  },
  {
    method: 'GET', path: '/users/{userId}/sessions', operationId: 'listUserSessions', tag: 'Users', scope: 'admin',
    summary: 'List a user\'s sessions',
    description: 'Console sign-ins that have not expired, most recently used first.',
    params: userId,
    responses: ok('Sessions.', S.obj({ items: S.arr(ref('Session')) }, ['items'])),
    handler: (c) => {
      userOr404(c, Number(c.params.userId));
      return {
        items: c.d.auth.sessions.forUser(Number(c.params.userId)).map(({ id, userId: _u, ...s }) => ({ ...s, current: id === c.principal.sessionId })),
      };
    },
  },
  {
    method: 'DELETE', path: '/users/{userId}/sessions', operationId: 'revokeUserSessions', tag: 'Users', scope: 'admin',
    summary: 'Sign a user out everywhere',
    description: 'Ends every console session of the user (except the caller\'s own). API keys are not affected.',
    params: userId,
    responses: ok('How many sessions ended.', S.obj({ revoked: S.int() }, ['revoked'])),
    handler: (c) => {
      const u = userOr404(c, Number(c.params.userId));
      const revoked = signOut(c, u.id, c.principal.sessionId);
      c.d.bus.event('info', 'auth', `${u.username} signed out everywhere by ${c.principal.username ?? c.principal.method} (${revoked} session${revoked === 1 ? '' : 's'})`);
      usersChanged(c);
      return { revoked };
    },
  },
  {
    method: 'POST', path: '/auth/password', operationId: 'changePassword', tag: 'Users', scope: 'read',
    summary: 'Change your password',
    description: 'For a signed-in user (session or HTTP Basic), not an API key. Your other sessions end; this one stays.',
    body: {
      required: true,
      schema: S.obj({ currentPassword: S.str({ minLength: 1, maxLength: 256, writeOnly: true }), newPassword: password }, ['currentPassword', 'newPassword']),
      example: { currentPassword: 'admin', newPassword: 'a much better password' },
    },
    responses: noContentResp('Changed.'),
    handler: async (c) => {
      const { d, body, principal } = c;
      if (principal.userId === undefined || principal.method === 'token') throw forbidden('Sign in with a user name and password to change a password');
      const u = userOr404(c, principal.userId);
      const check = await d.auth.checkPassword(u.username, body.currentPassword, c.req.socket.remoteAddress);
      if (!check.ok && check.reason === 'throttled') throw new ApiError(429, 'too_many_attempts', `Too many wrong passwords from this address; try again in ${check.retryAfterSec} s`);
      if (!check.ok) throw invalid('currentPassword', 'is not your current password');
      const pw = checkNewPassword(body.newPassword, 'newPassword');
      if (pw === body.currentPassword) throw invalid('newPassword', 'must differ from the current password');
      await d.auth.users.setPassword(u.id, pw);
      signOut(c, u.id, principal.sessionId);
      d.bus.event('info', 'auth', `${u.username} changed their password`);
      usersChanged(c);
      return noContent();
    },
  },
];
