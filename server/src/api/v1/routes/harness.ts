import { NotFound } from '../../../sas/admin.ts';
import type { Route } from '../http.ts';
import { ApiError, sendFile } from '../http.ts';
import { S } from '../schema.ts';
import { fileResp, ok } from './common.ts';

// The WInnForum test harness admin API (WINNF-TS-0096 sas_interface "admin" calls), callable from
// the REST API with the same bodies the harness sends to <SAS>/admin/<method>.

export const HARNESS_METHODS: Array<{ method: string; description: string }> = [
  { method: 'reset', description: 'Reset the SAS state (like POST /operations/reset without clearing logs).' },
  { method: 'injectdata/fcc_id', description: '{"fccId", "fccMaxEirp"}: add an FCC ID.' },
  { method: 'injectdata/user_id', description: '{"userId"}: add a user ID.' },
  { method: 'injectdata/blacklist_fcc_id', description: '{"fccId"}: blacklist an FCC ID.' },
  { method: 'injectdata/blacklist_fcc_id_and_serial_number', description: '{"fccId", "serialNumber"}: blacklist one device.' },
  { method: 'injectdata/conditional_registration', description: '{"registrationData": [ … ]}: pre-load installation parameters.' },
  { method: 'injectdata/cpi_user', description: '{"cpiId", "cpiName", "cpiPublicKey"}: add a CPI.' },
  { method: 'injectdata/exclusion_zone', description: '{"zone", "frequencyRanges"}: add an exclusion zone; returns its id.' },
  { method: 'injectdata/zone', description: '{"record"}: add a zone (PPA); returns its id.' },
  { method: 'injectdata/pal_database_record', description: 'A PAL database record.' },
  { method: 'injectdata/fss', description: '{"record", "ttc"}: add an FSS earth station.' },
  { method: 'injectdata/wisp', description: '{"record", "zone"}: add a WISP (GWPZ with a zone, GWBL without).' },
  { method: 'injectdata/sas_admin', description: '{"record"}: add a SAS administrator.' },
  { method: 'injectdata/esc_sensor', description: '{"record"}: add an ESC sensor.' },
  { method: 'injectdata/peer_sas', description: '{"url", "certificateHash"}: add a peer SAS (pulled during daily activities).' },
  { method: 'injectdata/database_url', description: '{"type", "url"}: record a database URL.' },
  { method: 'injectdata/esc_zone', description: 'Recorded only.' },
  { method: 'injectdata/cluster_list', description: 'Recorded only.' },
  { method: 'injectdata/sas_impl', description: 'Recorded only.' },
  { method: 'trigger/meas_report_in_registration_response', description: 'Request RECEIVED_POWER_WITHOUT_GRANT measurement reports in registration responses.' },
  { method: 'trigger/meas_report_in_heartbeat_response', description: 'Request RECEIVED_POWER_WITH_GRANT measurement reports in heartbeat responses.' },
  { method: 'trigger/create_ppa', description: '{"cbsdIds", "palIds", "providedContour"?}: create a PPA; returns its id.' },
  { method: 'get_ppa_status', description: 'Status of the last PPA creation.' },
  { method: 'trigger/daily_activities_immediately', description: 'Run daily activities and wait for them to finish.' },
  { method: 'get_daily_activities_status', description: '{"completed"}.' },
  { method: 'trigger/enable_scheduled_daily_activities', description: 'Run daily activities every 24 hours.' },
  { method: 'trigger/enable_ntia_15_517', description: 'Set the ntiaExclusionZones flag.' },
  { method: 'trigger/load_dpas', description: 'Load the E-DPAs and activate them on all channels.' },
  { method: 'trigger/bulk_dpa_activation', description: '{"activate"}: activate or deactivate every DPA.' },
  { method: 'trigger/dpa_activation', description: '{"dpaId", "frequencyRange"}: activate a DPA on one channel.' },
  { method: 'trigger/dpa_deactivation', description: '{"dpaId", "frequencyRange"}: deactivate a DPA on one channel.' },
  { method: 'trigger/disconnect_esc', description: 'Clear the escConnected flag.' },
  { method: 'trigger/esc_detection', description: 'Accepted; no effect.' },
  { method: 'trigger/esc_reset', description: 'Accepted; no effect.' },
  { method: 'trigger/create_full_activity_dump', description: 'Accepted; no effect.' },
  { method: 'query/propagation_and_antenna_model', description: 'Not implemented: always fails.' },
];

export const harnessRoutes: Route[] = [
  {
    method: 'GET', path: '/harness/methods', operationId: 'listHarnessMethods', tag: 'Harness', scope: 'read',
    summary: 'List harness admin methods',
    description: 'Every admin call of the WInnForum test harness that POST /harness/{method} accepts, and whether the SAS listeners currently accept them at <base>/admin/<method> (setting harnessAdminEnabled).',
    responses: ok('Methods.', S.obj({
      listenerAdminEnabled: S.bool(), methods: S.arr(S.obj({ method: S.str(), description: S.str() }, ['method', 'description'])),
    }, ['listenerAdminEnabled', 'methods'])),
    handler: ({ d }) => ({ listenerAdminEnabled: d.settings.get().harnessAdminEnabled, methods: HARNESS_METHODS }),
  },
  {
    method: 'POST', path: '/harness/{method+}', operationId: 'callHarnessMethod', tag: 'Harness', scope: 'write',
    summary: 'Call a harness admin method',
    description: 'Runs the call exactly as the SAS does for the harness (e.g. `POST /api/v1/harness/injectdata/fcc_id` with `{"fccId": "X", "fccMaxEirp": 47}`), whether or not harnessAdminEnabled is set, and logs it in the wire log as `admin/<method>`. `result` is what the harness would receive (null when the call returns nothing).',
    params: { method: { description: 'Admin method, e.g. injectdata/fcc_id or trigger/load_dpas (slashes are not encoded).', schema: S.str({ pattern: '^[a-z0-9_]+(/[a-z0-9_]+)?$' }) } },
    body: { schema: S.any({ description: 'The harness request body; omit for calls that take none.' }), example: { fccId: 'TEST-FCC', fccMaxEirp: 47 } },
    responses: ok('Result.', S.obj({ method: S.str(), result: S.any() }, ['method', 'result'])),
    handler: async ({ d, params, body }) => {
      const started = Date.now();
      let result: unknown;
      let error: string | undefined;
      let status = 200;
      try {
        result = await d.admin.harness(params.method, body ?? {});
      } catch (e: any) {
        status = e instanceof NotFound ? 404 : 400;
        error = e.message;
      }
      d.bus.message({
        ts: started, transport: 'internal', remoteAddr: 'api', path: `/api/v1/harness/${params.method}`, method: `admin/${params.method}`,
        httpStatus: status, durationMs: Date.now() - started, request: body, response: error ? { error } : result, error,
      });
      if (error) throw new ApiError(status, status === 404 ? 'not_found' : 'operation_failed', error);
      return { method: params.method, result: result ?? null };
    },
  },
  {
    method: 'GET', path: '/harness/sas.cfg', operationId: 'getHarnessConfig', tag: 'Harness', scope: 'read',
    summary: 'Harness sas.cfg',
    description: 'A `[SasConfig]` section for the harness pointing at this SAS\'s HTTPS listener.',
    query: { host: { description: 'Host name or address the harness uses to reach the SAS (default: the first configured host name).', schema: S.str({ pattern: '^[A-Za-z0-9.:\\[\\]-]+$' }) } },
    responses: fileResp('sas.cfg', 'text/plain'),
    handler: (c) => {
      const host = c.query.host || c.d.hostnames[0] || 'localhost';
      const s = c.d.settings.get();
      const hp = `${host}:${s.sasHttpsPort}`;
      const cfg = `[SasConfig]
AdminApiBaseUrl: ${hp}
CbsdSasRsaBaseUrl: ${hp}
CbsdSasEcBaseUrl: ${hp}
SasSasRsaBaseUrl: ${hp}
SasSasEcBaseUrl: ${hp}
CbsdSasVersion: ${s.supportedVersions[0] ?? 'v1.2'}
SasSasVersion: v1.3
AdminId: sas_admin_id
MaximumBatchSize: 100
`;
      return sendFile(c, cfg, 'text/plain; charset=utf-8', 'sas.cfg');
    },
  },
];
