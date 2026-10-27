import { SAS_METHODS } from '../../../sas/engine.ts';
import { faultVals } from '../../../api.ts';
import type { Route, V1Deps } from '../http.ts';
import { created, invalid, noContent, notFound } from '../http.ts';
import { S, ref, type Schema } from '../schema.ts';
import { faultIn, faultOut } from '../mappers.ts';
import { Where, noContentResp, ok, okRef, pageOf, pageQuery, sqlPage } from './common.ts';

// Fault injection rules. Rules only change what goes out on the wire from the SAS listener; SAS state
// is untouched. Requests sent with POST /sas/{method}?transport=internal bypass them.

export const FAULT_ACTIONS = ['response_code', 'patch', 'http_status', 'delay', 'drop', 'malformed'];

const faultProps = (forPatch: boolean): Record<string, Schema> => ({
  enabled: S.bool({ ...(forPatch ? {} : { default: true }), description: 'Disabled rules are kept but never applied.' }),
  name: S.nullable(S.str({ maxLength: 200 })),
  method: S.enum(['*', ...SAS_METHODS], { ...(forPatch ? {} : { default: '*' }), description: 'SAS method the rule applies to; * for all.' }),
  matchCbsd: S.nullable(S.str({ maxLength: 300, description: 'Only requests whose cbsdId, fccId, serial number or grantId contains this text. Null: every request.' })),
  action: S.enum(FAULT_ACTIONS, {
    description: [
      '`response_code`: replace each matching response object\'s responseCode (success-only fields are removed for a non-zero code). Needs `responseCode`; `responseMessage` and `responseData` are optional.',
      '`patch`: JSON-merge-patch `responseData` (an object) into each matching response object.',
      '`http_status`: answer the whole request with this HTTP status (`httpStatus`) and `responseData` as the body.',
      '`delay`: wait `delayMs` before answering.',
      '`drop`: close the connection without answering.',
      '`malformed`: answer with truncated JSON.',
    ].join(' '),
  }),
  responseCode: S.nullable(S.int({ minimum: 0, maximum: 1000, description: 'With action response_code.' })),
  responseData: S.any({ description: 'response_code: responseData; patch: the merge patch (object); http_status: the response body.' }),
  responseMessage: S.nullable(S.str({ maxLength: 1000, description: 'With action response_code.' })),
  httpStatus: S.nullable(S.int({ minimum: 100, maximum: 599, description: 'With action http_status.' })),
  delayMs: S.nullable(S.int({ minimum: 0, maximum: 600000, description: 'With action delay.' })),
  remaining: S.nullable(S.int({ minimum: 0, description: 'Apply this many more times, then stop. Null: no limit.' })),
});

const faultBody = S.obj(faultProps(false), ['action']);
const faultPatch = S.obj(faultProps(true));
const faultExample = { name: 'Heartbeat 501 once', method: 'heartbeat', action: 'response_code', responseCode: 501, remaining: 1 };
const idParam = { id: { description: 'Rule id.', schema: S.int({ minimum: 1 }) } };

function checkAction(b: Record<string, any>) {
  if (b.action === 'response_code' && b.responseCode == null) throw invalid('responseCode', 'is required with action response_code');
  if (b.action === 'patch' && (!b.responseData || typeof b.responseData !== 'object' || Array.isArray(b.responseData))) {
    throw invalid('responseData', 'must be an object (the merge patch) with action patch');
  }
  if (b.action === 'http_status' && b.httpStatus == null) throw invalid('httpStatus', 'is required with action http_status');
  if (b.action === 'delay' && b.delayMs == null) throw invalid('delayMs', 'is required with action delay');
}

function rule(d: V1Deps, id: number) {
  const r = d.db.get('SELECT * FROM fault_rules WHERE id = ?', id);
  if (!r) throw notFound('Fault rule');
  return faultOut(r);
}

function save(d: V1Deps, id: number, b: Record<string, any>) {
  checkAction(b);
  d.db.run(`UPDATE fault_rules SET enabled = ?, name = ?, method = ?, match_cbsd = ?, action = ?, response_code = ?, response_data = ?,
    response_message = ?, http_status = ?, delay_ms = ?, remaining = ? WHERE id = ?`, ...faultVals(faultIn(b)), id);
  d.bus.changed('faults');
  return rule(d, id);
}

export const faultRoutes: Route[] = [
  {
    method: 'GET', path: '/faults', operationId: 'listFaults', tag: 'Faults', scope: 'read',
    summary: 'List fault rules', description: 'In the order they are evaluated (by id).',
    query: {
      enabled: { description: 'Only enabled (or disabled) rules.', schema: S.bool() },
      method: { description: 'Only rules for this method (rules for * are included).', schema: S.enum(SAS_METHODS) },
      ...pageQuery(),
    },
    responses: ok('A page of rules.', pageOf('FaultRule')),
    handler: ({ d, query }) => {
      const w = new Where();
      if (query.enabled !== undefined) w.add('enabled = ?', query.enabled ? 1 : 0);
      if (query.method) w.add("(method = '*' OR method = ?)", query.method);
      return sqlPage(d.db, 'fault_rules', w, 'id', query, faultOut);
    },
  },
  {
    method: 'POST', path: '/faults', operationId: 'createFault', tag: 'Faults', scope: 'write',
    summary: 'Create a fault rule',
    description: 'Rules apply to requests that reach the SAS HTTP/HTTPS listener, in id order. Whole-exchange rules (http_status, drop, malformed) stop at the first match; delays add up.',
    body: { required: true, schema: faultBody, example: faultExample },
    responses: { 201: { description: 'Created.', schema: ref('FaultRule') } },
    handler: ({ d, body }) => {
      checkAction(body);
      const info = d.db.run(`INSERT INTO fault_rules(enabled, name, method, match_cbsd, action, response_code, response_data, response_message,
        http_status, delay_ms, remaining, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, ...faultVals(faultIn(body)), Date.now());
      const id = Number(info.lastInsertRowid);
      d.bus.event('warn', 'fault', `Fault rule "${body.name || body.action}" created`);
      d.bus.changed('faults');
      return created(rule(d, id), `/faults/${id}`);
    },
  },
  {
    method: 'DELETE', path: '/faults', operationId: 'deleteAllFaults', tag: 'Faults', scope: 'write',
    summary: 'Delete every fault rule',
    responses: ok('How many were deleted.', S.obj({ deleted: S.int() }, ['deleted'])),
    handler: ({ d }) => {
      const n = d.db.run('DELETE FROM fault_rules').changes;
      d.bus.event('info', 'fault', 'All fault rules deleted');
      d.bus.changed('faults');
      return { deleted: Number(n) };
    },
  },
  {
    method: 'GET', path: '/faults/{id}', operationId: 'getFault', tag: 'Faults', scope: 'read',
    summary: 'Get a fault rule', description: '`hits` counts how many times the rule has been applied.',
    params: idParam,
    responses: okRef('The rule.', 'FaultRule'),
    handler: ({ d, params }) => rule(d, Number(params.id)),
  },
  {
    method: 'PUT', path: '/faults/{id}', operationId: 'replaceFault', tag: 'Faults', scope: 'write',
    summary: 'Replace a fault rule', description: 'Fields left out take their defaults. The hit counter is kept.',
    params: idParam,
    body: { required: true, schema: faultBody, example: faultExample },
    responses: okRef('The rule.', 'FaultRule'),
    handler: ({ d, params, body }) => {
      rule(d, Number(params.id));
      return save(d, Number(params.id), body);
    },
  },
  {
    method: 'PATCH', path: '/faults/{id}', operationId: 'updateFault', tag: 'Faults', scope: 'write',
    summary: 'Change a fault rule', description: 'Only the fields given change, e.g. `{"enabled": false}`.',
    params: idParam,
    body: { required: true, schema: faultPatch, example: { enabled: false } },
    responses: okRef('The rule.', 'FaultRule'),
    handler: ({ d, params, body }) => {
      const cur = rule(d, Number(params.id));
      return save(d, Number(params.id), { ...cur, ...body });
    },
  },
  {
    method: 'DELETE', path: '/faults/{id}', operationId: 'deleteFault', tag: 'Faults', scope: 'write',
    summary: 'Delete a fault rule', params: idParam,
    responses: noContentResp('Deleted.'),
    handler: ({ d, params }) => {
      if (!d.db.run('DELETE FROM fault_rules WHERE id = ?', Number(params.id)).changes) throw notFound('Fault rule');
      d.bus.changed('faults');
      return noContent();
    },
  },
];
