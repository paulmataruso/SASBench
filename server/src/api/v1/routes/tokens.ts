import type { Ctx, Route } from '../http.ts';
import { badRequest, created, forbidden, invalid, noContent, notFound } from '../http.ts';
import { S, ref, toMs } from '../schema.ts';
import { createdRef, noContentResp, ok, okRef } from './common.ts';
import { scopeOf, type TokenRecord } from '../auth.ts';

// API keys: create (the secret is shown once), list, inspect, revoke. Every key belongs to a user
// and acts as that user with at most its own scope. Users see and manage their own keys; admins
// see and revoke everyone's.

const tokenId = { tokenId: { description: 'Key id (from the key list; not the secret).' } };

/** Admins with write access see every key; everyone else their own. */
const seesAll = (c: Ctx) => c.principal.method === 'open' || (c.principal.role === 'admin' && c.principal.scope === 'write');

function visible(c: Ctx, id: string): TokenRecord {
  const t = c.d.tokens.get(id);
  if (!t || (!seesAll(c) && t.userId !== c.principal.userId)) throw notFound('API key');
  return t;
}

/** Keys are managed by people (console session or user name and password), not by other keys. */
function requirePerson(c: Ctx, what: string) {
  if (c.principal.method === 'token') throw forbidden(`${what} needs a signed-in user (session or user name and password), not an API key`);
}

export const tokenRoutes: Route[] = [
  {
    method: 'GET', path: '/tokens', operationId: 'listTokens', tag: 'Tokens', scope: 'read',
    summary: 'List API keys',
    description: 'Your keys; admins see every key. Each with its owner, name, scope, prefix, expiry and last use. Secrets are never returned after creation.',
    responses: ok('Keys.', S.obj({ items: S.arr(ref('Token')) }, ['items'])),
    handler: (c) => ({ items: seesAll(c) ? c.d.tokens.list() : c.d.tokens.list(c.principal.userId ?? -1) }),
  },
  {
    method: 'POST', path: '/tokens', operationId: 'createToken', tag: 'Tokens', scope: 'read',
    summary: 'Create an API key',
    description: 'Returns the secret in `token`. Store it now: only its SHA-256 hash is kept. The key acts as its owner (you, or `userId` for admins) with at most the owner\'s access: `read` keys may call the read-only operations (GET, except those that reveal private keys); `write` keys everything the owner may do. Viewers can create read keys only. Needs a signed-in user, not another API key.',
    body: {
      required: true,
      schema: S.obj({
        name: S.str({ minLength: 1, maxLength: 100, description: 'What the key is for, e.g. "CI pipeline".' }),
        scope: S.enum(['read', 'write'], { default: 'read', description: 'Access level. Defaults to read.' }),
        expiresInDays: S.int({ minimum: 1, maximum: 3650, description: 'Lifetime in days. Omit for a key that does not expire.' }),
        expiresAt: S.time({ description: 'Absolute expiry instead of expiresInDays.' }),
        userId: S.int({ minimum: 1, description: 'Admins: create the key for this user (e.g. a service account). Default: yourself.' }),
      }, ['name']),
      example: { name: 'CI pipeline', scope: 'write', expiresInDays: 90 },
    },
    responses: createdRef('The new key, including its secret.', 'TokenCreated'),
    handler: (c) => {
      const { d, body, principal } = c;
      requirePerson(c, 'Creating an API key');
      if (body.expiresInDays !== undefined && body.expiresAt !== undefined) throw badRequest('Give expiresInDays or expiresAt, not both');
      const expiresAt = body.expiresInDays !== undefined ? Date.now() + body.expiresInDays * 86400e3
        : body.expiresAt !== undefined ? toMs(body.expiresAt) : null;
      if (expiresAt !== null && expiresAt <= Date.now()) throw invalid('expiresAt', 'must be in the future');
      let ownerId = principal.userId ?? null;
      if (body.userId !== undefined && body.userId !== ownerId) {
        if (!seesAll(c)) throw forbidden('Only admins can create API keys for other users');
        if (!d.auth.users.get(body.userId)) throw invalid('userId', 'is not a user');
        ownerId = body.userId;
      }
      const owner = ownerId !== null ? d.auth.users.get(ownerId) : null;
      const scope = body.scope ?? 'read';
      if (scope === 'write' && owner && scopeOf(owner.role) !== 'write') throw forbidden(`${owner.username} is a viewer: only read keys`);
      const { token, record } = d.tokens.create({ name: body.name, scope, expiresAt, userId: ownerId });
      d.bus.event('info', 'api', `API key "${record.name}" (${record.scope}) created${owner ? ` for ${owner.username}` : ''}`);
      d.bus.changed('tokens');
      return created({ ...record, token }, `/tokens/${record.id}`);
    },
  },
  {
    method: 'GET', path: '/tokens/{tokenId}', operationId: 'getToken', tag: 'Tokens', scope: 'read',
    summary: 'Get an API key',
    description: 'Yours, or any key for admins.',
    params: tokenId,
    responses: okRef('The key (without its secret).', 'Token'),
    handler: (c) => visible(c, c.params.tokenId),
  },
  {
    method: 'DELETE', path: '/tokens/{tokenId}', operationId: 'deleteToken', tag: 'Tokens', scope: 'read',
    summary: 'Revoke an API key',
    description: 'Yours, or any key for admins. The key stops working immediately, and its open event streams end.',
    params: tokenId,
    responses: noContentResp('Revoked.'),
    handler: (c) => {
      requirePerson(c, 'Revoking an API key');
      const t = visible(c, c.params.tokenId);
      c.d.tokens.delete(t.id);
      c.d.bus.event('info', 'api', `API key "${t.name}" revoked`);
      c.d.bus.emit('api-token-revoked', t.id); // ends its open streams
      c.d.bus.changed('tokens');
      return noContent();
    },
  },
];
