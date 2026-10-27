import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cbsdIdFor, regRequest, startSas, type TestSas } from './helpers.ts';
import { validate, type Schema } from '../src/api/v1/schema.ts';
import { SETTINGS_META, settingKeys } from '../src/api/v1/settingsMeta.ts';
import { COMPONENTS } from '../src/api/v1/components.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';

// Black-box test of the public REST API (/api/v1) against a real SAS process. Every operation in
// the OpenAPI document must be called successfully at least once (checked at the end), and every
// JSON response is validated against the schema the document declares for it, so the generated
// reference cannot drift from what the server returns.

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC', 'base64');
const ALLOWED_ORIGIN = 'http://allowed.example';
const enc = encodeURIComponent;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sas: TestSas;
let base: string;
let doc: any;
let stub: http.Server;
let stubUrl: string;
let tilesDir: string;
let terrainDir: string;
const ops = new Map<string, any>();
const succeeded = new Set<string>();
const statuses = new Map<string, Set<number>>();
const schemaProblems: string[] = [];
let validated = 0;
let auth: string | undefined;

interface Res {
  status: number;
  headers: Headers;
  body: any;
  text: string;
  buf: Buffer;
}

function record(opId: string | null, status: number) {
  if (!opId) return;
  if (status >= 200 && status < 300) succeeded.add(opId);
  if (!statuses.has(opId)) statuses.set(opId, new Set());
  statuses.get(opId)!.add(status);
}

/** Call /api/v1; records the operation, validates JSON against the documented schema. */
async function call(method: string, p: string, o: { body?: unknown; raw?: string; auth?: string | null; headers?: Record<string, string>; expect?: number } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...o.headers };
  const a = o.auth === undefined ? auth : o.auth;
  if (a) headers.Authorization = a;
  let body: string | undefined;
  if (o.raw !== undefined) {
    body = o.raw;
    headers['Content-Type'] = 'application/json';
  } else if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${base}/api/v1${p}`, { method, headers, body });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  const json = (res.headers.get('content-type') ?? '').startsWith('application/json') && text ? JSON.parse(text) : undefined;
  const opId = res.headers.get('x-operation-id');
  record(opId, res.status);
  if (json !== undefined && method !== 'HEAD' && doc) {
    const op = opId ? ops.get(opId) : null;
    const spec = op ? (op.responses[res.status] ?? op.responses.default) : { content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
    const schema: Schema | undefined = spec?.content?.['application/json']?.schema;
    if (!spec) schemaProblems.push(`${opId} ${method} ${p}: status ${res.status} is not documented`);
    else if (schema) {
      validated++;
      const issues = validate(schema, json, doc.components.schemas);
      if (issues.length) schemaProblems.push(`${opId ?? '?'} ${method} ${p} → ${res.status}: ${issues.slice(0, 5).map((i) => `${i.path} ${i.message}`).join('; ')}`);
    }
  }
  if (o.expect !== undefined) assert.equal(res.status, o.expect, `${method} ${p} → ${res.status}: ${text.slice(0, 600)}`);
  return { status: res.status, headers: res.headers, body: json, text, buf };
}

const get = async (p: string, expect = 200) => (await call('GET', p, { expect })).body;
const post = async (p: string, body?: unknown, expect = 200) => (await call('POST', p, { body, expect })).body;
const put = async (p: string, body?: unknown, expect = 200) => (await call('PUT', p, { body, expect })).body;
const patch = async (p: string, body?: unknown, expect = 200) => (await call('PATCH', p, { body, expect })).body;
const del = async (p: string, expect = 204) => (await call('DELETE', p, { expect })).body;
/** Expect an error response with this status and error code. */
async function fails(method: string, p: string, status: number, code: string, body?: unknown): Promise<any> {
  const r = await call(method, p, { body, expect: status });
  assert.equal(r.body?.error?.code, code, `${method} ${p}: ${r.text}`);
  assert.equal(r.body.error.status, status);
  assert.ok(r.body.error.requestId);
  return r.body.error;
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting: ${JSON.stringify(v).slice(0, 500)}`);
    await sleep(100);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** GridFloat tile n40w101 (39–40 N, 100–101 W): a gentle slope from 300 m to 450 m. */
function writeTerrainFixture(dir: string) {
  const N = 150;
  fs.mkdirSync(dir, { recursive: true });
  const flt = Buffer.alloc(N * N * 4);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) flt.writeFloatLE(300 + c, (r * N + c) * 4);
  fs.writeFileSync(path.join(dir, 'floatn40w101_1_std.flt'), flt);
  fs.writeFileSync(path.join(dir, 'floatn40w101_1_std.hdr'),
    `ncols ${N}\nnrows ${N}\nxllcorner -101\nyllcorner 39\ncellsize ${1 / N}\nNODATA_value -999999\nbyteorder LSBFIRST\n`);
}

const base64 = (b: Buffer | string) => Buffer.from(b).toString('base64');

before(async () => {
  // Local stand-ins for a map tile server, the USGS terrain bucket and a peer SAS.
  stub = http.createServer((req, res) => {
    const u = req.url ?? '';
    if (/^\/t\/\d+\/\d+\/\d+\.png$/.test(u)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(PNG);
    }
    if (/^\/slow\/\d+\/\d+\/\d+\.png$/.test(u)) {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(PNG);
      }, 3000);
      return;
    }
    if (u === '/n10w010/USGS_1_n10w010.tif') {
      res.writeHead(200, { 'Content-Type': 'image/tiff' });
      return res.end(Buffer.alloc(2048, 7));
    }
    if (u === '/n11w010/USGS_1_n11w010.tif') {
      setTimeout(() => {
        res.writeHead(200);
        res.end(Buffer.alloc(16));
      }, 5000);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(stub.address() as net.AddressInfo).port}`;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sasbench-apiv1-'));
  tilesDir = path.join(root, 'tiles');
  terrainDir = path.join(root, 'terrain');
  fs.mkdirSync(path.join(tilesDir, 'folder', '3', '2'), { recursive: true });
  fs.writeFileSync(path.join(tilesDir, 'folder', '3', '2', '5.png'), PNG);
  writeTerrainFixture(terrainDir);

  sas = await startSas({
    SAS_TILES_DIR: tilesDir, SAS_TERRAIN_DIR: terrainDir, SAS_TERRAIN_SOURCE_URL: stubUrl, SAS_API_CORS_ORIGINS: ALLOWED_ORIGIN,
    SAS_API_STREAM_PING_MS: '300',
  });
  base = `http://127.0.0.1:${sas.uiPort}`;
  auth = sas.authHeader; // the first-start admin (admin / admin)
  doc = (await call('GET', '/openapi.json', { expect: 200 })).body;
  for (const [p, methods] of Object.entries<any>(doc.paths)) {
    for (const [m, op] of Object.entries<any>(methods)) ops.set(op.operationId, { ...op, method: m.toUpperCase(), path: p });
  }
});

after(async () => {
  await sas?.stop();
  stub?.close();
});

// ================================================================================== shared state
const FCC = 'API-FCC';
const cbsdA = cbsdIdFor(FCC, 'SN-A');
const cbsdB = cbsdIdFor(FCC, 'SN-B');
let grantA = '';
let grantB = '';
let cbsdCaId = '';
let installerCaId = '';
let autoServerIds: string[] = [];

describe('API v1', () => {
  // ------------------------------------------------------------------------------- unit checks
  it('settings metadata covers exactly the settings, and every default is valid', () => {
    assert.deepEqual([...settingKeys].sort(), Object.keys(DEFAULT_SETTINGS).sort());
    for (const k of settingKeys) {
      const issues = validate((SETTINGS_META as any)[k].schema, (DEFAULT_SETTINGS as any)[k], COMPONENTS, k);
      assert.deepEqual(issues, [], `default of ${k}`);
      assert.ok((SETTINGS_META as any)[k].description.length > 10, `description of ${k}`);
    }
  });

  it('the OpenAPI document is well-formed', () => {
    assert.equal(doc.openapi, '3.1.0');
    assert.ok(ops.size >= 160, `only ${ops.size} operations`);
    const tags = new Set(doc.tags.map((t: any) => t.name));
    for (const [id, op] of ops) {
      assert.match(id, /^[a-z][A-Za-z0-9]+$/);
      assert.ok(tags.has(op.tags[0]), `${id} has undocumented tag ${op.tags[0]}`);
      assert.ok(op.summary, `${id} summary`);
      assert.ok(op.responses.default, `${id} default response`);
      for (const m of op.path.matchAll(/\{(\w+)\}/g)) assert.ok(op.parameters.some((x: any) => x.in === 'path' && x.name === m[1]), `${id} path parameter ${m[1]}`);
    }
    // Every $ref resolves.
    const refs = JSON.stringify(doc).match(/#\/components\/schemas\/\w+/g) ?? [];
    for (const r of new Set(refs)) assert.ok(doc.components.schemas[r.split('/').pop()!], `dangling ${r}`);
  });

  // ------------------------------------------------------------------------------- system
  it('serves the index, health, status, system, activity and reference data', async () => {
    const idx = await get('/');
    assert.equal(idx.service, 'SASBench');
    assert.equal(idx.openapi, '/api/v1/openapi.json');
    for (const link of Object.values(idx.links) as string[]) {
      if (link !== '/api/v1/stream') await get(link.slice('/api/v1'.length));
    }
    assert.equal((await get('/health')).status, 'ok');
    const st = await get('/status');
    assert.equal(st.listeners.https.listening, true);
    assert.equal(st.profile, 'lab');
    const sys = await get('/system');
    assert.equal(sys.apiVersion, 'v1');
    assert.ok(sys.database.sizeBytes > 0);
    assert.equal((await get('/activity')).bucketMs, 60000);
    assert.equal((await get('/activity?minutes=180')).bucketMs, 300000);
    const ref = await get('/reference');
    assert.ok(ref.responseCodes.some((c: any) => c.code === 501 && c.name === 'SUSPENDED_GRANT'));
    assert.ok(ref.harnessMethods.some((m: any) => m.method === 'trigger/load_dpas'));
    const who = await get('/auth/whoami');
    assert.deepEqual(who, { method: 'password', scope: 'write', role: 'admin', userId: 1, username: 'admin', authEnabled: true });
  });

  it('follows the HTTP conventions: request ids, HEAD, OPTIONS, 404, 405, validation errors', async () => {
    const r = await call('GET', '/status', { headers: { 'X-Request-Id': 'trace-123' }, expect: 200 });
    assert.equal(r.headers.get('x-request-id'), 'trace-123');
    assert.equal(r.headers.get('x-operation-id'), 'getStatus');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const h = await call('HEAD', '/status', { expect: 200 });
    assert.equal(h.text, '');
    assert.ok(Number(h.headers.get('content-length')) > 0);
    const o = await call('OPTIONS', '/faults', { expect: 204 });
    assert.equal(o.headers.get('allow'), 'GET, POST, DELETE, HEAD, OPTIONS');
    const e405 = await fails('PUT', '/status', 405, 'method_not_allowed');
    assert.match(e405.message, /GET, HEAD, OPTIONS/);
    const e404 = await fails('GET', '/nope', 404, 'route_not_found');
    assert.match(e404.message, /%2F/);
    await fails('GET', `/cbsds/${cbsdA}`, 404, 'route_not_found'); // unencoded "/" in the id
    const unknown = await fails('GET', '/cbsds?colour=red', 400, 'validation_failed');
    assert.deepEqual(unknown.details, [{ path: 'colour', message: 'is not a known query parameter' }]);
    const bad = await fails('GET', '/cbsds?limit=0&state=GONE', 400, 'validation_failed');
    assert.equal(bad.details.length, 2);
    await fails('POST', '/faults', 400, 'bad_request'); // no body
    const badJson = await call('POST', '/faults', { raw: '{"action":', expect: 400 });
    assert.equal(badJson.body.error.code, 'invalid_json');
    const extra = await fails('POST', '/faults', 400, 'validation_failed', { action: 'drop', colour: 'red' });
    assert.equal(extra.details[0].path, 'colour');
  });

  // ------------------------------------------------------------------------------- settings
  it('reads, describes and changes settings', async () => {
    const s = await get('/settings');
    assert.equal('uiPassword' in s.settings, false);
    const schema = await get('/settings/schema');
    assert.equal(schema.items.length, settingKeys.length);
    assert.ok(schema.items.find((x: any) => x.key === 'tlsMinVersion').restartsListeners);
    const one = await get('/settings/heartbeatIntervalSec');
    assert.equal(one.key, 'heartbeatIntervalSec');
    await fails('GET', '/settings/notASetting', 400, 'validation_failed');

    const ch = await patch('/settings', { heartbeatIntervalSec: 45 });
    assert.deepEqual(ch.changed, ['heartbeatIntervalSec']);
    assert.equal(ch.settings.heartbeatIntervalSec, 45);
    assert.equal(ch.listenersRestarted, false);
    assert.equal((await put('/settings/heartbeatIntervalSec', { value: 60 })).settings.heartbeatIntervalSec, 60);
    await fails('PUT', '/settings/heartbeatIntervalSec', 400, 'validation_failed', { value: 'soon' });
    await fails('PATCH', '/settings', 400, 'validation_failed', { sasHttpsPort: s.settings.sasHttpPort });
    await fails('PATCH', '/settings', 400, 'validation_failed', { heartbeatIntervalSec: -1 });
    await fails('PATCH', '/settings', 400, 'validation_failed', { notASetting: 1 });
    await fails('PATCH', '/settings', 400, 'validation_failed', { bandLowHz: 3700e6 });
    await fails('PATCH', '/settings', 400, 'validation_failed', { mapTileUrl: 'https://tiles.example/tile.png' });
    await fails('PATCH', '/settings', 400, 'validation_failed', { serverCertIds: ['no-such-cert'] });
    await fails('PATCH', '/settings', 400, 'validation_failed', { serverCertIds: [] });

    // A listener setting restarts the listeners and the call waits for them.
    const tls = await patch('/settings', { tlsMinVersion: 'TLSv1.3', tlsMaxVersion: 'TLSv1.3' });
    assert.equal(tls.listenersRestarted, true);
    assert.equal(tls.listeners.https.listening, true);
    assert.match(tls.listeners.https.protocols, /TLSv1\.3/);
    await patch('/settings', { tlsMinVersion: 'TLSv1.2', tlsMaxVersion: 'TLSv1.2' });
  });

  it('lists, applies and resets settings profiles', async () => {
    const profiles = await get('/settings/profiles');
    assert.deepEqual(profiles.items.map((p: any) => p.name).sort(), ['lab', 'open', 'winnforum']);
    const w = await post('/settings/profiles/winnforum/apply');
    assert.equal(w.profile, 'winnforum');
    await fails('POST', '/settings/profiles/nope/apply', 400, 'validation_failed');
    const reset = await post('/settings/reset');
    assert.equal(reset.profile, 'lab');
    assert.equal(reset.settings.heartbeatIntervalSec, DEFAULT_SETTINGS.heartbeatIntervalSec);
    autoServerIds = reset.settings.serverCertIds;
    assert.ok(autoServerIds.length >= 1);
  });

  // ------------------------------------------------------------------------------- registry
  it('manages FCC IDs and user IDs', async () => {
    const a = await post('/registry/fcc-ids', { fccId: FCC, maxEirp: 40 }, 201);
    assert.deepEqual([a.fccId, a.maxEirp], [FCC, 40]);
    const r = await call('POST', '/registry/fcc-ids', { body: { fccId: FCC }, expect: 200 });
    assert.equal(r.body.maxEirp, 47);
    assert.equal((await get(`/registry/fcc-ids/${FCC}`)).fccId, FCC);
    assert.equal((await get('/registry/fcc-ids?q=API-')).total, 1);
    // Search text is literal: LIKE wildcards in it are escaped.
    assert.equal((await get('/registry/fcc-ids?q=API_')).total, 0);
    assert.equal((await get('/registry/fcc-ids?q=%25')).total, 0);
    await post('/registry/fcc-ids', { fccId: 'TEMP-FCC' }, 201);
    await del('/registry/fcc-ids/TEMP-FCC');
    await fails('GET', '/registry/fcc-ids/TEMP-FCC', 404, 'not_found');
    await fails('DELETE', '/registry/fcc-ids/TEMP-FCC', 404, 'not_found');
    await fails('POST', '/registry/fcc-ids', 400, 'validation_failed', { fccId: '' });

    const created = await call('POST', '/registry/user-ids', { body: { userId: 'lab-user' }, expect: 201 });
    assert.equal(created.headers.get('location'), '/api/v1/registry/user-ids/lab-user');
    await post('/registry/user-ids', { userId: 'lab-user' }, 200);
    await post('/registry/user-ids', { userId: 'temp user/1' }, 201);
    assert.equal((await get(`/registry/user-ids/${enc('temp user/1')}`)).userId, 'temp user/1');
    assert.ok((await get('/registry/user-ids')).total >= 2);
    await del(`/registry/user-ids/${enc('temp user/1')}`);
  });

  it('manages the blacklist, preloaded registrations and CPI users', async () => {
    const b = await post('/registry/blacklist', { fccId: 'BAD-FCC', serial: 'SN-9', reason: 'test' }, 201);
    assert.equal((await post('/registry/blacklist', { fccId: 'BAD-FCC', serial: 'SN-9' }, 200)).id, b.id);
    const whole = await post('/registry/blacklist', { fccId: 'BAD-FCC' }, 201);
    assert.equal(whole.serial, null);
    assert.equal((await get('/registry/blacklist?fccId=BAD-FCC')).total, 2);
    assert.equal((await get(`/registry/blacklist/${b.id}`)).reason, 'test');
    await del(`/registry/blacklist/${b.id}`);
    await del(`/registry/blacklist/${whole.id}`);
    await fails('GET', '/registry/blacklist/abc', 400, 'validation_failed');

    const one = await post('/registry/conditional', { fccId: FCC, cbsdSerialNumber: 'SN-PRE', cbsdCategory: 'B' });
    assert.equal(one.saved, 1);
    const many = await post('/registry/conditional', { registrationData: [{ fccId: FCC, cbsdSerialNumber: 'SN-PRE2' }, { fccId: FCC, cbsdSerialNumber: 'SN-PRE3' }] });
    assert.equal(many.saved, 2);
    assert.equal((await post('/registry/conditional', [{ fccId: FCC, cbsdSerialNumber: 'SN-PRE4' }])).saved, 1);
    await fails('POST', '/registry/conditional', 400, 'validation_failed', { cbsdCategory: 'A' });
    assert.equal((await get('/registry/conditional?fccId=API-FCC')).total, 4);
    assert.equal((await get(`/registry/conditional/${FCC}/SN-PRE`)).data.cbsdCategory, 'B');
    for (const s of ['SN-PRE', 'SN-PRE2', 'SN-PRE3', 'SN-PRE4']) await del(`/registry/conditional/${FCC}/${s}`);
    await fails('GET', `/registry/conditional/${FCC}/SN-PRE`, 404, 'not_found');

    const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const cpi = await post('/registry/cpi-users', { cpiId: 'cpi-key', name: 'Key CPI', publicKey: pem }, 201);
    assert.equal(cpi.source, 'api');
    await post('/registry/cpi-users', { cpiId: 'cpi-key', name: 'Renamed', publicKey: pem }, 200);
    assert.equal((await get('/registry/cpi-users/cpi-key')).name, 'Renamed');
    assert.equal((await get('/registry/cpi-users')).total, 1);
    await fails('POST', '/registry/cpi-users', 400, 'bad_request', { cpiId: 'x' });
    await del('/registry/cpi-users/cpi-key');

    const all = await get('/registry');
    assert.ok(all.fccIds.some((f: any) => f.fccId === FCC));
    assert.ok(all.userIds.some((u: any) => u.userId === 'lab-user'));
  });

  // ------------------------------------------------------------------------------- SAS protocol
  it('sends protocol requests internally and through the HTTP and HTTPS listeners', async () => {
    const reg = await post('/sas/registration', { registrationRequest: [regRequest(FCC, 'SN-A'), regRequest(FCC, 'SN-B')] });
    assert.equal(reg.transport, 'internal');
    assert.deepEqual(reg.body.registrationResponse.map((x: any) => x.response.responseCode), [0, 0]);
    assert.equal(reg.body.registrationResponse[0].cbsdId, cbsdA);

    const siq = await post('/sas/spectrumInquiry?transport=http', {
      spectrumInquiryRequest: [{ cbsdId: cbsdA, inquiredSpectrum: [{ lowFrequency: 3550e6, highFrequency: 3700e6 }] }],
    });
    assert.equal(siq.httpStatus, 200);
    assert.equal(siq.transport, 'http');
    assert.ok(siq.body.spectrumInquiryResponse[0].availableChannel.length > 0);

    const g = await post('/sas/grant', {
      grantRequest: [
        { cbsdId: cbsdA, operationParam: { maxEirp: 10, operationFrequencyRange: { lowFrequency: 3550e6, highFrequency: 3560e6 } } },
        { cbsdId: cbsdB, operationParam: { maxEirp: 10, operationFrequencyRange: { lowFrequency: 3560e6, highFrequency: 3570e6 } } },
      ],
    });
    [grantA, grantB] = g.body.grantResponse.map((x: any) => x.grantId);
    assert.ok(grantA && grantB);
    const hb = await post('/sas/heartbeat?version=v1.2', { heartbeatRequest: [{ cbsdId: cbsdA, grantId: grantA, operationState: 'GRANTED' }, { cbsdId: cbsdB, grantId: grantB, operationState: 'GRANTED' }] });
    assert.deepEqual(hb.body.heartbeatResponse.map((x: any) => x.response.responseCode), [0, 0]);

    // HTTPS with a client certificate from the store (mutual TLS through the real listener).
    const ca = (await get('/certs?kind=sub_ca')).items.find((c: any) => c.role === 'cbsd');
    cbsdCaId = ca.id;
    installerCaId = (await get('/certs?kind=sub_ca')).items.find((c: any) => c.role === 'installer').id;
    const cert = await post('/certs/cbsd', { parentId: cbsdCaId, fccId: FCC, serial: 'SN-TLS' }, 201);
    const tls = await post(`/sas/registration?transport=https&clientCertId=${cert.id}`, { registrationRequest: [regRequest(FCC, 'SN-TLS')] });
    assert.equal(tls.httpStatus, 200, JSON.stringify(tls));
    assert.equal(tls.body.registrationResponse[0].response.responseCode, 0);
    const reg2 = await get(`/cbsds/${enc(cbsdIdFor(FCC, 'SN-TLS'))}`);
    assert.equal(reg2.transport, 'https');
    assert.match(reg2.certInfo.subject, /SN-TLS|API-FCC/);

    // Raw payloads reach the listener unchanged.
    const raw = await post('/sas/registration?transport=http&raw=true', { rawBody: '{"registrationRequest": [' });
    assert.ok(raw.httpStatus >= 400, JSON.stringify(raw));
    await fails('POST', '/sas/registration?raw=true', 400, 'bad_request', { rawBody: 'x' });
    await fails('POST', '/sas/registration?clientCertId=x', 400, 'bad_request', { registrationRequest: [] });
    await fails('POST', '/sas/registration', 400, 'validation_failed', { grantRequest: [] });
    await fails('POST', '/sas/teleport', 400, 'validation_failed', {});
  });

  // ------------------------------------------------------------------------------- CBSDs
  it('lists, inspects and changes CBSDs', async () => {
    const list = await get('/cbsds?state=REGISTERED&fccId=API-FCC');
    assert.equal(list.total, 3);
    assert.equal((await get('/cbsds?q=SN-A&limit=1')).items.length, 1);
    assert.equal((await get('/cbsds?category=B')).total, 0);
    assert.equal((await get('/cbsds?userId=lab-user&serial=SN-B')).items[0].cbsdId, cbsdB);
    const c = await get(`/cbsds/${enc(cbsdA)}`);
    assert.equal(c.state, 'REGISTERED');
    assert.equal(c.liveGrants[0].grantId, grantA);
    assert.ok(c.availability.length > 0);
    assert.ok(c.limits.maxEirpDbmMhz > 0);
    assert.deepEqual(c.grants, { AUTHORIZED: 1 });

    const u = await patch(`/cbsds/${enc(cbsdA)}`, { notes: 'bench 3', eirpCapDbmMhz: 20, regMeasConfig: ['RECEIVED_POWER_WITHOUT_GRANT'], hbMeasConfig: [] });
    assert.equal(u.notes, 'bench 3');
    assert.equal(u.eirpCapDbmMhz, 20);
    assert.deepEqual(u.regMeasConfig, ['RECEIVED_POWER_WITHOUT_GRANT']);
    assert.equal((await patch(`/cbsds/${enc(cbsdA)}`, { eirpCapDbmMhz: null, pendingDeregister: true })).pendingDeregister, true);
    assert.equal((await patch(`/cbsds/${enc(cbsdA)}`, { pendingDeregister: false })).pendingDeregister, false);
    await fails('PATCH', `/cbsds/${enc(cbsdA)}`, 400, 'validation_failed', { eirpCapDbmMhz: 99 });
    assert.equal((await post(`/cbsds/${enc(cbsdA)}/approve`)).approved, true);

    const av = await get(`/cbsds/${enc(cbsdA)}/availability`);
    assert.ok(av.availability.every((x: any) => ['GAA', 'PAL'].includes(x.channelType)));
    assert.equal((await get(`/cbsds/${enc(cbsdA)}/grants`)).items[0].grantId, grantA);
    assert.equal((await get(`/cbsds/${enc(cbsdA)}/grants?state=GRANTED,AUTHORIZED`)).items[0].grantId, grantA);
    assert.equal((await get(`/cbsds/${enc(cbsdA)}/grants?state=EXPIRED`)).total, 0);
    assert.ok((await get(`/cbsds/${enc(cbsdA)}/events`)).items.length > 0);
    const msgs = await get(`/cbsds/${enc(cbsdA)}/messages?limit=2`);
    assert.equal(msgs.items.length, 2);
    assert.ok(msgs.next);
    await fails('GET', `/cbsds/${enc('NOPE/123')}`, 404, 'not_found');

    // Registered radios into the registry: FCC ID, user ID and the parameters they registered with.
    const before = (await get('/registry/from-cbsds')).items.find((e: any) => e.cbsdId === cbsdA);
    assert.deepEqual([before.fccId, before.serial, before.inRegistry.registration], [FCC, 'SN-A', false]);
    assert.ok((await get('/registry/from-cbsds?missing=true')).items.some((e: any) => e.cbsdId === cbsdA));
    const addA = await post(`/cbsds/${enc(cbsdA)}/registry`, {});
    assert.deepEqual(addA.added, { fccId: !before.inRegistry.fccId, userId: !before.inRegistry.userId, registration: true });
    assert.deepEqual(addA.inRegistry, { fccId: true, userId: true, registration: true });
    const pre = await get(`/registry/conditional/${FCC}/SN-A`);
    assert.equal(pre.source, 'cbsd');
    assert.deepEqual(pre.data.installationParam, (await get(`/cbsds/${enc(cbsdA)}`)).effective.installationParam);
    assert.equal(pre.data.userId, undefined);
    const again = await post(`/cbsds/${enc(cbsdA)}/registry`, { userId: false });
    assert.deepEqual(again.added, { fccId: false, userId: false, registration: false });
    assert.equal(again.notes.length, 2);
    assert.equal((await post(`/cbsds/${enc(cbsdA)}/registry`, { fccId: false, userId: false, replace: true })).added.registration, true);
    const bulk = await post('/registry/from-cbsds', { cbsdIds: [cbsdA, 'NOPE/1'], registration: false });
    assert.deepEqual(bulk.unknown, ['NOPE/1']);
    assert.deepEqual(bulk.results.map((r: any) => r.cbsdId), [cbsdA]);
    // All CBSDs (nothing selected to add here, so the registry is unchanged).
    assert.ok((await post('/registry/from-cbsds', { fccId: false, userId: false, registration: false })).results.length >= 2);
    assert.ok(!(await get('/registry/from-cbsds?missing=true')).items.some((e: any) => e.cbsdId === cbsdA));
    await fails('POST', `/cbsds/${enc('NOPE/123')}/registry`, 404, 'not_found');
    await del(`/registry/conditional/${FCC}/SN-A`);
    // The console offers the same.
    const A = { Authorization: auth! };
    const consoleList = await (await fetch(`${base}/api/registry/from-cbsds`, { headers: A })).json() as any[];
    assert.equal(consoleList.find((e) => e.cbsdId === cbsdA).inRegistry.registration, false);
    const consoleAdd = await fetch(`${base}/api/cbsds/${enc(cbsdA)}/registry`, { method: 'POST', headers: { ...A, 'Content-Type': 'application/json' }, body: '{"fccId":false,"userId":false}' });
    assert.equal(((await consoleAdd.json()) as any).added.registration, true);
    assert.equal((await (await fetch(`${base}/api/cbsds/${enc(cbsdA)}`, { headers: A })).json() as any).registry.registration, true);
    const consoleBulk = await fetch(`${base}/api/registry/from-cbsds`, { method: 'POST', headers: { ...A, 'Content-Type': 'application/json' }, body: JSON.stringify({ cbsdIds: [cbsdA] }) });
    assert.match(((await consoleBulk.json()) as any).results[0].notes.join(' '), /already preloaded/);
    assert.equal((await fetch(`${base}/api/cbsds/${enc('NOPE/1')}/registry`, { method: 'POST', headers: A, body: '{}' })).status, 404);
    await del(`/registry/conditional/${FCC}/SN-A`);
  });

  // ------------------------------------------------------------------------------- grants
  it('lists grants and suspends, resumes, changes and terminates them', async () => {
    assert.equal((await get('/grants?state=AUTHORIZED,GRANTED')).total, 2);
    assert.equal((await get(`/grants?cbsdId=${enc(cbsdA)}&channelType=GAA&suspended=false`)).total, 1);
    const g = await get(`/grants/${enc(grantA)}`);
    assert.equal(g.state, 'AUTHORIZED');
    assert.equal(g.request.operationParam.maxEirp, 10);

    const hb = (id: string, grant: string) => post('/sas/heartbeat', { heartbeatRequest: [{ cbsdId: id, grantId: grant, operationState: 'AUTHORIZED' }] })
      .then((r) => r.body.heartbeatResponse[0]);
    assert.equal((await post(`/grants/${enc(grantA)}/suspend`)).suspended, true);
    assert.equal((await hb(cbsdA, grantA)).response.responseCode, 501);
    assert.equal((await post(`/grants/${enc(grantA)}/resume`)).suspended, false);
    assert.equal((await hb(cbsdA, grantA)).response.responseCode, 0);

    const expiry = new Date(Date.now() + 3600e3).toISOString();
    const u = await patch(`/grants/${enc(grantA)}`, {
      heartbeatInterval: 30, suggestedOperationParam: { maxEirp: 5, operationFrequencyRange: { lowFrequency: 3550e6, highFrequency: 3560e6 } }, grantExpireTime: expiry,
    });
    assert.equal(u.pendingHeartbeatInterval, 30);
    assert.equal(u.suggestedOperationParam.maxEirp, 5);
    assert.equal(u.grantExpireTime, Math.floor(Date.parse(expiry) / 1000) * 1000);
    const next = await hb(cbsdA, grantA);
    assert.equal(next.heartbeatInterval, 30);
    await patch(`/grants/${enc(grantA)}`, { suggestedOperationParam: null, heartbeatInterval: null });

    const t = await post(`/grants/${enc(grantB)}/terminate`, { reason: 'api test' });
    assert.equal(t.state, 'TERMINATED');
    assert.equal(t.endReason, 'api test');
    assert.equal((await hb(cbsdB, grantB)).response.responseCode, 500);
    await fails('POST', `/grants/${enc(grantB)}/suspend`, 409, 'conflict');
    await fails('GET', '/grants/nope', 404, 'not_found');
    assert.ok((await del('/grants/ended', 200)).deleted >= 1);
    await fails('GET', `/grants/${enc(grantB)}`, 404, 'not_found');
  });

  it('deregisters and deletes CBSDs', async () => {
    const tlsId = cbsdIdFor(FCC, 'SN-TLS');
    assert.equal((await post(`/cbsds/${enc(cbsdB)}/deregister`)).pendingDeregister, true);
    const r = await post('/sas/heartbeat', { heartbeatRequest: [{ cbsdId: cbsdB, grantId: 'x', operationState: 'GRANTED' }] });
    assert.equal(r.body.heartbeatResponse[0].response.responseCode, 105);
    await fails('POST', `/cbsds/${enc(cbsdB)}/deregister`, 409, 'conflict');
    assert.equal((await post(`/cbsds/${enc(tlsId)}/deregister`, { mode: 'immediate' })).state, 'UNREGISTERED');
    await fails('PATCH', `/cbsds/${enc(tlsId)}`, 409, 'conflict', { pendingDeregister: true });
    await del(`/cbsds/${enc(tlsId)}`);
    await fails('DELETE', `/cbsds/${enc(tlsId)}`, 404, 'not_found');
  });

  // ------------------------------------------------------------------------------- spectrum
  it('shows the spectrum and manages protections', async () => {
    const sp = await get('/spectrum');
    assert.ok(sp.band.low < sp.band.high);
    assert.ok(sp.grants.some((g: any) => g.grantId === grantA));
    assert.ok(sp.cbsds.some((c: any) => c.cbsdId === cbsdA));

    const p = await call('POST', '/protections', { body: { name: 'Band block', low: 3550e6, high: 3560e6, active: true, action: 'suspend' }, expect: 201 });
    const id = p.body.id;
    assert.match(id, /^ui:/);
    assert.equal(p.headers.get('location'), `/api/v1/protections/${enc(id)}`);
    const av = await get(`/cbsds/${enc(cbsdA)}/availability`);
    assert.ok(av.protections.some((x: any) => x.id === id));
    const hb = await post('/sas/heartbeat', { heartbeatRequest: [{ cbsdId: cbsdA, grantId: grantA, operationState: 'AUTHORIZED' }] });
    assert.equal(hb.body.heartbeatResponse[0].response.responseCode, 501);

    assert.equal((await post(`/protections/${enc(id)}/deactivate`)).active, false);
    const act = await post(`/protections/${enc(id)}/activate`, { channels: [[3555e6, 3560e6]] });
    assert.deepEqual(act.channels, [[3555e6, 3560e6]]);
    await fails('POST', `/protections/${enc(id)}/activate`, 400, 'bad_request', { channels: [[3560e6, 3555e6]] });
    assert.equal((await get('/protections?kind=ADMIN&active=true&source=ui')).total, 1);
    assert.equal((await get(`/protections/${enc(id)}`)).name, 'Band block');
    const pc = await call('PUT', '/protections/my-esc', { body: { name: 'ESC 1', kind: 'ESC', low: 3600e6, high: 3650e6, latitude: 36.9, longitude: -76.0, radiusKm: 40 }, expect: 201 });
    assert.equal(pc.body.kind, 'ESC');
    assert.equal((await put('/protections/my-esc', { name: 'ESC 1b', kind: 'ESC', low: 3600e6, high: 3650e6 })).name, 'ESC 1b');
    await fails('POST', '/protections', 400, 'bad_request', { name: 'x', low: 3600e6, high: 3550e6 });
    await fails('POST', '/protections', 409, 'conflict', { id, name: 'dup', low: 3550e6, high: 3560e6 });
    await fails('POST', '/protections', 400, 'validation_failed', { name: 'x', low: 1, high: 2, kind: 'GWPZ2' });
    await del(`/protections/${enc(id)}`);
    await del('/protections/my-esc');
    await fails('GET', '/protections/my-esc', 404, 'not_found');
    await post(`/grants/${enc(grantA)}/resume`);
  });

  it('loads and switches DPAs', async () => {
    const loaded = await post('/dpas/load', { file: 'E-DPAs.kml' });
    assert.ok(loaded.loaded > 10);
    const list = await get('/dpas?limit=5');
    assert.equal(list.total, loaded.loaded);
    assert.deepEqual(list.files, ['E-DPAs.kml', 'P-DPAs.kml']);
    const name = list.items[0].name;
    const one = await post(`/dpas/${enc(name)}/channels/activate`, { lowFrequency: 3550e6, highFrequency: 3560e6 });
    assert.deepEqual([one.active, one.channels], [true, [[3550e6, 3560e6]]]);
    const off = await post(`/dpas/${enc(`dpa:${name}`)}/channels/deactivate`, { lowFrequency: 3550e6, highFrequency: 3560e6 });
    assert.equal(off.active, false);
    await fails('POST', '/dpas/NoSuchDpa/channels/activate', 404, 'not_found', { lowFrequency: 3550e6, highFrequency: 3560e6 });
    assert.equal((await post('/dpas/activate-all')).active, loaded.loaded);
    assert.equal((await get('/dpas?active=true')).total, loaded.loaded);
    assert.equal((await post('/dpas/deactivate-all')).active, 0);
    await fails('POST', '/dpas/load', 400, 'validation_failed', { file: '../etc/passwd' });
    assert.equal((await del('/dpas', 200)).deleted, loaded.loaded);
  });

  it('injects incumbents and derives protections and PPAs from them', async () => {
    const pt = (lat: number, lon: number, lo: number, hi: number) => [{ installationParam: { latitude: lat, longitude: lon }, operationParam: { operationFrequencyRange: { lowFrequency: lo, highFrequency: hi } } }];
    const square = { type: 'Polygon', coordinates: [[[-98.6, 38.9], [-98.4, 38.9], [-98.4, 39.1], [-98.6, 39.1], [-98.6, 38.9]]] };
    const bodies: Record<string, any> = {
      wisp: { record: { id: 'wisp/lab/1', deploymentParam: pt(39.0, -98.5, 3650e6, 3700e6) } },
      fss: { record: { id: 'fss/lab/1', deploymentParam: pt(39.1, -98.6, 3600e6, 4200e6) }, ttc: false },
      pal: { palId: 'pal/lab/1', userId: 'lab-user', channelAssignment: { primaryAssignment: { lowFrequency: 3550e6, highFrequency: 3560e6 } }, license: { licenseExpiration: '2035-01-01T00:00:00Z' } },
      zone: { record: { usage: 'PPA', name: 'Harness PPA', zone: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: square }] }, ppaInfo: { palId: ['pal/lab/1'], cbsdReferenceId: [] } } },
      exclusion_zone: { zone: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: square }] }, frequencyRanges: [{ lowFrequency: 3650e6, highFrequency: 3660e6 }] },
      peer_sas: { url: `${stubUrl}/peer`, certificateHash: 'abc' },
      esc_sensor: { record: { id: 'esc/lab/1' } },
      sas_admin: { record: { id: 'admin/lab/1' } },
      fad_cbsd: { id: 'cbsd/PEER-FCC/0123', grants: [] },
      database_url: { type: 'FCC_ID', url: 'https://db.example/fcc' },
    };
    const ids: Record<string, string> = {};
    for (const [kind, body] of Object.entries(bodies)) {
      const r = await call('POST', `/incumbents/${kind}`, { body, expect: 201 });
      ids[kind] = r.body.id;
      assert.equal(r.body.kind, kind);
      assert.equal(r.headers.get('location'), `/api/v1/incumbents/${kind}/${enc(r.body.id)}`);
    }
    assert.equal((await get('/incumbents')).total, 10);
    assert.equal((await get('/incumbents?kind=pal')).items[0].id, 'pal/lab/1');
    assert.equal((await get(`/incumbents/fss/${enc('fss/lab/1')}`)).data.ttc, false);
    assert.equal((await get('/protections?kind=FSS_GWBL')).total, 1);
    assert.equal((await get('/protections?kind=EXCLUSION_ZONE&source=harness')).total, 1);
    const harnessPpa = (await get('/ppas?source=harness')).items[0];
    assert.deepEqual(harnessPpa.channels.map((c: any) => c.palId), ['pal/lab/1']);
    await fails('POST', '/incumbents/fss', 400, 'bad_request', { record: {} });
    await fails('POST', '/incumbents/martian', 400, 'validation_failed', {});
    const sp = await get('/spectrum');
    assert.equal(sp.incumbents.pal.length, 1);

    // A PPA from the PAL record, with the registered CBSD as its cluster.
    const fromPal = await call('POST', '/ppas/from-pal', { body: { cbsdIds: [cbsdA], palIds: ['pal/lab/1'] }, expect: 201 });
    assert.deepEqual(fromPal.body.members, [cbsdA]);
    await fails('POST', '/ppas/from-pal', 400, 'operation_failed', { cbsdIds: [cbsdA], palIds: ['pal/none'] });
    await del(`/ppas/${enc(fromPal.body.id)}`);

    await del(`/incumbents/wisp/${enc('wisp/lab/1')}`);
    assert.equal((await get('/protections?kind=FSS_GWBL')).total, 0);
    for (const [kind, id] of Object.entries(ids)) if (kind !== 'wisp') await del(`/incumbents/${kind}/${enc(id)}`);
    assert.equal((await get('/incumbents')).total, 0);
    await fails('DELETE', '/incumbents/fss/nope', 404, 'not_found');
    assert.equal((await get('/ppas?source=harness')).total, 0);
  });

  it('manages operator PPAs', async () => {
    const body = { name: 'Lab PPA', channels: [{ low: 3550e6, high: 3560e6, palId: 'pal/x', licenseExpiration: '2035-01-01T00:00:00Z' }], members: [cbsdA], expiration: Date.now() + 86400e3 };
    const c = await call('POST', '/ppas', { body, expect: 201 });
    const id = c.body.id;
    assert.equal(c.body.channels[0].licenseExpiration, Date.parse('2035-01-01T00:00:00Z'));
    assert.equal((await get(`/ppas/${enc(id)}`)).name, 'Lab PPA');
    assert.equal((await put(`/ppas/${enc(id)}`, { ...body, name: 'Renamed' })).name, 'Renamed');
    assert.equal((await call('PUT', '/ppas/zone%2Fppa%2Fmine', { body: { name: 'Mine', channels: [{ low: 3560e6, high: 3570e6 }] }, expect: 201 })).body.id, 'zone/ppa/mine');
    assert.equal((await get('/ppas?source=ui')).total, 2);
    await fails('POST', '/ppas', 409, 'conflict', { ...body, id: c.body.id });
    await fails('POST', '/ppas', 400, 'validation_failed', { name: 'x', channels: [] });
    await fails('POST', '/ppas', 400, 'bad_request', { name: 'x', channels: [{ low: 3570e6, high: 3560e6 }] });
    await del(`/ppas/${enc(id)}`);
    await del('/ppas/zone%2Fppa%2Fmine');
    await fails('DELETE', '/ppas/zone%2Fppa%2Fmine', 404, 'not_found');
  });

  // ------------------------------------------------------------------------------- faults
  it('injects faults on the listener, not on internal requests', async () => {
    const f = await call('POST', '/faults', { body: { name: 'HB 501', method: 'heartbeat', action: 'response_code', responseCode: 501, matchCbsd: 'SN-A', remaining: 1 }, expect: 201 });
    const id = f.body.id;
    assert.equal(f.headers.get('location'), `/api/v1/faults/${id}`);
    const hbBody = { heartbeatRequest: [{ cbsdId: cbsdA, grantId: grantA, operationState: 'AUTHORIZED' }] };
    assert.equal((await post('/sas/heartbeat', hbBody)).body.heartbeatResponse[0].response.responseCode, 0); // internal: no faults
    assert.equal((await post('/sas/heartbeat?transport=http', hbBody)).body.heartbeatResponse[0].response.responseCode, 501);
    const after1 = await get(`/faults/${id}`);
    assert.deepEqual([after1.hits, after1.remaining], [1, 0]);
    assert.equal((await post('/sas/heartbeat?transport=http', hbBody)).body.heartbeatResponse[0].response.responseCode, 0);

    const h = await post('/faults', { method: 'spectrumInquiry', action: 'http_status', httpStatus: 503, responseData: { error: 'busy' } }, 201);
    const siq = await post('/sas/spectrumInquiry?transport=http', { spectrumInquiryRequest: [{ cbsdId: cbsdA, inquiredSpectrum: [{ lowFrequency: 3550e6, highFrequency: 3560e6 }] }] });
    assert.deepEqual([siq.httpStatus, siq.body], [503, { error: 'busy' }]);
    assert.equal((await patch(`/faults/${h.id}`, { enabled: false })).enabled, false);
    const replaced = await put(`/faults/${h.id}`, { method: 'grant', action: 'delay', delayMs: 10 });
    assert.deepEqual([replaced.method, replaced.action, replaced.enabled, replaced.delayMs], ['grant', 'delay', true, 10]);
    // A listener that does not answer in time: the call reports the timeout instead of hanging.
    const slow = await post('/faults', { method: 'heartbeat', action: 'delay', delayMs: 1500 }, 201);
    const late = await post('/sas/heartbeat?transport=http&timeoutMs=200', hbBody);
    assert.equal(late.httpStatus, null);
    assert.match(late.error, /No response within 200 ms/);
    await del(`/faults/${slow.id}`);
    await post('/faults', { action: 'patch', responseData: { heartbeatInterval: 5 }, enabled: false }, 201);
    assert.equal((await get('/faults?enabled=false')).total, 1);
    assert.equal((await get('/faults?method=grant')).total, 2); // the grant rule and the * rule
    await fails('POST', '/faults', 400, 'validation_failed', { action: 'response_code' });
    await fails('POST', '/faults', 400, 'validation_failed', { action: 'patch', responseData: [1] });
    await fails('POST', '/faults', 400, 'validation_failed', { action: 'http_status' });
    await fails('POST', '/faults', 400, 'validation_failed', { action: 'delay' });
    await fails('PATCH', `/faults/${h.id}`, 400, 'validation_failed', { action: 'response_code', responseCode: null });
    await fails('PUT', '/faults/99999', 404, 'not_found', { action: 'drop' });
    await del(`/faults/${id}`);
    await fails('DELETE', `/faults/${id}`, 404, 'not_found');
    assert.equal((await del('/faults', 200)).deleted, 2);
  });

  // ------------------------------------------------------------------------------- logs
  it('queries, pages, exports and deletes log entries', async () => {
    const page1 = await get('/messages?limit=2');
    assert.equal(page1.order, 'desc');
    assert.equal(page1.items.length, 2);
    const page2 = await get(`/messages?limit=2&before=${page1.next}`);
    assert.ok(page2.items[0].id < page1.items[1].id + 1);
    const asc = await get('/messages?after=0&limit=3');
    assert.equal(asc.order, 'asc');
    assert.ok(asc.items[0].id < asc.items[1].id);
    assert.equal(asc.next, asc.items[2].id);
    // Polling: the cursor survives a poll with nothing new.
    const idle = await get('/messages?after=999999');
    assert.deepEqual([idle.items.length, idle.next], [0, 999999]);
    assert.ok((await get('/messages?method=heartbeat&transport=internal')).items.every((m: any) => m.method === 'heartbeat' && m.transport === 'internal'));
    assert.ok((await get('/messages?code=501')).items.length >= 1);
    assert.ok((await get('/messages?errors=true')).items.length >= 1);
    assert.ok((await get('/messages?httpStatus=503')).items.length >= 1);
    assert.ok((await get(`/messages?cbsdId=${enc(cbsdA)}&q=heartbeatRequest`)).items.length >= 1);
    // The activity chart counts them, failures included (the fault test's 501 heartbeat).
    assert.ok((await get('/activity')).rows.some((r: any) => r.method === 'heartbeat' && r.count >= 1 && r.errors >= 1));
    assert.equal((await get(`/messages?since=${new Date(Date.now() + 60e3).toISOString()}`)).items.length, 0);
    assert.ok((await get(`/messages?remoteAddr=api&until=${Date.now() + 1000}`)).items.length >= 1);
    const m = await get(`/messages/${page1.items[0].id}`);
    assert.ok(m.request !== undefined && m.response !== undefined);
    await del(`/messages/${page1.items[0].id}`);
    await fails('GET', `/messages/${page1.items[0].id}`, 404, 'not_found');

    const nd = await call('GET', '/messages/export?method=heartbeat&limit=5', { expect: 200 });
    assert.equal(nd.headers.get('content-type'), 'application/x-ndjson');
    const lines = nd.text.trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.length >= 1 && lines.length <= 5);
    assert.ok(lines.every((l: any) => l.method === 'heartbeat' && l.request));
    const js = await call('GET', '/messages/export?format=json&limit=3', { expect: 200 });
    assert.match(js.headers.get('content-disposition') ?? '', /sas-messages-.*\.json/);
    assert.equal(JSON.parse(js.text).length, 3);

    const ev = await get('/events?level=info,warn&limit=5');
    assert.ok(ev.items.length > 0 && ev.items.every((e: any) => ['info', 'warn'].includes(e.level)));
    assert.ok((await get('/events?category=admin&q=Protection')).items.length >= 1);
    assert.ok((await get(`/events?cbsdId=${enc(cbsdA)}`)).items.length >= 1);
    assert.ok((await get(`/events?grantId=${enc(grantA)}`)).items.length >= 1);
    assert.equal((await get(`/events/${ev.items[0].id}`)).id, ev.items[0].id);
    await fails('GET', '/events/999999', 404, 'not_found');
    const ee = await call('GET', '/events/export?level=warn', { expect: 200 });
    assert.ok(ee.text.trim().split('\n').every((l) => JSON.parse(l).level === 'warn'));
  });

  it('streams live events', async () => {
    const ctrl = new AbortController();
    const r = await fetch(`${base}/api/v1/stream?types=changed,event,message`, { headers: { Authorization: auth! }, signal: ctrl.signal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
    record(r.headers.get('x-operation-id'), r.status);
    const reader = r.body!.getReader();
    let text = '';
    const read = async (needle: RegExp) => {
      const end = Date.now() + 10000;
      while (!needle.test(text)) {
        if (Date.now() > end) throw new Error(`stream: no ${needle} in ${text}`);
        const { value } = await reader.read();
        text += Buffer.from(value!).toString('utf8');
      }
    };
    await read(/event: hello\ndata: \{.*"types":\["changed","event","message"\]/);
    await post('/registry/user-ids', { userId: 'stream-user' }, 201);
    await del('/registry/user-ids/stream-user');
    await put('/operations/measurement-triggers', { measInHeartbeat: false });
    await read(/event: event\ndata: .*Measurement report triggers/);
    await read(/event: changed\ndata: \{"what":"status"\}/);
    await post('/sas/heartbeat', { heartbeatRequest: [{ cbsdId: 'stream-cbsd', grantId: 'g', operationState: 'GRANTED' }] });
    await read(/event: message\ndata: .*"method":"heartbeat"/);
    // Stream items have the same shape as GET /events and GET /messages items.
    for (const [, type, data] of text.matchAll(/event: (event|message)\ndata: (.*)\n/g)) {
      const issues = validate({ $ref: `#/components/schemas/${type === 'event' ? 'Event' : 'Message'}` }, JSON.parse(data), doc.components.schemas);
      assert.deepEqual(issues, [], `stream ${type}: ${data}`);
    }
    ctrl.abort();

    const only = new AbortController();
    const r2 = await fetch(`${base}/api/v1/stream?types=changed`, { headers: { Authorization: auth! }, signal: only.signal });
    const r2text = await (async () => {
      const rd = r2.body!.getReader();
      let t = '';
      await put('/operations/measurement-triggers', { measInHeartbeat: false });
      const end = Date.now() + 10000;
      while (!/event: changed/.test(t) && Date.now() < end) t += Buffer.from((await rd.read()).value!).toString('utf8');
      return t;
    })();
    only.abort();
    assert.match(r2text, /event: changed/);
    assert.doesNotMatch(r2text, /event: (event|message)\n/);
    const h = await call('HEAD', '/stream', { expect: 200 });
    assert.equal(h.text, '');
  });

  // ------------------------------------------------------------------------------- operations
  it('runs daily activities, triggers, flags and listener operations', async () => {
    const st = await get('/operations/state');
    assert.equal(st.daily.running, false);
    const done = await post('/operations/daily-activities');
    assert.equal(done.completed, true);
    assert.ok(done.lastCompleted >= done.lastStarted);
    const started = await post('/operations/daily-activities?wait=false', undefined, 202);
    assert.equal(typeof started.running, 'boolean');
    await until(() => get('/operations/daily-activities'), (d: any) => d.completed);
    assert.equal((await post('/operations/daily-activities/schedule')).scheduled, true);
    assert.deepEqual(await put('/operations/measurement-triggers', { measInRegistration: true }), { measInRegistration: true, measInHeartbeat: false });
    assert.deepEqual(await get('/operations/measurement-triggers'), { measInRegistration: true, measInHeartbeat: false });
    const reg = await post('/sas/registration', { registrationRequest: [regRequest(FCC, 'SN-MEAS', { measCapability: ['RECEIVED_POWER_WITHOUT_GRANT'] })] });
    assert.deepEqual(reg.body.registrationResponse[0].measReportConfig, ['RECEIVED_POWER_WITHOUT_GRANT']);
    await put('/operations/measurement-triggers', { measInRegistration: false });
    const flags = await patch('/operations/flags', { escConnected: false, ntiaExclusionZones: true });
    assert.deepEqual([flags.flags.escConnected, flags.flags.ntiaExclusionZones], [false, true]);

    const l = await get('/listeners');
    assert.equal(l.http.listening, true);
    assert.equal((await post('/listeners/restart')).https.listening, true);
    assert.equal((await post('/listeners/reload-tls')).https.listening, true);
  });

  // ------------------------------------------------------------------------------- harness
  it('calls harness admin methods', async () => {
    const m = await get('/harness/methods');
    assert.equal(m.listenerAdminEnabled, true);
    assert.ok(m.methods.length > 30);
    assert.deepEqual(await post('/harness/injectdata/fcc_id', { fccId: 'HARN-FCC', fccMaxEirp: 30 }), { method: 'injectdata/fcc_id', result: null });
    assert.equal((await get('/registry/fcc-ids/HARN-FCC')).maxEirp, 30);
    assert.deepEqual((await post('/harness/get_daily_activities_status')).result, { completed: true });
    assert.deepEqual((await post('/harness/get_ppa_status')).result, { completed: true, withError: false });
    const z = await post('/harness/injectdata/exclusion_zone', { zone: { type: 'FeatureCollection', features: [] }, frequencyRanges: [] });
    assert.match(z.result, /^exclusion\//);
    await fails('POST', '/harness/injectdata/bogus', 404, 'not_found', {});
    await fails('POST', '/harness/query/propagation_and_antenna_model', 400, 'operation_failed', {});
    await fails('POST', '/harness/sas.cfg', 400, 'validation_failed', {});
    const msgs = await get('/messages?q=HARN-FCC');
    assert.ok(msgs.items.some((x: any) => x.method === 'admin/injectdata/fcc_id' && x.remoteAddr === 'api'));
    const cfg = await call('GET', '/harness/sas.cfg?host=sas.lab', { expect: 200 });
    assert.match(cfg.text, /AdminApiBaseUrl: sas\.lab:\d+/);
    assert.match(cfg.headers.get('content-disposition') ?? '', /sas\.cfg/);
    await fails('GET', '/harness/sas.cfg?host=a%20b', 400, 'validation_failed');
  });

  // ------------------------------------------------------------------------------- certificates
  it('builds a PKI: roots, sub-CAs and every kind of certificate', async () => {
    const root = await call('POST', '/certs/root', { body: { CN: 'API Test Root', O: 'Lab', C: 'US', keyType: 'ec256', days: 365 }, expect: 201 });
    assert.equal(root.body.kind, 'root');
    assert.equal(root.headers.get('location'), `/api/v1/certs/${root.body.id}`);
    const rid = root.body.id;
    const subs: Record<string, string> = {};
    for (const role of ['sas', 'cbsd', 'operator', 'installer']) {
      subs[role] = (await post('/certs/sub-ca', { parentId: rid, role, CN: `API ${role} CA`, keyType: 'ec256' }, 201)).id;
    }
    const before = (await get('/tls')).serverCertIds as string[];
    const srv = await post('/certs/server', { parentId: subs.sas, CN: 'sas.api.test', sans: ['sas.api.test', '127.0.0.1'], keyType: 'ec256', use: 'add' }, 201);
    assert.equal(srv.usage.serverCertificate, true);
    // "add" takes the place of the ECDSA certificate (one per key type); the RSA one stays, and HTTPS keeps working.
    const after = await get('/tls');
    assert.equal(after.serverCertIds.length, before.length);
    assert.ok(after.serverCertIds.includes(srv.id));
    assert.equal(after.listener.listening, true);
    const replacedEc = before.find((id) => !after.serverCertIds.includes(id))!;
    assert.ok(replacedEc);
    await fails('PUT', '/tls/server-certs', 400, 'validation_failed', { ids: [replacedEc, srv.id] });
    await fails('PATCH', '/settings', 400, 'validation_failed', { serverCertIds: [srv.id, replacedEc] });
    await fails('PUT', '/tls/server-certs', 400, 'validation_failed', { ids: [srv.id, srv.id] });
    const cb = await post('/certs/cbsd', { parentId: subs.cbsd, fccId: 'CERT-FCC', serial: 'SN-C1', keyType: 'ec256', registerFccId: true }, 201);
    assert.equal(cb.details.fccId, 'CERT-FCC');
    await get('/registry/fcc-ids/CERT-FCC');
    const dp = await post('/certs/domain-proxy', { parentId: subs.operator, CN: 'API Domain Proxy', frn: '0123456789', keyType: 'ec256' }, 201);
    assert.equal(dp.kind, 'domain_proxy');
    const inst = await post('/certs/installer', { parentId: subs.installer, cpiId: 'CPI-API', cpiName: 'API Installer', keyType: 'ec256' }, 201);
    assert.equal((await get('/registry/cpi-users/CPI-API')).name, 'API Installer');
    await fails('POST', '/certs/cbsd', 404, 'not_found', { parentId: 'nope', fccId: 'X', serial: 'Y' });
    await fails('POST', '/certs/sub-ca', 400, 'validation_failed', { parentId: rid, role: 'wizard', CN: 'x' });
    await fails('POST', '/certs/root', 400, 'validation_failed', { CN: 'x', C: 'USA' });

    const batch = await call('POST', '/certs/cbsd-batch', { body: { parentId: subs.cbsd, devices: [{ fccId: 'CERT-FCC', serial: 'B1' }, { fccId: 'CERT-FCC', serial: 'B2' }], keyType: 'ec256' }, expect: 200 });
    assert.equal(batch.headers.get('content-type'), 'application/zip');
    assert.equal(batch.buf.subarray(0, 2).toString(), 'PK');

    // Listing, filtering, reading, renaming.
    assert.ok((await get(`/certs?parentId=${rid}`)).total === 4);
    assert.ok((await get('/certs?kind=root&ca=true&hasKey=true')).items.some((c: any) => c.id === rid));
    assert.equal((await get('/certs?q=api%20domain')).items[0].id, dp.id);
    const d = await get(`/certs/${rid}`);
    assert.match(d.pem, /BEGIN CERTIFICATE/);
    assert.equal(d.children.length, 4);
    assert.equal((await patch(`/certs/${dp.id}`, { name: 'Renamed DP' })).name, 'Renamed DP');

    // CPI signing with the installer's key.
    const sig = await post('/cpi/sign', {
      installerCertId: inst.id, fccId: FCC, cbsdSerialNumber: 'SN-CATB',
      installationParam: { latitude: 39.0, longitude: -98.5, height: 10, heightType: 'AGL', indoorDeployment: false, antennaGain: 15, eirpCapability: 40 },
    });
    assert.ok(sig.cpiSignatureData.digitalSignature);
    assert.equal(sig.signedData.professionalInstallerData.cpiId, 'CPI-API');
    await fails('POST', '/cpi/sign', 400, 'bad_request', { fccId: 'x', cbsdSerialNumber: 'y', installationParam: {} });

    // Deletion rules.
    await fails('DELETE', `/certs/${rid}`, 409, 'conflict');
    await del(`/certs/${cb.id}`);
    await fails('GET', `/certs/${cb.id}`, 404, 'not_found');
    await put('/tls/server-certs', { ids: [srv.id] });
    await fails('DELETE', `/certs/${srv.id}`, 409, 'conflict');
    // Deleting a selected certificate removes it from the selection.
    const rsaAuto = before.find((id) => id !== replacedEc)!;
    await put('/tls/server-certs', { ids: [srv.id, rsaAuto] });
    await del(`/certs/${srv.id}`);
    const afterDelete = await get('/tls');
    assert.deepEqual(afterDelete.serverCertIds, [rsaAuto]);
    assert.equal(afterDelete.listener.listening, true);
    const tmpCa = await post('/certs/sub-ca', { parentId: rid, role: 'cbsd', CN: 'API temp CA', keyType: 'ec256' }, 201);
    await put('/tls/trusted-cas', { ids: [tmpCa.id] });
    await del(`/certs/${tmpCa.id}`);
    assert.deepEqual((await get('/tls')).trustedClientCaIds, []);
    const restored = await put('/tls/server-certs', { ids: autoServerIds });
    assert.deepEqual(restored.serverCertIds, autoServerIds);
  });

  it('downloads certificates in every format', async () => {
    const leaf = await post('/certs/cbsd', { parentId: cbsdCaId, fccId: FCC, serial: 'SN-DL' }, 201);
    const formats = (await get('/reference')).downloadFormats as Array<{ format: string; key: boolean }>;
    for (const { format } of formats) {
      const id = format === 'crl' ? cbsdCaId : leaf.id;
      const r = await call('GET', `/certs/${id}/download?format=${format}&password=secret`, { expect: 200 });
      assert.ok(r.buf.length > 100, format);
      assert.match(r.headers.get('content-disposition') ?? '', /attachment; filename=/);
      if (['pem', 'crt', 'chain', 'fullchain'].includes(format)) assert.match(r.text, /BEGIN CERTIFICATE/);
      if (format.startsWith('key')) assert.match(r.text, /PRIVATE KEY/);
      if (format === 'crl') assert.match(r.text, /BEGIN X509 CRL/);
      if (format === 'bundle') assert.equal(r.buf.subarray(0, 2).toString(), 'PK');
    }
    const head = await call('HEAD', `/certs/${leaf.id}/download`, { expect: 200 });
    assert.equal(head.text, '');
    await fails('GET', `/certs/${leaf.id}/download?format=crl`, 400, 'bad_request');
    await fails('GET', `/certs/${leaf.id}/download?format=exe`, 400, 'validation_failed');

    // Round trips: PEM and PKCS#12 imports.
    const pem = (await call('GET', `/certs/${leaf.id}/download?format=fullchain`, { expect: 200 })).text;
    const keyPem = (await call('GET', `/certs/${leaf.id}/download?format=key`, { expect: 200 })).text;
    const imp = await post('/certs/import', { pem, keyPem, name: 'Imported leaf' }, 201);
    assert.ok(imp.items.length >= 1);
    const p12 = (await call('GET', `/certs/${leaf.id}/download?format=p12&password=pw`, { expect: 200 })).buf;
    const ip = await post('/certs/import-p12', { data: base64(p12), password: 'pw', name: 'From p12' }, 201);
    assert.ok(ip.items.some((c: any) => c.hasKey));
    await fails('POST', '/certs/import', 400, 'operation_failed', { pem: 'not a certificate' });

    const bundle = await call('GET', '/trust-bundle', { expect: 200 });
    assert.ok((bundle.text.match(/BEGIN CERTIFICATE/g) ?? []).length >= 5);
    const roots = await call('GET', '/trust-bundle?which=roots', { expect: 200 });
    assert.ok((roots.text.match(/BEGIN CERTIFICATE/g) ?? []).length < (bundle.text.match(/BEGIN CERTIFICATE/g) ?? []).length);
  });

  it('revokes certificates, imports CRLs and configures TLS trust', async () => {
    const leaf = await post('/certs/cbsd', { parentId: cbsdCaId, fccId: FCC, serial: 'SN-REV' }, 201);
    assert.ok((await post(`/certs/${leaf.id}/revoke`)).revokedAt > 0);
    assert.equal((await get('/certs?revoked=true')).items.some((c: any) => c.id === leaf.id), true);
    const crlPem = (await call('GET', `/certs/${cbsdCaId}/download?format=crl`, { expect: 200 })).text;
    const imported = await post('/crls', { files: [{ name: 'CBSD CA CRL', data: base64(crlPem) }] }, 201);
    const crl = imported.items[0];
    assert.ok(crl.revokedCount >= 1);
    assert.equal((await get('/crls')).total, 1);
    assert.equal((await get(`/crls/${crl.id}`)).name, 'CBSD CA CRL');
    assert.match((await call('GET', `/crls/${crl.id}/download`, { expect: 200 })).text, /BEGIN X509 CRL/);
    await fails('POST', '/crls', 400, 'operation_failed', { files: [{ data: base64('garbage') }] });
    await del(`/crls/${crl.id}`);
    await fails('GET', `/crls/${crl.id}`, 404, 'not_found');
    await fails('DELETE', `/crls/${crl.id}`, 404, 'not_found');
    assert.equal((await post(`/certs/${leaf.id}/unrevoke`)).revokedAt, null);

    const tls = await get('/tls');
    assert.equal(tls.listener.listening, true);
    const t1 = await put('/tls/trusted-cas', { ids: [cbsdCaId] });
    assert.deepEqual(t1.trustedClientCaIds, [cbsdCaId]);
    assert.equal(t1.trustedClientCas[0].kind, 'sub_ca');
    assert.deepEqual((await put('/tls/trusted-cas', { ids: [] })).trustedClientCaIds, []);
    await fails('PUT', '/tls/trusted-cas', 400, 'validation_failed', { ids: ['nope'] });
    await fails('PUT', '/tls/server-certs', 400, 'validation_failed', { ids: [] });
    await fails('PUT', '/tls/server-certs', 400, 'validation_failed', { ids: [cbsdCaId + 'x'] });
    void installerCaId;
  });

  // ------------------------------------------------------------------------------- map
  it('serves the map configuration and offline tiles, and downloads tile sets', async () => {
    const m = await get('/map');
    assert.ok(m.store.sets.some((s: any) => s.id === 'folder'));
    assert.equal((await get('/map/tilesets')).total, 1);
    assert.equal((await get('/map/tilesets/folder')).format, 'png');
    const t = await call('GET', '/map/tilesets/folder/tiles/3/2/5', { expect: 200 });
    assert.equal(t.headers.get('content-type'), 'image/png');
    assert.deepEqual(t.buf, PNG);
    await fails('GET', '/map/tilesets/folder/tiles/3/2/6', 404, 'not_found');
    await fails('GET', '/map/tilesets/nope', 404, 'not_found');
    assert.equal((await post('/map/tilesets/rescan')).items.length, 1);
    assert.deepEqual(await get('/map/download'), { job: null });

    const est = await get('/map/download/estimate?bounds=-98.6,38.9,-98.3,39.1&minZoom=0&maxZoom=2');
    assert.ok(est.tiles >= 3 && est.allowed);
    await fails('GET', '/map/download/estimate?bounds=1,2,3&minZoom=0&maxZoom=2', 400, 'validation_failed');
    await fails('GET', '/map/download/estimate?bounds=-98.6,38.9,-98.3,39.1', 400, 'validation_failed');

    const job = await post('/map/download', { url: `${stubUrl}/t/{z}/{x}/{y}.png`, bounds: [-98.6, 38.9, -98.3, 39.1], minZoom: 0, maxZoom: 2, name: 'api-test', attribution: 'stub' }, 202);
    assert.equal(job.file, 'api-test.mbtiles');
    const done = await until(() => get('/map/download'), (j: any) => j.job.state !== 'running');
    assert.equal(done.job.state, 'done');
    assert.equal((await get('/map/tilesets/api-test.mbtiles')).format, 'png');
    assert.equal((await call('GET', '/map/tilesets/api-test.mbtiles/tiles/0/0/0', { expect: 200 })).buf.length, PNG.length);
    await fails('POST', '/map/download', 400, 'bad_request', { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', bounds: [-98.6, 38.9, -98.3, 39.1], minZoom: 0, maxZoom: 1 });
    await fails('POST', '/map/download', 400, 'bad_request', { url: 'https://x.example/{z}/{x}/{y}.png', bounds: [-125, 25, -66, 49], minZoom: 0, maxZoom: 18 });

    await post('/map/download', { url: `${stubUrl}/slow/{z}/{x}/{y}.png`, bounds: [-120, 30, -80, 45], minZoom: 3, maxZoom: 6, name: 'slow' }, 202);
    await fails('POST', '/map/download', 409, 'conflict', { url: `${stubUrl}/t/{z}/{x}/{y}.png`, bounds: [-98.6, 38.9, -98.3, 39.1], minZoom: 0, maxZoom: 1 });
    await fails('DELETE', '/map/tilesets/slow.mbtiles', 404, 'not_found'); // not in the store until finished
    const c = await del('/map/download', 200);
    assert.equal(c.cancelled, true);
    await until(() => get('/map/download'), (j: any) => j.job.state === 'cancelled');
    assert.equal((await del('/map/download', 200)).cancelled, false);

    await del('/map/tilesets/api-test.mbtiles');
    await del('/map/tilesets/folder');
    assert.equal((await get('/map/tilesets')).total, 0);
  });

  // ------------------------------------------------------------------------------- terrain
  it('reports terrain, computes elevation and HAAT, and downloads tiles', async () => {
    const t = await get('/terrain');
    assert.equal(t.tileCount, 1);
    assert.deepEqual(t.files.map((f: any) => f.name), ['n40w101']);
    assert.equal(t.source, stubUrl);
    assert.equal((await post('/terrain/rescan')).tileCount, 1);
    const e = await get('/terrain/elevation?lat=39.5&lon=-100.5');
    assert.equal(e.tile, 'n40w101');
    assert.ok(Math.abs(e.elevationM - 375) < 2, String(e.elevationM));
    assert.equal((await get('/terrain/elevation?lat=10.5&lon=-9.5')).elevationM, null);
    await fails('GET', '/terrain/elevation?lat=95&lon=0', 400, 'validation_failed');
    const h = await get('/terrain/haat?lat=39.5&lon=-100.5&height=10');
    assert.deepEqual(h.missingTiles, []);
    assert.ok(Math.abs(h.haatM - 10) < 2, String(h.haatM));
    const h2 = await get('/terrain/haat?lat=39.99&lon=-100.5&height=30&heightType=AMSL');
    assert.equal(h2.haatM, null);
    assert.ok(h2.missingTiles.includes('n41w101'));
    const need = await get('/terrain/tiles-needed?points=39.5,-100.5;39.99,-100.5');
    assert.ok(need.present.includes('n40w101') && need.missing.includes('n41w101'));
    assert.ok((await get('/terrain/tiles-needed?harness=true')).tiles.length > 20);
    await fails('GET', '/terrain/tiles-needed', 400, 'bad_request');
    assert.deepEqual(await get('/terrain/download'), { job: null });

    const job = await post('/terrain/download', { tiles: ['N10W010', 'n12w010'] }, 202);
    assert.deepEqual(job.tiles.map((x: any) => x.name), ['n10w010', 'n12w010']);
    const done = await until(() => get('/terrain/download'), (j: any) => j.job.state !== 'running');
    assert.equal(done.job.state, 'done');
    assert.deepEqual(done.job.tiles.map((x: any) => x.status), ['downloaded', 'unavailable']);
    assert.ok(fs.existsSync(path.join(terrainDir, 'USGS_1_n10w010.tif')));
    await post('/terrain/download', { tiles: ['n10w010'] }, 202);
    const again = await until(() => get('/terrain/download'), (j: any) => j.job.state !== 'running');
    assert.equal(again.job.tiles[0].status, 'present');
    await fails('POST', '/terrain/download', 400, 'validation_failed', { tiles: ['x1'] });
    await fails('POST', '/terrain/download', 400, 'bad_request', {});

    await post('/terrain/download', { tiles: ['n11w010'], around: [{ lat: 39.5, lon: -100.5 }] }, 202);
    await fails('POST', '/terrain/download', 409, 'conflict', { tiles: ['n10w010'] });
    assert.equal((await del('/terrain/download', 200)).cancelled, true);
    const c = await until(() => get('/terrain/download'), (j: any) => j.job.state !== 'running');
    assert.equal(c.job.state, 'cancelled');
    fs.rmSync(path.join(terrainDir, 'USGS_1_n10w010.tif'));

    // Tiles in subfolders count, as deep as the terrain index looks.
    const sub = path.join(terrainDir, 'region', 'kansas');
    fs.mkdirSync(sub, { recursive: true });
    fs.copyFileSync(path.join(terrainDir, 'floatn40w101_1_std.flt'), path.join(sub, 'floatn39w101_1_std.flt'));
    fs.writeFileSync(path.join(sub, 'floatn39w101_1_std.hdr'), fs.readFileSync(path.join(terrainDir, 'floatn40w101_1_std.hdr'), 'utf8').replace('yllcorner 39', 'yllcorner 38'));
    assert.equal((await post('/terrain/rescan')).tileCount, 2);
    assert.deepEqual((await get('/terrain')).files.map((f: any) => [f.name, f.file]),
      [['n39w101', path.join('region', 'kansas', 'floatn39w101_1_std.flt')], ['n40w101', 'floatn40w101_1_std.flt']]);
    assert.ok((await get('/terrain/tiles-needed?points=38.5,-100.5')).present.includes('n39w101'));
    fs.rmSync(path.join(terrainDir, 'region'), { recursive: true });
    assert.equal((await post('/terrain/rescan')).tileCount, 1);
  });

  // ------------------------------------------------------------------------------- configuration and data
  it('exports and imports the configuration and backs up the database', async () => {
    const dump = await get('/config/export');
    assert.ok(dump.fccIds.some((f: any) => f.fcc_id === FCC));
    assert.equal('uiPassword' in dump.settings, false);
    const file = await call('GET', '/config/export?download=true', { expect: 200 });
    assert.match(file.headers.get('content-disposition') ?? '', /sas-config-.*\.json/);

    const imp = await post('/config/import', {
      ...dump, settings: { ...dump.settings, heartbeatIntervalSec: 77, retiredSetting: true },
      fccIds: [...dump.fccIds, { fcc_id: 'IMPORTED-FCC', max_eirp: 33, created_at: Date.now() }],
    });
    assert.deepEqual(imp.settingsChanged, ['heartbeatIntervalSec']);
    assert.deepEqual(imp.settingsSkipped, ['retiredSetting']);
    assert.equal(imp.rows.fccIds, dump.fccIds.length + 1);
    assert.equal((await get('/registry/fcc-ids/IMPORTED-FCC')).maxEirp, 33);
    await fails('POST', '/config/import', 400, 'validation_failed', { fccIds: [{ fcc_id: 'X', 'max_eirp) VALUES (1); --': 1 }] });
    await fails('POST', '/config/import', 400, 'validation_failed', { settings: { heartbeatIntervalSec: 'often' } });
    await fails('POST', '/config/import', 400, 'validation_failed', { tables: [] });
    await put('/settings/heartbeatIntervalSec', { value: DEFAULT_SETTINGS.heartbeatIntervalSec });

    const backup = await call('GET', '/system/backup', { expect: 200 });
    assert.equal(backup.buf.subarray(0, 16).toString('latin1'), 'SQLite format 3\0');
    const f = path.join(sas.dataDir, 'backup-check.db');
    fs.writeFileSync(f, backup.buf);
    const copy = new DatabaseSync(f, { readOnly: true });
    assert.ok((copy.prepare('SELECT COUNT(*) AS n FROM certs').get() as any).n > 5);
    copy.close();
    assert.deepEqual(fs.readdirSync(sas.dataDir).filter((x) => x.startsWith('.backup-')), []);
  });

  it('reads any table with secrets redacted', async () => {
    const tables = await get('/data/tables');
    const names = tables.items.map((t: any) => t.name);
    for (const t of ['cbsds', 'grants', 'certs', 'msg_log', 'events', 'api_tokens', 'settings', 'users', 'sessions']) assert.ok(names.includes(t), t);
    const certs = await get('/data/tables/certs');
    assert.ok(certs.columns.some((c: any) => c.name === 'key_pem'));
    assert.match(certs.sql, /CREATE TABLE/);
    const rows = await get('/data/tables/certs/rows?column=kind&value=root&limit=1');
    assert.equal(rows.items[0].key_pem, '[redacted]');
    assert.equal(rows.items.length, 1);
    assert.ok(rows.total >= 2);
    const sorted = await get('/data/tables/fcc_ids/rows?order=fcc_id&desc=true');
    assert.ok(sorted.items[0].fcc_id >= sorted.items[sorted.items.length - 1].fcc_id);
    assert.ok((await get('/data/tables/cbsds/rows?column=notes&like=bench')).total >= 1);
    assert.equal((await get('/data/tables/cbsds/rows?column=notes&like=ben_h')).total, 0);
    assert.ok((await get('/data/tables/cbsds/rows?column=notes&isNull=true')).total >= 1);
    await fails('GET', '/data/tables/certs/rows?column=key_pem&like=BEGIN', 400, 'bad_request');
    await fails('GET', '/data/tables/api_tokens/rows?order=token_hash', 400, 'bad_request');
    await fails('GET', '/data/tables/cbsds/rows?column=nope&value=1', 400, 'bad_request');
    await fails('GET', '/data/tables/cbsds/rows?value=1', 400, 'bad_request');
    await fails('GET', '/data/tables/nope', 404, 'not_found');
    await fails('GET', '/data/tables/x%20y/rows', 400, 'validation_failed');
  });

  // ------------------------------------------------------------------------------- edge cases
  it('refuses malformed input on the less common paths', async () => {
    await fails('GET', '/cbsds/%E0%A4%A', 400, 'validation_failed');
    const foreign = await call('POST', '/faults', { body: { action: 'drop' }, headers: { Origin: 'null' }, expect: 403 });
    assert.equal(foreign.body.error.code, 'origin_not_allowed');
    assert.equal((await get('/faults?enabled=no')).total, 0);
    await fails('POST', '/registry/conditional', 400, 'bad_request', [{ fccId: 'API-FCC' }]);
    await fails('POST', '/incumbents/exclusion_zone', 400, 'bad_request', {});
    await fails('POST', '/incumbents/fad_cbsd', 400, 'bad_request', {});

    // A certificate without a private key: cannot be a TLS client certificate; can give a CPI key.
    const root = await post('/certs/root', { CN: 'Keyless', keyType: 'ec256', days: 30 }, 201);
    const pem = (await call('GET', `/certs/${root.id}/download?format=pem`, { expect: 200 })).text;
    await del(`/certs/${root.id}`);
    const [keyless] = (await post('/certs/import', { pem, name: 'Keyless' }, 201)).items;
    assert.equal(keyless.hasKey, false);
    const hb = { heartbeatRequest: [{ cbsdId: 'nope', grantId: 'nope', operationState: 'GRANTED' }] };
    await fails('POST', `/sas/heartbeat?transport=https&clientCertId=${keyless.id}`, 400, 'bad_request', hb);
    await fails('POST', '/sas/heartbeat?transport=https&clientCertId=missing', 404, 'not_found', hb);
    const cpi = await post('/registry/cpi-users', { cpiId: 'cpi-cert', name: 'From certificate', publicKey: pem }, 201);
    assert.match(cpi.publicKey, /BEGIN PUBLIC KEY/);
    await del('/registry/cpi-users/cpi-cert');
    await fails('POST', '/registry/cpi-users', 404, 'not_found', { cpiId: 'cpi-x', name: 'x', certId: 'missing' });
    const fromCert = await post('/registry/cpi-users', { cpiId: 'cpi-id', name: 'By certificate id', certId: keyless.id }, 201);
    assert.equal(fromCert.publicKey, cpi.publicKey);
    await del('/registry/cpi-users/cpi-id');
    await del(`/certs/${keyless.id}`);
    await fails('GET', '/faults?enabled=maybe', 400, 'validation_failed');
    await fails('GET', '/faults?toString=1', 400, 'validation_failed');
    const proto = await call('PATCH', '/settings', { raw: '{"__proto__": {"heartbeatIntervalSec": 1}}', expect: 400 });
    assert.equal(proto.body.error.code, 'validation_failed');
    assert.deepEqual((await post('/config/import', { settings: { toString: 1, constructor: 2 } })).settingsSkipped, ['toString', 'constructor']);
    // An import that fails part-way changes nothing, settings included.
    const hbBefore = (await get('/settings/heartbeatIntervalSec')).value;
    await fails('POST', '/config/import', 400, 'operation_failed', { settings: { heartbeatIntervalSec: hbBefore + 7 }, fccIds: [{ fcc_id: 'PARTIAL-FCC' }] });
    assert.equal((await get('/settings/heartbeatIntervalSec')).value, hbBefore);
    await fails('GET', '/registry/fcc-ids/PARTIAL-FCC', 404, 'not_found');
    await fails('GET', '/map/download/estimate?bounds=10,0,0,1&minZoom=1&maxZoom=2', 400, 'bad_request');
    const esc = await post('/incumbents/esc_sensor', { record: { id: 'esc/lab/1' } }, 201);
    assert.equal(esc.id, 'esc/lab/1');
    await del(`/incumbents/esc_sensor/${encodeURIComponent(esc.id)}`);
    const noId = await post('/incumbents/sas_admin', { name: 'no id given' }, 201);
    assert.match(noId.id, /^[0-9a-f-]{36}$/);
    await del(`/incumbents/sas_admin/${noId.id}`);

    // A reply that is not JSON comes back as text.
    const f = await post('/faults', { method: 'heartbeat', action: 'malformed' }, 201);
    const out = await post('/sas/heartbeat?transport=http', hb);
    assert.equal(typeof out.body, 'string');
    await del(`/faults/${f.id}`);
  });

  // ------------------------------------------------------------------------------- reset
  it('resets the SAS state', async () => {
    await fails('POST', '/operations/reset', 400, 'validation_failed', { confirm: 'yes' });
    assert.deepEqual(await post('/operations/reset', { confirm: 'RESET', clearLogs: true }), { reset: true, logsCleared: true });
    assert.equal((await get('/cbsds')).total, 0);
    assert.equal((await get('/registry/fcc-ids')).total, 0);
    assert.equal((await get('/operations/state')).flags.escConnected, true);
    assert.ok((await get('/messages')).items.length <= 2);
    assert.ok((await del('/messages', 200)).deleted >= 0);
    assert.ok((await del('/events', 200)).deleted >= 0);
  });

  // ------------------------------------------------------------------------------- auth, users, tokens, CORS
  const basicAs = (user: string, pw: string) => `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}`;
  const ADMIN_PW2 = 'admin pw 12';
  /** Signs in through the console form; returns the session cookie. */
  const login = async (username: string, password: string, expect = 200, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ username, password }) });
    const text = await r.text();
    assert.equal(r.status, expect, text);
    return { cookie: (r.headers.get('set-cookie') ?? '').split(';')[0], setCookie: r.headers.get('set-cookie') ?? '', body: JSON.parse(text) };
  };
  /** A console (/api/*) request with a session cookie. */
  const consoleApi = (p: string, cookie: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) =>
    fetch(`${base}${p}`, { method: init.method, body: init.body, headers: { Cookie: cookie, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
  const asCookie = (cookie: string) => ({ auth: null, headers: { Cookie: cookie } });
  const streamUntilHello = async (url: string, headers: Record<string, string>, hello = 'event: hello') => {
    const r = await fetch(url, { headers });
    assert.equal(r.status, 200);
    record(r.headers.get('x-operation-id'), r.status);
    const reader = r.body!.getReader();
    let got = '';
    while (!got.includes(hello)) got += Buffer.from((await reader.read()).value!).toString('utf8');
    return reader;
  };
  const streamEnds = (reader: ReadableStreamDefaultReader<Uint8Array>, ms: number) => Promise.race([
    (async () => { for (;;) if ((await reader.read()).done) return true; })(),
    sleep(ms).then(() => false),
  ]);

  it('creates, inspects and revokes API tokens', async () => {
    const t = await call('POST', '/tokens', { body: { name: 'reader', expiresInDays: 30 }, expect: 201 });
    assert.match(t.body.token, /^sasb_[A-Za-z0-9_-]{32}$/);
    assert.equal(t.body.scope, 'read');
    assert.deepEqual([t.body.userId, t.body.username], [1, 'admin']);
    assert.equal(t.headers.get('location'), `/api/v1/tokens/${t.body.id}`);
    const list = await get('/tokens');
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].token, undefined);
    assert.equal((await get(`/tokens/${t.body.id}`)).prefix, t.body.token.slice(0, 11));
    await fails('POST', '/tokens', 400, 'bad_request', { name: 'x', expiresInDays: 1, expiresAt: Date.now() + 1e6 });
    await fails('POST', '/tokens', 400, 'validation_failed', { name: 'x', expiresAt: '2001-01-01T00:00:00Z' });
    await fails('POST', '/tokens', 400, 'validation_failed', { name: 'x', scope: 'admin' });
    await fails('POST', '/tokens', 400, 'validation_failed', { name: 'x', userId: 999 });
    await del(`/tokens/${t.body.id}`);
    await fails('GET', `/tokens/${t.body.id}`, 404, 'not_found');
    await fails('DELETE', `/tokens/${t.body.id}`, 404, 'not_found');
  });

  it('manages users, roles, sessions and passwords', async () => {
    // The first-start admin, still on the default password.
    const [admin] = (await get('/users')).items;
    assert.deepEqual([admin.id, admin.username, admin.role, admin.enabled, admin.defaultPassword], [1, 'admin', 'admin', true, true]);
    assert.equal(JSON.stringify(admin).includes('scrypt'), false);

    // Create, read, change.
    const op = await call('POST', '/users', { body: { username: 'olivia', password: 'operator pw 1', role: 'operator', displayName: 'Olivia' }, expect: 201 });
    assert.equal(op.headers.get('location'), `/api/v1/users/${op.body.id}`);
    assert.deepEqual([op.body.role, op.body.defaultPassword, op.body.lastLoginAt], ['operator', false, null]);
    const olivia = op.body.id as number;
    const victor = (await post('/users', { username: 'victor', password: 'viewer pw 1', role: 'viewer' }, 201)).id as number;
    await fails('POST', '/users', 409, 'conflict', { username: 'OLIVIA', password: 'whatever pw', role: 'viewer' });
    const short = await fails('POST', '/users', 400, 'validation_failed', { username: 'shorty', password: 'short', role: 'viewer' });
    assert.equal(short.details[0].path, 'password');
    await fails('POST', '/users', 400, 'validation_failed', { username: 'has space', password: 'long enough', role: 'viewer' });
    await fails('POST', '/users', 400, 'validation_failed', { username: 'x', password: 'long enough', role: 'root' });
    assert.equal((await get(`/users/${olivia}`)).displayName, 'Olivia');
    await fails('GET', '/users/999', 404, 'not_found');
    assert.equal((await patch(`/users/${olivia}`, { displayName: 'Olivia O.' })).displayName, 'Olivia O.');
    await fails('PATCH', '/users/999', 404, 'not_found', { enabled: false });
    await fails('PATCH', `/users/${olivia}`, 400, 'validation_failed', { password: 'short' });

    // There is always an enabled admin, and nobody deletes their own account.
    const lastAdmin = await fails('PATCH', '/users/1', 409, 'conflict', { role: 'viewer' });
    assert.match(lastAdmin.message, /only enabled admin/);
    await fails('PATCH', '/users/1', 409, 'conflict', { enabled: false });
    await fails('DELETE', '/users/1', 409, 'conflict');
    await fails('DELETE', '/users/999', 404, 'not_found');

    // Console sign-in: an HttpOnly, SameSite=Strict session cookie; user names ignore case.
    const s1 = await login('Olivia', 'operator pw 1');
    assert.match(s1.setCookie, /^sasb_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
    assert.equal(s1.body.user.username, 'olivia');
    const me = await (await consoleApi('/api/auth/me', s1.cookie)).json() as any;
    assert.deepEqual([me.method, me.role, me.scope, me.user.id, me.authEnabled], ['session', 'operator', 'write', olivia, true]);
    const whoS = (await call('GET', '/auth/whoami', { ...asCookie(s1.cookie), expect: 200 })).body;
    assert.deepEqual([whoS.method, whoS.username, whoS.authEnabled], ['session', 'olivia', true]);
    const sessions = (await get(`/users/${olivia}/sessions`)).items;
    assert.equal(sessions.length, 1);
    assert.deepEqual([sessions[0].current, sessions[0].addr, sessions[0].id], [false, '127.0.0.1', undefined]);
    assert.equal((await call('GET', `/users/${olivia}/sessions`, { auth: null, headers: { Cookie: s1.cookie }, expect: 403 })).status, 403);
    assert.ok((await get(`/users/${olivia}`)).lastLoginAt > 0);
    await login('olivia', 'wrong password', 401);
    await login('nobody', 'wrong password', 401);
    assert.equal((await login('olivia', '', 400)).body.code, 'validation_failed');
    assert.equal((await fetch(`${base}/api/auth/login`, { method: 'POST', body: '{"username":' })).status, 400);
    assert.equal((await fetch(`${base}/api/auth/login`)).status, 405);
    assert.equal((await fetch(`${base}/api/auth/me`, { method: 'POST' })).status, 405);
    assert.equal((await login('olivia', 'operator pw 1', 403, { Origin: 'http://evil.example' })).body.code, 'origin_not_allowed');
    const anon = await fetch(`${base}/api/auth/me`);
    assert.deepEqual([anon.status, ((await anon.json()) as any).authEnabled], [401, true]);
    const sessionRows = (await get('/data/tables/sessions/rows')).items;
    assert.ok(sessionRows.length >= 1 && sessionRows.every((r: any) => r.id === '[redacted]'));
    assert.ok((await get('/data/tables/users/rows')).items.every((r: any) => r.password_hash === '[redacted]'));
    await fails('GET', '/data/tables/users/rows?order=password_hash', 400, 'bad_request');

    // Operators run the SAS but cannot manage users.
    await call('POST', '/registry/user-ids', { ...asCookie(s1.cookie), body: { userId: 'by-olivia' }, expect: 201 });
    await call('GET', '/users', { ...asCookie(s1.cookie), expect: 403 });
    await call('GET', '/data/tables/users/rows', { ...asCookie(s1.cookie), expect: 403 });
    assert.equal((await consoleApi('/api/status', s1.cookie)).status, 200);
    assert.equal((await consoleApi('/api/registry/user-ids', s1.cookie, { method: 'POST', body: '{"userId":"console-olivia"}' })).status, 200);
    // Console changes must come from the console itself (no cross-site request forgery).
    const csrf = await consoleApi('/api/registry/user-ids', s1.cookie, { method: 'POST', body: '{"userId":"csrf"}', headers: { Origin: 'http://evil.example' } });
    assert.deepEqual([csrf.status, ((await csrf.json()) as any).code], [403, 'origin_not_allowed']);
    const sameSite = await consoleApi('/api/registry/user-ids', s1.cookie, { method: 'POST', body: '{"userId":"csrf"}', headers: { 'Sec-Fetch-Site': 'same-site' } });
    assert.equal(sameSite.status, 403);
    const opaque = await consoleApi('/api/registry/user-ids', s1.cookie, { method: 'POST', body: '{"userId":"csrf"}', headers: { Origin: 'null' } });
    assert.equal(opaque.status, 403); // sandboxed frames and file:// pages send "Origin: null"
    assert.equal((await consoleApi('/api/auth/nope', s1.cookie)).status, 404);
    assert.equal((await get('/registry/user-ids')).items.some((u: any) => u.userId === 'csrf'), false);
    await del('/registry/user-ids/by-olivia');
    await del('/registry/user-ids/console-olivia');

    // The console's data needs a signed-in user, without a browser password dialog.
    const noAuth = await fetch(`${base}/api/status`);
    assert.deepEqual([noAuth.status, noAuth.headers.get('www-authenticate'), ((await noAuth.json()) as any).code], [401, null, 'unauthorized']);
    assert.equal((await fetch(`${base}/api/status`, { headers: { Cookie: 'sasb_session=forged' } })).status, 401);

    // Viewers read everything except private keys, backups, users and other people's keys.
    const V = basicAs('victor', 'viewer pw 1');
    assert.equal((await call('GET', '/auth/whoami', { auth: V, expect: 200 })).body.role, 'viewer');
    await call('GET', '/cbsds', { auth: V, expect: 200 });
    const vDenied = await call('POST', '/faults', { auth: V, body: { action: 'drop' }, expect: 403 });
    assert.match(vDenied.body.error.message, /viewers have read-only access/);
    await call('GET', '/system/backup', { auth: V, expect: 403 });
    await call('GET', '/users', { auth: V, expect: 403 });
    const keyCert = (await get('/certs?hasKey=true&limit=1')).items[0].id;
    await call('GET', `/certs/${keyCert}/download?format=key`, { auth: V, expect: 403 });
    assert.equal((await fetch(`${base}/api/status`, { headers: { Authorization: V } })).status, 200);
    const vWrite = await fetch(`${base}/api/registry/user-ids`, { method: 'POST', headers: { Authorization: V, 'Content-Type': 'application/json' }, body: '{"userId":"by-victor"}' });
    assert.deepEqual([vWrite.status, ((await vWrite.json()) as any).error], [403, 'Viewers have read-only access']);
    assert.equal((await fetch(`${base}/api/certs/${keyCert}/download?format=key`, { headers: { Authorization: V } })).status, 403);
    assert.equal((await fetch(`${base}/api/certs/${keyCert}/download?format=pem`, { headers: { Authorization: V } })).status, 200);

    // Keys belong to users: viewers get read keys; admins see every key and make keys for others.
    const vKey = (await call('POST', '/tokens', { auth: V, body: { name: 'victor read' }, expect: 201 })).body;
    assert.equal(vKey.username, 'victor');
    await call('POST', '/tokens', { auth: V, body: { name: 'victor write', scope: 'write' }, expect: 403 });
    await call('POST', '/tokens', { auth: V, body: { name: 'for admin', userId: 1 }, expect: 403 });
    const adminKey = await post('/tokens', { name: 'admin write', scope: 'write' }, 201);
    const forVictor = await post('/tokens', { name: 'service key', userId: victor }, 201);
    assert.equal(forVictor.username, 'victor');
    await fails('POST', '/tokens', 403, 'forbidden', { name: 'viewer write', scope: 'write', userId: victor });
    assert.deepEqual((await call('GET', '/tokens', { auth: V, expect: 200 })).body.items.map((t: any) => t.name).sort(), ['service key', 'victor read']);
    assert.ok((await get('/tokens')).items.length >= 3);
    await call('GET', `/tokens/${adminKey.id}`, { auth: V, expect: 404 });
    await call('DELETE', `/tokens/${adminKey.id}`, { auth: V, expect: 404 });
    assert.equal((await call('GET', `/tokens/${vKey.id}`, { auth: V, expect: 200 })).body.name, 'victor read');
    // Keys manage nothing: a key cannot create or revoke keys, or change a password.
    const AK = `Bearer ${adminKey.token}`;
    await call('POST', '/tokens', { auth: AK, body: { name: 'from a key' }, expect: 403 });
    await call('DELETE', `/tokens/${vKey.id}`, { auth: AK, expect: 403 });
    await call('POST', '/auth/password', { auth: AK, body: { currentPassword: 'admin', newPassword: 'whatever pw' }, expect: 403 });
    // A write key acts as its owner (an admin here); a read key as a viewer.
    await call('GET', '/users', { auth: AK, expect: 200 });
    await call('GET', '/users', { auth: `Bearer ${forVictor.token}`, expect: 403 });

    // Changing your own password keeps this session and ends the others.
    const s2 = await login('olivia', 'operator pw 1');
    const wrong = await call('POST', '/auth/password', { ...asCookie(s1.cookie), body: { currentPassword: 'nope nope', newPassword: 'operator pw 2' }, expect: 400 });
    assert.equal(wrong.body.error.details[0].path, 'currentPassword');
    const same = await call('POST', '/auth/password', { ...asCookie(s1.cookie), body: { currentPassword: 'operator pw 1', newPassword: 'operator pw 1' }, expect: 400 });
    assert.equal(same.body.error.details[0].path, 'newPassword');
    await call('POST', '/auth/password', { ...asCookie(s1.cookie), body: { currentPassword: 'operator pw 1', newPassword: 'operator pw 2' }, expect: 204 });
    assert.equal((await consoleApi('/api/status', s1.cookie)).status, 200);
    assert.equal((await consoleApi('/api/status', s2.cookie)).status, 401);
    await call('GET', '/status', { auth: basicAs('olivia', 'operator pw 1'), expect: 401 });
    const O = basicAs('olivia', 'operator pw 2');
    await call('GET', '/status', { auth: O, expect: 200 });

    // An open stream ends when its user's password is set by an admin; so do the user's sessions.
    const oStream = await streamUntilHello(`${base}/api/v1/stream`, { Authorization: O });
    await patch(`/users/${olivia}`, { password: 'operator pw 3' });
    assert.equal(await streamEnds(oStream, 5000), true, 'stream still open after the password was reset');
    assert.equal((await consoleApi('/api/status', s1.cookie)).status, 401);
    await call('GET', '/status', { auth: O, expect: 401 });

    // The admin changes their own (default) password.
    await call('POST', '/auth/password', { body: { currentPassword: 'admin', newPassword: ADMIN_PW2 }, expect: 204 });
    await call('GET', '/status', { expect: 401 }); // admin/admin no longer works
    auth = basicAs('admin', ADMIN_PW2);
    assert.equal((await get('/users/1')).defaultPassword, false);

    // Disabling a user stops their password and keys; enabling restores the keys.
    await patch(`/users/${victor}`, { enabled: false });
    assert.equal((await call('GET', '/status', { auth: V, expect: 401 })).body.error.code, 'account_disabled');
    assert.equal((await call('GET', '/status', { auth: `Bearer ${vKey.token}`, expect: 401 })).body.error.code, 'account_disabled');
    assert.equal((await login('victor', 'viewer pw 1', 403)).body.code, 'account_disabled');
    await patch(`/users/${victor}`, { enabled: true });
    await call('GET', '/status', { auth: `Bearer ${vKey.token}`, expect: 200 });

    // A key never has more access than its owner has now.
    const oKey = (await call('POST', '/tokens', { auth: basicAs('olivia', 'operator pw 3'), body: { name: 'olivia write', scope: 'write' }, expect: 201 })).body;
    const OK = `Bearer ${oKey.token}`;
    await call('POST', '/registry/user-ids', { auth: OK, body: { userId: 'olivia-key' }, expect: 201 });
    await patch(`/users/${olivia}`, { role: 'viewer' });
    const demoted = (await call('GET', '/auth/whoami', { auth: OK, expect: 200 })).body;
    assert.deepEqual([demoted.scope, demoted.role], ['read', 'viewer']);
    await call('DELETE', '/registry/user-ids/olivia-key', { auth: OK, expect: 403 });
    await patch(`/users/${olivia}`, { role: 'operator' });
    await call('DELETE', '/registry/user-ids/olivia-key', { auth: OK, expect: 204 });

    // Sign out: the cookie stops working, and so does the session's live stream (console and API).
    const s3 = await login('olivia', 'operator pw 3');
    const v1Stream = await streamUntilHello(`${base}/api/v1/stream`, { Cookie: s3.cookie });
    const consoleStream = await streamUntilHello(`${base}/api/stream`, { Cookie: s3.cookie }, 'retry:');
    const out = await consoleApi('/api/auth/logout', s3.cookie, { method: 'POST' });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie') ?? '', /^sasb_session=; .*Max-Age=0/);
    assert.equal(await streamEnds(v1Stream, 5000), true, 'API stream still open after sign-out');
    assert.equal(await streamEnds(consoleStream, 5000), true, 'console stream still open after sign-out');
    assert.equal((await consoleApi('/api/status', s3.cookie)).status, 401);
    assert.equal((await fetch(`${base}/api/auth/logout`, { method: 'POST' })).status, 200); // not signed in: nothing to do
    assert.equal((await fetch(`${base}/api/auth/logout`)).status, 405);

    // Sign a user out everywhere.
    const s4 = await login('olivia', 'operator pw 3');
    await login('olivia', 'operator pw 3');
    assert.deepEqual(await del(`/users/${olivia}/sessions`, 200), { revoked: 2 });
    assert.equal((await consoleApi('/api/status', s4.cookie)).status, 401);
    await fails('DELETE', '/users/999/sessions', 404, 'not_found');

    // Deleting a user deletes their keys and sessions.
    await del(`/users/${victor}`);
    await call('GET', '/status', { auth: `Bearer ${vKey.token}`, expect: 401 });
    await call('GET', '/status', { auth: `Bearer ${forVictor.token}`, expect: 401 });
    assert.equal((await get('/tokens')).items.some((t: any) => t.username === 'victor' || t.id === forVictor.id), false);
    await del(`/users/${olivia}`);
    await del(`/tokens/${adminKey.id}`);
    assert.deepEqual((await get('/users')).items.map((u: any) => u.username), ['admin']);
    assert.deepEqual((await get('/tokens')).items, []);
  });

  it('enforces authentication and API key scopes', async () => {
    const reader = (await post('/tokens', { name: 'reader', scope: 'read' }, 201)).token as string;
    const writerRec = await post('/tokens', { name: 'writer', scope: 'write' }, 201);
    const writer = writerRec.token as string;
    const ADMIN = auth!;

    // No credentials: 401 with challenges, Basic only for scripts (curl) and the address bar, not
    // for fetch() from a page (fetch sends Sec-Fetch-Mode: cors), so no browser dialog pops up.
    const r401 = await call('GET', '/status', { auth: null, expect: 401 });
    assert.equal(r401.body.error.code, 'unauthorized');
    assert.equal(r401.headers.get('www-authenticate'), 'Bearer realm="SASBench"');
    const challenge = (headers: Record<string, string>) => new Promise<string | undefined>((resolve, reject) => {
      http.get(`${base}/api/v1/status`, { headers }, (res) => {
        res.resume();
        resolve(res.headers['www-authenticate']);
      }).on('error', reject);
    });
    assert.equal(await challenge({}), 'Bearer realm="SASBench", Basic realm="SASBench", charset="UTF-8"');
    assert.equal(await challenge({ 'Sec-Fetch-Mode': 'navigate' }), 'Bearer realm="SASBench", Basic realm="SASBench", charset="UTF-8"');
    await call('GET', '/health', { auth: null, expect: 200 });
    await call('GET', '/openapi.json', { auth: null, expect: 200 });
    await call('GET', '/', { auth: null, expect: 200 });
    await call('GET', '/status', { auth: basicAs('admin', 'wrong'), expect: 401 });
    await call('GET', '/status', { auth: 'Bearer sasb_nope', expect: 401 });
    await call('GET', '/status', { auth: 'Digest username="admin"', expect: 401 });
    // A Bearer credential that is not an API key (e.g. forwarded by a proxy): the console ignores it
    // and uses the session; the API refuses it.
    const s = await login('admin', ADMIN_PW2);
    assert.equal((await fetch(`${base}/api/status`, { headers: { Authorization: 'Bearer some-oauth-token', Cookie: s.cookie } })).status, 200);
    await call('GET', '/status', { auth: 'Bearer some-oauth-token', expect: 401 });
    await consoleApi('/api/auth/logout', s.cookie, { method: 'POST' });

    // Read key: GETs only, and nothing that reveals private keys or accounts.
    const R = `Bearer ${reader}`;
    const who = (await call('GET', '/auth/whoami', { auth: R, expect: 200 })).body;
    assert.deepEqual([who.method, who.scope, who.role, who.tokenName, who.username], ['token', 'read', 'viewer', 'reader', 'admin']);
    await call('GET', '/status', { auth: R, expect: 200 });
    await call('GET', '/settings', { auth: R, expect: 200 });
    const denied = await call('POST', '/faults', { auth: R, body: { action: 'drop' }, expect: 403 });
    assert.equal(denied.body.error.code, 'forbidden');
    assert.match(denied.body.error.message, /this API key is read-only/);
    assert.equal((await call('GET', '/faults', { auth: R, expect: 200 })).body.total, 0); // nothing was created
    await call('GET', '/users', { auth: R, expect: 403 });
    await call('GET', '/system/backup', { auth: R, expect: 403 });
    const anyCert = (await call('GET', '/certs?hasKey=true&limit=1', { auth: R, expect: 200 })).body.items[0].id;
    await call('GET', `/certs/${anyCert}/download?format=pem`, { auth: R, expect: 200 });
    const keyDenied = await call('GET', `/certs/${anyCert}/download?format=key`, { auth: R, expect: 403 });
    assert.match(keyDenied.body.error.message, /private key/);
    await call('GET', '/data/tables/api_tokens/rows', { auth: R, expect: 403 });
    await call('GET', '/data/tables/users/rows', { auth: R, expect: 403 });
    assert.equal((await fetch(`${base}/api/status`, { headers: { Authorization: R } })).status, 200);
    const consoleDenied = await fetch(`${base}/api/registry/user-ids`, { method: 'POST', headers: { Authorization: R, 'Content-Type': 'application/json' }, body: '{"userId":"by-key"}' });
    assert.deepEqual([consoleDenied.status, ((await consoleDenied.json()) as any).error], [403, 'This API key is read-only']);
    const consoleWrite = await fetch(`${base}/api/registry/user-ids`, { method: 'POST', headers: { Authorization: `Bearer ${writer}`, 'Content-Type': 'application/json' }, body: '{"userId":"by-key"}' });
    assert.equal(consoleWrite.status, 200);
    await del('/registry/user-ids/by-key');

    // ?access_token only on the stream.
    const ctrl = new AbortController();
    const st = await fetch(`${base}/api/v1/stream?access_token=${reader}`, { signal: ctrl.signal });
    assert.equal(st.status, 200);
    ctrl.abort();
    await call('GET', `/status?access_token=${reader}`, { auth: null, expect: 401 }); // not accepted outside the stream
    await call('GET', '/stream?access_token=sasb_wrong', { auth: null, expect: 401 });

    // Write key can do everything its owner can; last use is recorded.
    auth = `Bearer ${writer}`;
    await post('/registry/user-ids', { userId: 'token-user' }, 201);
    const rec = await get(`/tokens/${writerRec.id}`);
    assert.ok(rec.lastUsedAt > 0);
    assert.equal(rec.lastUsedAddr, '127.0.0.1');
    assert.ok((await get('/data/tables/api_tokens/rows')).items.every((x: any) => x.token_hash === '[redacted]'));
    auth = ADMIN;

    // Revoking a key ends its open streams.
    const streamer = await post('/tokens', { name: 'streamer', scope: 'read' }, 201);
    const rd = await streamUntilHello(`${base}/api/v1/stream`, { Authorization: `Bearer ${streamer.token}` });
    await del(`/tokens/${streamer.id}`);
    assert.equal(await streamEnds(rd, 5000), true, 'stream still open after its key was revoked');
    // ... and so does expiry, at the next keep-alive.
    const expiring = await post('/tokens', { name: 'expiring', scope: 'read', expiresAt: new Date(Date.now() + 1500).toISOString() }, 201);
    const rdExp = await streamUntilHello(`${base}/api/v1/stream`, { Authorization: `Bearer ${expiring.token}` });
    assert.equal(await streamEnds(rdExp, 6000), true, 'stream still open after its key expired');

    // Expired and revoked keys stop working.
    const db = new DatabaseSync(path.join(sas.dataDir, 'sas.db'));
    db.prepare('UPDATE api_tokens SET expires_at = ? WHERE name = ?').run(Date.now() - 1000, 'reader');
    db.close();
    const exp = await call('GET', '/status', { auth: R, expect: 401 });
    assert.match(exp.body.error.message, /expired/);
    const readerId = (await get('/tokens')).items.find((x: any) => x.name === 'reader').id;
    await del(`/tokens/${readerId}`);
    await call('GET', '/status', { auth: R, expect: 401 });

    // Browser origins: cross-site writes are refused unless allowed.
    const evil = await call('POST', '/registry/user-ids', { body: { userId: 'csrf' }, headers: { Origin: 'http://evil.example' }, expect: 403 });
    assert.equal(evil.body.error.code, 'origin_not_allowed');
    await fails('GET', '/registry/user-ids/csrf', 404, 'not_found');
    const evilGet = await call('GET', '/status', { headers: { Origin: 'http://evil.example' }, expect: 200 });
    assert.equal(evilGet.headers.get('access-control-allow-origin'), null);
    await call('POST', '/registry/user-ids', { body: { userId: 'same-origin' }, headers: { Origin: base }, expect: 201 });
    const pre = await call('OPTIONS', '/registry/user-ids', { headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST' }, expect: 204 });
    assert.equal(pre.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.match(pre.headers.get('access-control-allow-methods') ?? '', /POST/);
    const allowed = await call('POST', '/registry/user-ids', { body: { userId: 'cors-user' }, headers: { Origin: ALLOWED_ORIGIN }, expect: 201 });
    assert.equal(allowed.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.match(allowed.headers.get('access-control-expose-headers') ?? '', /X-Request-Id/);
    await del(`/tokens/${writerRec.id}`);

    // DNS rebinding: a page whose own (attacker's) name resolves to this SAS is refused; scripts,
    // direct navigation, known names and allowed origins are not.
    const port = new URL(base).port;
    const rebind = `rebind.example:${port}`;
    const raw = async (method: string, p: string, headers: Record<string, string>, body?: string) => {
      const r = await new Promise<{ status: number; op: string | null; json: any }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: `/api/v1${p}`, headers: { Authorization: ADMIN, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
          let t = '';
          res.on('data', (c) => (t += c));
          res.on('end', () => resolve({ status: res.statusCode!, op: (res.headers['x-operation-id'] as string) ?? null, json: t ? JSON.parse(t) : null }));
        });
        req.on('error', reject);
        req.end(body);
      });
      record(r.op, r.status);
      return r;
    };
    const blocked = await raw('GET', '/status', { Host: rebind, 'Sec-Fetch-Site': 'same-origin' });
    assert.deepEqual([blocked.status, blocked.json.error.code], [403, 'host_not_allowed']);
    const blockedPost = await raw('POST', '/registry/user-ids', { Host: rebind, Origin: `http://${rebind}` }, '{"userId": "rebound"}');
    assert.deepEqual([blockedPost.status, blockedPost.json.error.code], [403, 'host_not_allowed']);
    await fails('GET', '/registry/user-ids/rebound', 404, 'not_found');
    assert.equal((await raw('GET', '/status', { Host: rebind })).status, 200); // a script
    assert.equal((await raw('GET', '/status', { Host: rebind, 'Sec-Fetch-Site': 'none' })).status, 200); // typed into the address bar
    assert.equal((await raw('GET', '/status', { Host: rebind, 'Sec-Fetch-Site': 'cross-site', Origin: ALLOWED_ORIGIN })).status, 200);
    assert.equal((await raw('GET', '/status', { Host: `localhost:${port}`, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
    assert.equal((await raw('GET', '/health', { Host: rebind, 'Sec-Fetch-Site': 'same-origin' })).status, 200); // public
    const garbled = await raw('GET', '/status', { Host: 'not a host', 'Sec-Fetch-Site': 'same-origin' });
    assert.deepEqual([garbled.status, garbled.json.error.code], [403, 'host_not_allowed']);
  });

  // ------------------------------------------------------------------------------- guards
  it('exercised every operation successfully', () => {
    const missing = [...ops.keys()].filter((id) => !succeeded.has(id));
    assert.deepEqual(missing, [], `operations never called successfully: ${missing.join(', ')}`);
  });

  it('every JSON response matched its documented schema', () => {
    assert.ok(validated > 400, `only ${validated} responses validated`);
    assert.deepEqual(schemaProblems, []);
    // The check is not vacuous: a wrong field type, a missing field and an extra field are caught.
    const cbsd = ops.get('getCbsd').responses[200].content['application/json'].schema;
    const issues = validate(cbsd, { cbsdId: 1, extra: true }, doc.components.schemas).map((i) => i.path);
    assert.ok(issues.includes('cbsdId') && issues.includes('extra') && issues.includes('fccId'), issues.join(', '));
  });

  it('every error status the server returned is documented for that operation', () => {
    const undocumented: string[] = [];
    for (const [id, st] of statuses) {
      const op = ops.get(id);
      for (const s of st) if (s >= 400 && !op.responses[s]) undocumented.push(`${id} ${s}`);
    }
    assert.deepEqual(undocumented, []);
  });
});
