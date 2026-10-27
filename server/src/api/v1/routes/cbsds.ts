import type { Row } from '../../../db.ts';
import { jparse } from '../../../db.ts';
import { cbsdViewFromRow } from '../../../sas/policy.ts';
import { MEAS_CAPABILITIES } from '../../../sas/registration.ts';
import type { Route, V1Deps } from '../http.ts';
import { conflict, noContent, notFound } from '../http.ts';
import { S } from '../schema.ts';
import { cbsdOut, eventOut, grantOut, messageOut } from '../mappers.ts';
import { Where, cursorOf, cursorPage, cursorQuery, inList, like, noContentResp, ok, okRef, pageOf, pageQuery, sqlPage } from './common.ts';

// CBSDs: everything the SAS knows about each registered (or pending) radio, and the operator
// actions the console offers on them.

const cbsdIdParam = { cbsdId: { description: 'cbsdId as returned in the registration response, e.g. "FCCID/0123abcd…". Percent-encode it in the path: the "/" becomes %2F.' } };

export function cbsdRow(d: V1Deps, cbsdId: string): Row {
  const c = d.db.get('SELECT * FROM cbsds WHERE cbsd_id = ?', cbsdId);
  if (!c) throw notFound('CBSD');
  return c;
}

function grantCounts(d: V1Deps, cbsdId?: string): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  const rows = cbsdId
    ? d.db.all('SELECT cbsd_id, state, COUNT(*) AS n FROM grants WHERE cbsd_id = ? GROUP BY state', cbsdId)
    : d.db.all('SELECT cbsd_id, state, COUNT(*) AS n FROM grants GROUP BY cbsd_id, state');
  for (const g of rows) {
    const m = out.get(g.cbsd_id) ?? {};
    m[g.state] = g.n;
    out.set(g.cbsd_id, m);
  }
  return out;
}

/** Spectrum the CBSD could use right now, its EIRP limits and the protections that cover it. */
function availabilityOf(d: V1Deps, c: Row) {
  const view = cbsdViewFromRow(c);
  const p = d.engine.policy;
  return {
    limits: { maxEirpPer10MHz: p.maxEirpPer10MHz(view), maxEirpDbmMhz: p.maxEirpDbmMhz(view) },
    availability: p.availability(view),
    protections: p.protections().filter((x) => p.affects(x, view)).map((x) => ({ id: x.id, name: x.name, kind: x.kind, action: x.action })),
  };
}

export function cbsdDetail(d: V1Deps, cbsdId: string) {
  const c = cbsdRow(d, cbsdId);
  const pre = d.db.get('SELECT data FROM conditional_reg WHERE fcc_id = ? AND serial = ?', c.fcc_id, c.serial);
  const live = d.db.all(`SELECT g.*, c.fcc_id, c.serial, c.category FROM grants g JOIN cbsds c ON c.cbsd_id = g.cbsd_id
    WHERE g.cbsd_id = ? AND g.state IN ('GRANTED','AUTHORIZED') ORDER BY g.low_freq`, cbsdId);
  return {
    ...cbsdOut(c, grantCounts(d, cbsdId).get(cbsdId) ?? {}),
    conditional: jparse(pre?.data, null),
    liveGrants: live.map(grantOut),
    ...availabilityOf(d, c),
  };
}

const measList = S.arr(S.enum(MEAS_CAPABILITIES), { description: `Any of ${MEAS_CAPABILITIES.join(', ')}. Capabilities the CBSD did not declare are filtered out when sent.` });

export const cbsdRoutes: Route[] = [
  {
    method: 'GET', path: '/cbsds', operationId: 'listCbsds', tag: 'CBSDs', scope: 'read',
    summary: 'List CBSDs',
    description: 'Every CBSD the SAS has seen, most recently updated first, with its registration data and a count of grants per state.',
    query: {
      state: { description: 'Only CBSDs in this state.', schema: S.enum(['REGISTERED', 'PENDING', 'UNREGISTERED']) },
      fccId: { description: 'Only this FCC ID.', schema: S.str() },
      serial: { description: 'Only this serial number.', schema: S.str() },
      userId: { description: 'Only this user ID.', schema: S.str() },
      category: { description: 'Only this category.', schema: S.enum(['A', 'B']) },
      q: { description: 'Substring match on cbsdId, FCC ID, serial number, user ID or notes.', schema: S.str({ minLength: 1 }) },
      ...pageQuery(),
    },
    responses: ok('A page of CBSDs.', pageOf('Cbsd')),
    handler: ({ d, query }) => {
      const w = new Where();
      if (query.state) w.add('state = ?', query.state);
      if (query.fccId) w.add('fcc_id = ?', query.fccId);
      if (query.serial) w.add('serial = ?', query.serial);
      if (query.userId) w.add('user_id = ?', query.userId);
      if (query.category) w.add('category = ?', query.category);
      if (query.q) {
        const l = like(query.q);
        w.add("(cbsd_id LIKE ? ESCAPE '\\' OR fcc_id LIKE ? ESCAPE '\\' OR serial LIKE ? ESCAPE '\\' OR user_id LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')", l, l, l, l, l);
      }
      const counts = grantCounts(d);
      return sqlPage(d.db, 'cbsds', w, 'updated_at DESC, cbsd_id', query, (c) => cbsdOut(c, counts.get(c.cbsd_id) ?? {}));
    },
  },
  {
    method: 'GET', path: '/cbsds/{cbsdId}', operationId: 'getCbsd', tag: 'CBSDs', scope: 'read',
    summary: 'Get a CBSD',
    description: 'The CBSD with its live grants, preloaded (conditional) registration data, EIRP limits, the spectrum available to it now and the active protections that cover it.',
    params: cbsdIdParam,
    responses: okRef('The CBSD.', 'CbsdDetail'),
    handler: ({ d, params }) => cbsdDetail(d, params.cbsdId),
  },
  {
    method: 'PATCH', path: '/cbsds/{cbsdId}', operationId: 'updateCbsd', tag: 'CBSDs', scope: 'write',
    summary: 'Change operator overrides',
    description: 'Notes, a per-CBSD EIRP cap, measurement reports to request, and a pending SAS-initiated deregistration. Send only the fields to change.',
    params: cbsdIdParam,
    body: {
      required: true,
      schema: S.obj({
        notes: S.nullable(S.str({ maxLength: 10000, description: 'Free text shown in the console.' })),
        eirpCapDbmMhz: S.nullable(S.num({ minimum: -137, maximum: 37, description: 'Administrative EIRP cap in dBm/MHz: grant requests above it get 400 INTERFERENCE. Null removes the cap.' })),
        regMeasConfig: S.nullable({ ...measList, description: 'measReportConfig to send in the next successful registration response.' }),
        hbMeasConfig: S.nullable({ ...measList, description: 'measReportConfig to send once, in the next successful heartbeat response.' }),
        pendingDeregister: S.bool({ description: 'true: answer the next request from this CBSD with 105 DEREGISTER (CBSD must be REGISTERED). false: cancel that.' }),
      }),
      example: { eirpCapDbmMhz: 20, notes: 'Bench 3, firmware 25R2' },
    },
    responses: okRef('The updated CBSD.', 'CbsdDetail'),
    handler: ({ d, params, body }) => {
      const c = cbsdRow(d, params.cbsdId);
      const id = params.cbsdId;
      if (body.pendingDeregister === true && c.state !== 'REGISTERED') throw conflict(`CBSD is ${c.state}; only a REGISTERED CBSD can be sent 105`);
      d.db.tx(() => {
        if ('notes' in body) d.db.run('UPDATE cbsds SET notes = ? WHERE cbsd_id = ?', body.notes ?? null, id);
        if ('eirpCapDbmMhz' in body) d.db.run('UPDATE cbsds SET eirp_cap_dbm_mhz = ? WHERE cbsd_id = ?', body.eirpCapDbmMhz ?? null, id);
        if ('regMeasConfig' in body) d.db.run('UPDATE cbsds SET reg_meas_config = ? WHERE cbsd_id = ?', JSON.stringify(body.regMeasConfig ?? []), id);
        if ('hbMeasConfig' in body) d.db.run('UPDATE cbsds SET meas_report_config = ? WHERE cbsd_id = ?', body.hbMeasConfig?.length ? JSON.stringify(body.hbMeasConfig) : null, id);
        if ('pendingDeregister' in body) d.db.run('UPDATE cbsds SET pending_deregister = ? WHERE cbsd_id = ?', body.pendingDeregister ? 1 : 0, id);
      });
      const fields = Object.keys(body);
      if (fields.length) d.bus.event('info', 'admin', `CBSD ${id} updated (${fields.join(', ')})`, id);
      d.bus.changed('cbsds');
      return cbsdDetail(d, id);
    },
  },
  {
    method: 'DELETE', path: '/cbsds/{cbsdId}', operationId: 'deleteCbsd', tag: 'CBSDs', scope: 'write',
    summary: 'Delete a CBSD and its grants',
    description: 'Removes the record entirely. The radio is not told; its next request gets 103 (unknown cbsdId) and it must register again.',
    params: cbsdIdParam,
    responses: noContentResp('Deleted.'),
    handler: ({ d, params }) => {
      cbsdRow(d, params.cbsdId);
      d.db.tx(() => {
        d.db.run('DELETE FROM grants WHERE cbsd_id = ?', params.cbsdId);
        d.db.run('DELETE FROM cbsds WHERE cbsd_id = ?', params.cbsdId);
      });
      d.bus.event('warn', 'admin', `CBSD ${params.cbsdId} and its grants deleted`, params.cbsdId);
      d.bus.changed('cbsds');
      return noContent();
    },
  },
  {
    method: 'POST', path: '/cbsds/{cbsdId}/approve', operationId: 'approveCbsd', tag: 'CBSDs', scope: 'write',
    summary: 'Approve a pending registration',
    description: 'For manual approval (setting manualApproval). The registration completes on the CBSD\'s next registration request.',
    params: cbsdIdParam,
    responses: okRef('The CBSD.', 'CbsdDetail'),
    handler: ({ d, params }) => {
      cbsdRow(d, params.cbsdId);
      d.db.run('UPDATE cbsds SET approved = 1 WHERE cbsd_id = ?', params.cbsdId);
      d.bus.event('success', 'admin', `Registration of ${params.cbsdId} approved (completes on the CBSD's next registration request)`, params.cbsdId);
      d.bus.changed('cbsds');
      return cbsdDetail(d, params.cbsdId);
    },
  },
  {
    method: 'POST', path: '/cbsds/{cbsdId}/deregister', operationId: 'deregisterCbsd', tag: 'CBSDs', scope: 'write',
    summary: 'Deregister a CBSD',
    description: '`next-request` (default): the CBSD\'s next request is answered with 105 DEREGISTER, which removes its grants and tells it to register again. `immediate`: the SAS deregisters it now without telling it; its grants are removed and later requests get 103.',
    params: cbsdIdParam,
    body: { schema: S.obj({ mode: S.enum(['next-request', 'immediate'], { default: 'next-request' }) }), example: { mode: 'next-request' } },
    responses: okRef('The CBSD.', 'CbsdDetail'),
    handler: ({ d, params, body }) => {
      const c = cbsdRow(d, params.cbsdId);
      if ((body.mode ?? 'next-request') === 'next-request') {
        if (c.state !== 'REGISTERED') throw conflict(`CBSD is ${c.state}; only a REGISTERED CBSD can be sent 105`);
        d.db.run('UPDATE cbsds SET pending_deregister = 1 WHERE cbsd_id = ?', params.cbsdId);
        d.bus.event('warn', 'admin', `CBSD ${params.cbsdId} will receive DEREGISTER (105) on its next request`, params.cbsdId);
      } else {
        d.engine.deregister(params.cbsdId, 'deregistered by administrator');
        d.bus.event('warn', 'admin', `CBSD ${params.cbsdId} deregistered by administrator`, params.cbsdId);
      }
      d.bus.changed('cbsds');
      return cbsdDetail(d, params.cbsdId);
    },
  },
  {
    method: 'GET', path: '/cbsds/{cbsdId}/grants', operationId: 'listCbsdGrants', tag: 'CBSDs', scope: 'read',
    summary: 'List a CBSD\'s grants',
    description: 'Newest first, including ended grants.',
    params: cbsdIdParam,
    query: {
      state: { description: 'Comma-separated grant states.', schema: S.arr(S.enum(['GRANTED', 'AUTHORIZED', 'TERMINATED', 'RELINQUISHED', 'EXPIRED', 'DELETED'])) },
      ...pageQuery(),
    },
    responses: ok('A page of grants.', pageOf('Grant')),
    handler: ({ d, params, query }) => {
      cbsdRow(d, params.cbsdId);
      const w = new Where().add('g.cbsd_id = ?', params.cbsdId);
      if (query.state?.length) w.add(`g.state IN (${query.state.map(() => '?').join(',')})`, ...query.state);
      return sqlPage(d.db, 'grants g LEFT JOIN cbsds c ON c.cbsd_id = g.cbsd_id', w, 'g.created_at DESC, g.grant_id', query, grantOut,
        'g.*, c.fcc_id, c.serial, c.category');
    },
  },
  {
    method: 'GET', path: '/cbsds/{cbsdId}/events', operationId: 'listCbsdEvents', tag: 'CBSDs', scope: 'read',
    summary: 'List a CBSD\'s events',
    params: cbsdIdParam,
    query: cursorQuery(),
    responses: ok('A page of events.', cursorOf('Event')),
    handler: ({ d, params, query }) => {
      cbsdRow(d, params.cbsdId);
      return cursorPage(d.db, 'events', new Where().add('cbsd_id = ?', params.cbsdId), query, eventOut);
    },
  },
  {
    method: 'GET', path: '/cbsds/{cbsdId}/messages', operationId: 'listCbsdMessages', tag: 'CBSDs', scope: 'read',
    summary: 'List a CBSD\'s wire-log messages',
    description: 'Exchanges that mention this cbsdId in the request or response. Use GET /messages/{id} for the full JSON.',
    params: cbsdIdParam,
    query: cursorQuery(),
    responses: ok('A page of messages.', cursorOf('Message')),
    handler: ({ d, params, query }) => {
      cbsdRow(d, params.cbsdId);
      const w = new Where();
      inList(w, 'cbsd_ids', params.cbsdId);
      return cursorPage(d.db, 'msg_log', w, query, messageOut,
        'id, ts, transport, remote_addr, path, method, version, http_status, duration_ms, cbsd_ids, codes, cert_subject, error');
    },
  },
  {
    method: 'GET', path: '/cbsds/{cbsdId}/availability', operationId: 'getCbsdAvailability', tag: 'CBSDs', scope: 'read',
    summary: 'Spectrum available to a CBSD',
    description: 'Computed now from the GAA band plan, PPAs and active protections: available segments with channel type and maximum EIRP, the EIRP limits, and the protections that cover the CBSD.',
    params: cbsdIdParam,
    responses: okRef('Availability.', 'CbsdAvailability'),
    handler: ({ d, params }) => availabilityOf(d, cbsdRow(d, params.cbsdId)),
  },
];

