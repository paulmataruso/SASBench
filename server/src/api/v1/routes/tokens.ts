import type { Route } from '../http.ts';
import { badRequest, created, invalid, noContent, notFound } from '../http.ts';
import { S, ref, toMs } from '../schema.ts';
import { createdRef, noContentResp, ok, okRef } from './common.ts';

// API tokens: create (the secret is shown once), list, inspect, revoke.

const tokenId = { tokenId: { description: 'Token id (from the token list; not the secret).' } };

export const tokenRoutes: Route[] = [
  {
    method: 'GET', path: '/tokens', operationId: 'listTokens', tag: 'Tokens', scope: 'write',
    summary: 'List API tokens',
    description: 'Every token with its name, scope, prefix, expiry and last use. Secrets are never returned after creation.',
    responses: ok('All tokens.', S.obj({ items: S.arr(ref('Token')) }, ['items'])),
    handler: ({ d }) => ({ items: d.tokens.list() }),
  },
  {
    method: 'POST', path: '/tokens', operationId: 'createToken', tag: 'Tokens', scope: 'write',
    summary: 'Create an API token',
    description: 'Returns the secret in `token`. Store it now: only its SHA-256 hash is kept. `read` tokens may call the read-only endpoints of /api/v1 (GET, except those that reveal private keys); `write` tokens may call everything, including the console\'s private API.',
    body: {
      required: true,
      schema: S.obj({
        name: S.str({ minLength: 1, maxLength: 100, description: 'What the token is for, e.g. "CI pipeline".' }),
        scope: S.enum(['read', 'write'], { default: 'read', description: 'Access level. Defaults to read.' }),
        expiresInDays: S.int({ minimum: 1, maximum: 3650, description: 'Lifetime in days. Omit for a token that does not expire.' }),
        expiresAt: S.time({ description: 'Absolute expiry instead of expiresInDays.' }),
      }, ['name']),
      example: { name: 'CI pipeline', scope: 'write', expiresInDays: 90 },
    },
    responses: createdRef('The new token, including its secret.', 'TokenCreated'),
    handler: ({ d, body }) => {
      if (body.expiresInDays !== undefined && body.expiresAt !== undefined) throw badRequest('Give expiresInDays or expiresAt, not both');
      const expiresAt = body.expiresInDays !== undefined ? Date.now() + body.expiresInDays * 86400e3
        : body.expiresAt !== undefined ? toMs(body.expiresAt) : null;
      if (expiresAt !== null && expiresAt <= Date.now()) throw invalid('expiresAt', 'must be in the future');
      const { token, record } = d.tokens.create({ name: body.name, scope: body.scope ?? 'read', expiresAt });
      d.bus.event('info', 'api', `API token "${record.name}" (${record.scope}) created`);
      return created({ ...record, token }, `/tokens/${record.id}`);
    },
  },
  {
    method: 'GET', path: '/tokens/{tokenId}', operationId: 'getToken', tag: 'Tokens', scope: 'write',
    summary: 'Get an API token',
    params: tokenId,
    responses: okRef('The token (without its secret).', 'Token'),
    handler: ({ d, params }) => {
      const t = d.tokens.get(params.tokenId);
      if (!t) throw notFound('API token');
      return t;
    },
  },
  {
    method: 'DELETE', path: '/tokens/{tokenId}', operationId: 'deleteToken', tag: 'Tokens', scope: 'write',
    summary: 'Revoke an API token',
    description: 'The token stops working immediately.',
    params: tokenId,
    responses: noContentResp('Revoked.'),
    handler: ({ d, params }) => {
      const t = d.tokens.get(params.tokenId);
      if (!t || !d.tokens.delete(params.tokenId)) throw notFound('API token');
      d.bus.event('info', 'api', `API token "${t.name}" revoked`);
      d.bus.emit('api-token-revoked', t.id); // ends its open streams
      return noContent();
    },
  },
];
