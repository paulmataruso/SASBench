import type { Route, V1Deps } from '../http.ts';
import { accepted, badRequest } from '../http.ts';
import { S, ref } from '../schema.ts';
import { ok, okRef } from './common.ts';

// SAS-wide operations: daily activities (CPAS), measurement-report triggers, harness flags,
// the state reset, and the SAS listeners.

const triggersOf = (d: V1Deps) => ({ measInRegistration: d.engine.measInRegistration, measInHeartbeat: d.engine.measInHeartbeat });

const stateOf = (d: V1Deps) => ({
  daily: d.admin.daily, ppaStatus: d.admin.ppaStatus, flags: d.admin.flags, measurementTriggers: triggersOf(d),
});

export const operationRoutes: Route[] = [
  {
    method: 'GET', path: '/operations/state', operationId: 'getOperationsState', tag: 'Operations', scope: 'read',
    summary: 'Operational state',
    description: 'Daily-activities status, the result of the last PPA creation, the harness flags and the measurement-report triggers.',
    responses: okRef('State.', 'OperationsState'),
    handler: ({ d }) => stateOf(d),
  },
  {
    method: 'GET', path: '/operations/daily-activities', operationId: 'getDailyActivities', tag: 'Operations', scope: 'read',
    summary: 'Daily activities status', description: 'With the log of the last run.',
    responses: okRef('Status.', 'DailyActivities'),
    handler: ({ d }) => ({ ...d.admin.daily, scheduled: d.admin.flags.scheduledDailyActivities }),
  },
  {
    method: 'POST', path: '/operations/daily-activities', operationId: 'runDailyActivities', tag: 'Operations', scope: 'write',
    summary: 'Run daily activities now',
    description: 'Pulls full-activity dumps from the peer SASs injected as incumbents of kind peer_sas, rebuilds PPAs and protections and expires PAL channels. With `wait=true` (default) the call returns when the run has finished (200); with `wait=false` it returns at once (202) and the status can be polled. A run already in progress is not restarted.',
    query: { wait: { description: 'Wait for the run to finish.', schema: S.bool({ default: true }) } },
    responses: {
      200: { description: 'Finished.', schema: ref('DailyActivities') },
      202: { description: 'Started.', schema: ref('DailyActivities') },
    },
    handler: async ({ d, query }) => {
      const run = d.admin.triggerDailyActivities();
      if (!query.wait) return accepted({ ...d.admin.daily, scheduled: d.admin.flags.scheduledDailyActivities });
      await run;
      return { ...d.admin.daily, scheduled: d.admin.flags.scheduledDailyActivities };
    },
  },
  {
    method: 'POST', path: '/operations/daily-activities/schedule', operationId: 'scheduleDailyActivities', tag: 'Operations', scope: 'write',
    summary: 'Run daily activities every 24 hours',
    description: 'Same as the harness call trigger/enable_scheduled_daily_activities. The schedule lasts until the next state reset.',
    responses: okRef('Status.', 'DailyActivities'),
    handler: ({ d }) => {
      d.admin.enableScheduledDailyActivities();
      d.bus.event('info', 'admin', 'Daily activities scheduled every 24 hours');
      return { ...d.admin.daily, scheduled: d.admin.flags.scheduledDailyActivities };
    },
  },
  {
    method: 'GET', path: '/operations/measurement-triggers', operationId: 'getMeasurementTriggers', tag: 'Operations', scope: 'read',
    summary: 'Measurement-report triggers',
    responses: okRef('Triggers.', 'MeasurementTriggers'),
    handler: ({ d }) => triggersOf(d),
  },
  {
    method: 'PUT', path: '/operations/measurement-triggers', operationId: 'setMeasurementTriggers', tag: 'Operations', scope: 'write',
    summary: 'Request measurement reports',
    description: '`measInRegistration`: registration responses carry measReportConfig RECEIVED_POWER_WITHOUT_GRANT (for CBSDs that support it). `measInHeartbeat`: heartbeat responses carry RECEIVED_POWER_WITH_GRANT. Fields left out are unchanged.',
    body: { required: true, schema: S.obj({ measInRegistration: S.bool(), measInHeartbeat: S.bool() }), example: { measInRegistration: true, measInHeartbeat: false } },
    responses: okRef('Triggers.', 'MeasurementTriggers'),
    handler: ({ d, body }) => {
      if ('measInRegistration' in body) d.engine.measInRegistration = body.measInRegistration;
      if ('measInHeartbeat' in body) d.engine.measInHeartbeat = body.measInHeartbeat;
      d.bus.event('info', 'admin', `Measurement report triggers: registration=${d.engine.measInRegistration}, heartbeat=${d.engine.measInHeartbeat}`);
      d.bus.changed('status');
      return triggersOf(d);
    },
  },
  {
    method: 'PATCH', path: '/operations/flags', operationId: 'setOperationFlags', tag: 'Operations', scope: 'write',
    summary: 'Set harness flags',
    description: '`ntiaExclusionZones` (harness trigger/enable_ntia_15_517) and `escConnected` (trigger/disconnect_esc). They are recorded and reported; they do not change how requests are answered.',
    body: { required: true, schema: S.obj({ ntiaExclusionZones: S.bool(), escConnected: S.bool() }), example: { escConnected: false } },
    responses: okRef('State.', 'OperationsState'),
    handler: ({ d, body }) => {
      if ('ntiaExclusionZones' in body) d.admin.flags.ntiaExclusionZones = body.ntiaExclusionZones;
      if ('escConnected' in body) d.admin.flags.escConnected = body.escConnected;
      d.bus.event('info', 'admin', `Flags: ntiaExclusionZones=${d.admin.flags.ntiaExclusionZones}, escConnected=${d.admin.flags.escConnected}`);
      d.bus.changed('status');
      return stateOf(d);
    },
  },
  {
    method: 'POST', path: '/operations/reset', operationId: 'resetSasState', tag: 'Operations', scope: 'write',
    summary: 'Reset the SAS state',
    description: 'Deletes every CBSD, grant, registry entry (FCC IDs, user IDs, blacklist, conditional registrations, CPI users), injected incumbent, PPA and protection, and clears the triggers and flags, like the harness Reset call. Settings, certificates and fault rules are kept. `clearLogs` also empties the wire log and event log. The body must contain `"confirm": "RESET"`.',
    body: { required: true, schema: S.obj({ confirm: S.enum(['RESET']), clearLogs: S.bool({ default: false }) }, ['confirm']), example: { confirm: 'RESET', clearLogs: false } },
    responses: ok('Done.', S.obj({ reset: S.bool(), logsCleared: S.bool() }, ['reset', 'logsCleared'])),
    handler: ({ d, body }) => {
      if (body.confirm !== 'RESET') throw badRequest('Confirmation required: {"confirm": "RESET"}');
      d.admin.reset('API');
      if (body.clearLogs) {
        d.db.run('DELETE FROM msg_log');
        d.db.run('DELETE FROM events');
        d.bus.changed('messages');
        d.bus.changed('events');
      }
      return { reset: true, logsCleared: !!body.clearLogs };
    },
  },

  // ---------------------------------------------------------------- listeners
  {
    method: 'GET', path: '/listeners', operationId: 'getListeners', tag: 'Listeners', scope: 'read',
    summary: 'SAS listener status',
    description: 'HTTP and HTTPS listener state: port, whether it is listening and the last error; for HTTPS also the client-certificate policy, server certificates, trust-anchor count, cipher suites and protocol versions.',
    responses: okRef('Status.', 'Listeners'),
    handler: ({ d }) => d.sas.getStatus(),
  },
  {
    method: 'POST', path: '/listeners/restart', operationId: 'restartListeners', tag: 'Listeners', scope: 'write',
    summary: 'Restart the SAS listeners',
    description: 'Closes and reopens both listeners with the current settings. Open connections are dropped. Returns when the listeners are back.',
    responses: okRef('Status after the restart.', 'Listeners'),
    handler: async ({ d }) => {
      await d.sas.restart();
      return d.sas.getStatus();
    },
  },
  {
    method: 'POST', path: '/listeners/reload-tls', operationId: 'reloadTls', tag: 'Listeners', scope: 'write',
    summary: 'Reload TLS certificates',
    description: 'Swaps the server certificates, trust anchors and CRLs on the running HTTPS listener without dropping connections. This happens automatically when certificates change; use it after replacing files by hand.',
    responses: okRef('Status.', 'Listeners'),
    handler: async ({ d }) => {
      d.sas.reloadTls();
      await d.sas.idle();
      return d.sas.getStatus();
    },
  },
];
