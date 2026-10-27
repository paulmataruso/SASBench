import type { Row } from '../../../db.ts';
import { jparse } from '../../../db.ts';
import { LIVE_STATES } from '../../../sas/engine.ts';
import type { Route, V1Deps } from '../http.ts';
import { conflict, notFound } from '../http.ts';
import { S, toMs } from '../schema.ts';
import { grantOut } from '../mappers.ts';
import { Where, ok, okRef, pageOf, pageQuery, sqlPage } from './common.ts';

// Grants: query, inspect and the SAS-side actions (suspend, resume, terminate, change heartbeat
// interval, expiry and suggested parameters). Actions take effect at the CBSD's next heartbeat.

export const GRANT_STATES = ['GRANTED', 'AUTHORIZED', 'TERMINATED', 'RELINQUISHED', 'EXPIRED', 'DELETED'];

const grantIdParam = { grantId: { description: 'grantId as returned in the grant response.' } };

const JOIN = 'grants g LEFT JOIN cbsds c ON c.cbsd_id = g.cbsd_id';
const COLS = 'g.*, c.fcc_id, c.serial, c.category';

function grantRow(d: V1Deps, grantId: string): Row {
  const g = d.db.get(`SELECT ${COLS} FROM ${JOIN} WHERE g.grant_id = ?`, grantId);
  if (!g) throw notFound('Grant');
  return g;
}

function liveGrant(d: V1Deps, grantId: string): Row {
  const g = grantRow(d, grantId);
  if (!LIVE_STATES.includes(g.state)) throw conflict(`Grant is ${g.state}; only GRANTED or AUTHORIZED grants can be changed`);
  return g;
}

const detail = (d: V1Deps, grantId: string) => {
  const g = grantRow(d, grantId);
  return { ...grantOut(g), request: jparse(g.request, null) };
};

export const grantRoutes: Route[] = [
  {
    method: 'GET', path: '/grants', operationId: 'listGrants', tag: 'Grants', scope: 'read',
    summary: 'List grants',
    description: 'Newest first, with the owning CBSD\'s FCC ID, serial number and category. Ended grants stay in the list (state TERMINATED, RELINQUISHED, EXPIRED or DELETED) until purged.',
    query: {
      state: { description: 'Comma-separated grant states, e.g. GRANTED,AUTHORIZED.', schema: S.arr(S.enum(GRANT_STATES)) },
      cbsdId: { description: 'Only grants of this CBSD.', schema: S.str() },
      channelType: { description: 'Only GAA or PAL grants.', schema: S.enum(['GAA', 'PAL']) },
      suspended: { description: 'Only grants the administrator has (or has not) suspended.', schema: S.bool() },
      ...pageQuery(),
    },
    responses: ok('A page of grants.', pageOf('Grant')),
    handler: ({ d, query }) => {
      const w = new Where();
      if (query.state?.length) w.add(`g.state IN (${query.state.map(() => '?').join(',')})`, ...query.state);
      if (query.cbsdId) w.add('g.cbsd_id = ?', query.cbsdId);
      if (query.channelType) w.add('g.channel_type = ?', query.channelType);
      if (query.suspended !== undefined) w.add('g.suspended = ?', query.suspended ? 1 : 0);
      return sqlPage(d.db, JOIN, w, 'g.created_at DESC, g.grant_id', query, grantOut, COLS);
    },
  },
  {
    method: 'DELETE', path: '/grants/ended', operationId: 'purgeEndedGrants', tag: 'Grants', scope: 'write',
    summary: 'Delete ended grants',
    description: 'Removes every TERMINATED, RELINQUISHED, EXPIRED and DELETED grant record. Live grants are untouched.',
    responses: ok('How many were deleted.', S.obj({ deleted: S.int() }, ['deleted'])),
    handler: ({ d }) => {
      const n = d.db.run("DELETE FROM grants WHERE state IN ('TERMINATED','RELINQUISHED','EXPIRED','DELETED')").changes;
      d.bus.changed('grants');
      return { deleted: Number(n) };
    },
  },
  {
    method: 'GET', path: '/grants/{grantId}', operationId: 'getGrant', tag: 'Grants', scope: 'read',
    summary: 'Get a grant',
    description: 'The grant and the grant request the CBSD sent.',
    params: grantIdParam,
    responses: okRef('The grant.', 'GrantDetail'),
    handler: ({ d, params }) => detail(d, params.grantId),
  },
  {
    method: 'PATCH', path: '/grants/{grantId}', operationId: 'updateGrant', tag: 'Grants', scope: 'write',
    summary: 'Change a grant',
    description: '`heartbeatInterval` is sent with the next successful heartbeat response and then applies. `suggestedOperationParam` is returned in every successful heartbeat response while set. `grantExpireTime` moves the expiry immediately.',
    params: grantIdParam,
    body: {
      required: true,
      schema: S.obj({
        heartbeatInterval: S.nullable(S.int({ minimum: 1, description: 'Seconds. Null cancels a pending change.' })),
        suggestedOperationParam: S.nullable(S.obj({
          maxEirp: S.num({ description: 'dBm/MHz' }),
          operationFrequencyRange: S.obj({ lowFrequency: S.hz(), highFrequency: S.hz() }, ['lowFrequency', 'highFrequency']),
        }, [], { description: 'operationParam to suggest. Null removes it.' })),
        grantExpireTime: S.time({ description: 'New expiry (epoch milliseconds or RFC 3339).' }),
      }),
      example: { heartbeatInterval: 30 },
    },
    responses: okRef('The updated grant.', 'GrantDetail'),
    handler: ({ d, params, body }) => {
      const g = grantRow(d, params.grantId);
      const id = params.grantId;
      d.db.tx(() => {
        if ('heartbeatInterval' in body) d.db.run('UPDATE grants SET pending_hb_interval = ? WHERE grant_id = ?', body.heartbeatInterval ?? null, id);
        if ('suggestedOperationParam' in body) {
          d.db.run('UPDATE grants SET suggested_op_param = ? WHERE grant_id = ?', body.suggestedOperationParam ? JSON.stringify(body.suggestedOperationParam) : null, id);
        }
        if ('grantExpireTime' in body) d.db.run('UPDATE grants SET grant_expire_time = ? WHERE grant_id = ?', Math.floor(toMs(body.grantExpireTime) / 1000) * 1000, id);
      });
      d.bus.event('info', 'admin', `Grant ${id} updated (${Object.keys(body).join(', ')})`, g.cbsd_id, id);
      d.bus.changed('grants');
      return detail(d, id);
    },
  },
  {
    method: 'POST', path: '/grants/{grantId}/suspend', operationId: 'suspendGrant', tag: 'Grants', scope: 'write',
    summary: 'Suspend a grant',
    description: 'The CBSD\'s next heartbeat is answered with 501 SUSPENDED_GRANT, and every heartbeat after it until the grant is resumed.',
    params: grantIdParam,
    responses: okRef('The grant.', 'GrantDetail'),
    handler: ({ d, params }) => {
      liveGrant(d, params.grantId);
      d.engine.adminSuspend(params.grantId, true);
      return detail(d, params.grantId);
    },
  },
  {
    method: 'POST', path: '/grants/{grantId}/resume', operationId: 'resumeGrant', tag: 'Grants', scope: 'write',
    summary: 'Resume a suspended grant',
    description: 'The next heartbeat is authorized again (unless a protection still blocks the spectrum).',
    params: grantIdParam,
    responses: okRef('The grant.', 'GrantDetail'),
    handler: ({ d, params }) => {
      liveGrant(d, params.grantId);
      d.engine.adminSuspend(params.grantId, false);
      return detail(d, params.grantId);
    },
  },
  {
    method: 'POST', path: '/grants/{grantId}/terminate', operationId: 'terminateGrant', tag: 'Grants', scope: 'write',
    summary: 'Terminate a grant',
    description: 'The grant ends now; the CBSD\'s next heartbeat for it is answered with 500 TERMINATED_GRANT.',
    params: grantIdParam,
    body: { schema: S.obj({ reason: S.str({ maxLength: 500, description: 'Recorded as the end reason and sent as responseMessage.' }) }), example: { reason: 'interference test' } },
    responses: okRef('The grant.', 'GrantDetail'),
    handler: ({ d, params, body }) => {
      liveGrant(d, params.grantId);
      d.engine.adminTerminate(params.grantId, body.reason || 'terminated by administrator');
      return detail(d, params.grantId);
    },
  },
];
