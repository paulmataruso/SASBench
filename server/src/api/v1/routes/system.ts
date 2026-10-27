import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sasUrls, detectProfile } from '../../../api.ts';
import { RC_NAME } from '../../../sas/codes.ts';
import { SAS_METHODS } from '../../../sas/engine.ts';
import { RADIO_TECHNOLOGIES, MEAS_CAPABILITIES } from '../../../sas/registration.ts';
import { PRESETS } from '../../../presets.ts';
import type { Ctx, Route, V1Deps } from '../http.ts';
import { S } from '../schema.ts';
import { ok, okRef } from './common.ts';
import { HARNESS_METHODS } from './harness.ts';
import { DOWNLOAD_FORMATS, KEY_TYPES, CA_ROLES } from './certs.ts';
import { INCUMBENT_KINDS } from './spectrum.ts';

// Service information: index, health, OpenAPI document, status, process details, reference data.

export function statusOf(d: V1Deps) {
  const { db, settings, engine, admin, sas } = d;
  const s = settings.get();
  const count = (q: string, ...p: any[]) => db.get(q, ...p)?.n ?? 0;
  const grantsByState: Record<string, number> = {};
  for (const g of db.all('SELECT state, COUNT(*) AS n FROM grants GROUP BY state')) grantsByState[g.state] = g.n;
  const since = Date.now() - 3600e3;
  return {
    version: d.version, startedAt: d.startedAt, now: Date.now(), hostname: os.hostname(),
    listeners: sas.getStatus(), urls: sasUrls(s, d.advertised),
    counts: {
      cbsdsRegistered: count("SELECT COUNT(*) AS n FROM cbsds WHERE state = 'REGISTERED'"),
      cbsdsPending: count("SELECT COUNT(*) AS n FROM cbsds WHERE state = 'PENDING'"),
      cbsdsTotal: count('SELECT COUNT(*) AS n FROM cbsds'),
      grantsByState,
      authorizedMHz: (db.get("SELECT COALESCE(SUM(high_freq - low_freq), 0) AS n FROM grants WHERE state = 'AUTHORIZED'")?.n ?? 0) / 1e6,
      messagesLastHour: count('SELECT COUNT(*) AS n FROM msg_log WHERE ts > ?', since),
      errorsLastHour: count('SELECT COUNT(*) AS n FROM msg_log WHERE ts > ? AND (error IS NOT NULL OR http_status >= 400)', since),
      activeProtections: count('SELECT COUNT(*) AS n FROM protections WHERE active = 1'),
      ppas: count('SELECT COUNT(*) AS n FROM ppas'),
      faultRules: count('SELECT COUNT(*) AS n FROM fault_rules WHERE enabled = 1'),
    },
    triggers: { measInRegistration: engine.measInRegistration, measInHeartbeat: engine.measInHeartbeat },
    daily: admin.daily, ppaStatus: admin.ppaStatus, flags: admin.flags,
    terrain: { directory: engine.terrain?.directory ?? null, tiles: engine.terrain?.tileCount ?? 0 },
    profile: detectProfile(s),
  };
}

const fileSize = (f: string) => {
  try {
    return fs.statSync(f).size;
  } catch {
    return null;
  }
};

let openapiCache: unknown = null;

export const systemRoutes: Route[] = [
  {
    method: 'GET', path: '/', operationId: 'getApiIndex', tag: 'System', scope: 'public',
    summary: 'API index',
    description: 'Names the service and links to the OpenAPI document and the main collections. Needs no authentication.',
    responses: okRef('Service name, versions and links.', 'ApiIndex'),
    handler: ({ d }) => ({
      service: 'SASBench', version: d.version, apiVersion: 'v1', openapi: '/api/v1/openapi.json',
      links: Object.fromEntries(['status', 'system', 'cbsds', 'grants', 'spectrum', 'registry', 'faults', 'messages', 'events', 'stream', 'settings', 'certs', 'harness/methods', 'tokens']
        .map((k) => [k.split('/')[0], `/api/v1/${k}`])),
    }),
  },
  {
    method: 'GET', path: '/health', operationId: 'getHealth', tag: 'System', scope: 'public',
    summary: 'Health check',
    description: 'For load balancers and container health checks. Needs no authentication. `status` is `degraded` when an enabled SAS listener is not listening.',
    responses: okRef('Process health and listener state.', 'Health'),
    handler: ({ d }) => {
      const l = d.sas.getStatus();
      const degraded = (l.http.enabled && !l.http.listening) || (l.https.enabled && !l.https.listening);
      return {
        status: degraded ? 'degraded' : 'ok', version: d.version, uptimeMs: Date.now() - d.startedAt,
        listeners: { http: l.http.listening, https: l.https.listening },
      };
    },
  },
  {
    method: 'GET', path: '/openapi.json', operationId: 'getOpenApi', tag: 'System', scope: 'public',
    summary: 'OpenAPI 3.1 document',
    description: 'Machine-readable description of every endpoint, generated from the same route table that serves the API. Load it into Swagger UI, Postman, Insomnia or a client generator. Needs no authentication.',
    responses: ok('The OpenAPI document.', S.anyObj()),
    handler: async ({ d }) => {
      if (!openapiCache) {
        const { buildOpenApi } = await import('../openapi.ts');
        openapiCache = buildOpenApi(d.version);
      }
      return openapiCache;
    },
  },
  {
    method: 'GET', path: '/status', operationId: 'getStatus', tag: 'System', scope: 'read',
    summary: 'SAS status summary',
    description: 'What the Overview page shows: listener state, SAS URLs, counts of CBSDs, grants, messages and protections, measurement-report triggers, daily-activity state and the active settings profile.',
    responses: okRef('Status summary.', 'Status'),
    handler: ({ d }) => statusOf(d),
  },
  {
    method: 'GET', path: '/system', operationId: 'getSystem', tag: 'System', scope: 'read',
    summary: 'Process and host details',
    description: 'Versions, uptime, memory, ports and addresses, data locations and database size.',
    responses: okRef('Process details.', 'SystemInfo'),
    handler: ({ d }) => {
      const dbFile = path.join(d.dataDir, 'sas.db');
      return {
        version: d.version, apiVersion: 'v1', node: process.version, platform: process.platform, arch: process.arch,
        hostname: os.hostname(), pid: process.pid, startedAt: d.startedAt, uptimeMs: Date.now() - d.startedAt, memory: process.memoryUsage(),
        uiPort: d.uiPort, apiPort: d.apiPort, bindIp: d.bindIp, hostnames: d.hostnames, advertised: d.advertised, dataDir: d.dataDir,
        database: { file: dbFile, sizeBytes: fileSize(dbFile), walSizeBytes: fileSize(`${dbFile}-wal`) },
        terrainDir: d.engine.terrain?.directory ?? null, tilesDir: d.tiles.dir,
      };
    },
  },
  {
    method: 'GET', path: '/activity', operationId: 'getActivity', tag: 'System', scope: 'read',
    summary: 'Message counts over time',
    description: 'Wire-log messages per SAS method in time buckets: one-minute buckets up to 60 minutes, five-minute buckets beyond. `errors` counts the exchanges that failed: an HTTP or transport error, or a non-zero first response code (the same rule as the console\'s activity chart).',
    query: { minutes: { description: 'Window length in minutes (1–1440).', schema: S.int({ minimum: 1, maximum: 1440, default: 60 }) } },
    responses: okRef('Bucketed counts.', 'Activity'),
    handler: ({ d, query }) => {
      const minutes = query.minutes as number;
      const bucket = minutes <= 60 ? 60e3 : 5 * 60e3;
      const since = Date.now() - minutes * 60e3;
      const rows = d.db.all(`SELECT (ts / ?) * ? AS b, method, COUNT(*) AS n,
        SUM(CASE WHEN error IS NOT NULL OR http_status >= 400 OR (codes IS NOT NULL AND codes != '0' AND codes NOT LIKE '0,%') THEN 1 ELSE 0 END) AS e
        FROM msg_log WHERE ts > ? GROUP BY b, method ORDER BY b`, bucket, bucket, since);
      return { bucketMs: bucket, since, rows: rows.map((r) => ({ bucket: r.b, method: r.method ?? null, count: r.n, errors: r.e })) };
    },
  },
  {
    method: 'GET', path: '/reference', operationId: 'getReference', tag: 'System', scope: 'read',
    summary: 'Enumerations and reference data',
    description: 'Every fixed vocabulary the API accepts or returns: WINNF-TS-0016 response codes, SAS methods, radio technologies, measurement capabilities, states, fault actions, protection kinds, incumbent kinds, key types, CA roles, download formats, harness methods and settings profiles.',
    responses: okRef('Reference data.', 'Reference'),
    handler: () => ({
      responseCodes: Object.entries(RC_NAME).map(([code, name]) => ({ code: Number(code), name })),
      sasMethods: SAS_METHODS, radioTechnologies: RADIO_TECHNOLOGIES, measCapabilities: MEAS_CAPABILITIES,
      cbsdStates: ['REGISTERED', 'PENDING', 'UNREGISTERED'],
      grantStates: ['GRANTED', 'AUTHORIZED', 'TERMINATED', 'RELINQUISHED', 'EXPIRED', 'DELETED'],
      channelTypes: ['GAA', 'PAL'], faultActions: ['response_code', 'patch', 'http_status', 'delay', 'drop', 'malformed'],
      protectionKinds: ['ADMIN', 'DPA', 'ESC', 'FSS', 'EXCLUSION', 'GWPZ', 'FSS_GWBL', 'EXCLUSION_ZONE'], protectionActions: ['suspend', 'terminate'],
      incumbentKinds: INCUMBENT_KINDS, keyTypes: KEY_TYPES, caRoles: CA_ROLES, downloadFormats: DOWNLOAD_FORMATS,
      harnessMethods: HARNESS_METHODS, settingsProfiles: Object.keys(PRESETS), tokenScopes: ['read', 'write'],
    }),
  },
  {
    method: 'GET', path: '/auth/whoami', operationId: 'whoAmI', tag: 'Tokens', scope: 'read',
    summary: 'Who is calling',
    description: 'How this request was authenticated (`session` for the console login, `password` for HTTP Basic, `token` for an API key, `open` when authentication is switched off), as which user, and with which role and scope.',
    responses: okRef('The caller.', 'Principal'),
    handler: (c: Ctx) => {
      const { method, scope, role, userId, username, tokenId, tokenName } = c.principal;
      return { method, scope, role, userId, username, tokenId, tokenName, authEnabled: !c.d.auth.off };
    },
  },
];

