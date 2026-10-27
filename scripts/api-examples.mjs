#!/usr/bin/env node
// Captures a real request and response for every REST API operation into docs/api-examples.json,
// which scripts/api-reference.mjs prints under each operation in docs/API-REFERENCE.md.
//
//   npm run api:examples      (then npm run api:docs)
//
// Starts a scratch SAS (temporary data directory and free ports, with stand-ins for a map tile
// server and the USGS terrain bucket) and works through the API the way an operator would: API
// keys and users, settings, registering and granting radios, CBSDs and grants, faults, logs, the
// registry, spectrum and incumbents, operations, certificates and TLS, map, terrain, configuration
// and raw data. The scratch instance's host name, addresses, ports and paths are replaced with
// those of a standard install (sas.lab.example, ports 8080/8000/8443, /data) so the examples read
// as one installation. Fails if an operation has no example or a call returns an unexpected status.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'docs', 'api-examples.json');
const { startSas, cbsdIdFor } = await import('../server/test/helpers.ts');
const { buildOpenApi } = await import('../server/src/api/v1/openapi.ts');

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const FQDN = 'sas.lab.example';
const TOPO_URL = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}';
const IMAGERY_URL = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}';
const USGS_BASE = 'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1/TIFF/current';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC', 'base64');
const ADMIN_PASSWORD = 'admin';
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MHz = 1e6;

// ---------------------------------------------------------------- scratch SAS and stand-ins

// A tile server (fast and slow) and the USGS terrain bucket (one tile, one that never finishes).
const stub = http.createServer((req, res) => {
  const u = req.url ?? '';
  if (/^\/t\/\d+\/\d+\/\d+\.png$/.test(u)) return res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG);
  if (/^\/slow\//.test(u)) return void setTimeout(() => res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG), 5000);
  if (u === '/n10w010/USGS_1_n10w010.tif') return res.writeHead(200, { 'Content-Type': 'image/tiff' }).end(Buffer.alloc(4096, 7));
  if (u === '/n11w010/USGS_1_n11w010.tif') return void setTimeout(() => res.writeHead(200).end(Buffer.alloc(16)), 8000);
  res.writeHead(404).end();
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubUrl = `http://127.0.0.1:${stub.address().port}`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sasbench-examples-'));
const dataDir = path.join(root, 'data');
const tilesDir = path.join(dataDir, 'tiles');
const terrainDir = path.join(dataDir, 'terrain');
fs.mkdirSync(path.join(tilesDir, 'lab-topo', '10', '163'), { recursive: true });
fs.writeFileSync(path.join(tilesDir, 'lab-topo', '10', '163', '396.png'), PNG);
// GridFloat tile n40w101 (39–40 N, 100–101 W): a gentle slope from 300 m to 450 m.
{
  const N = 150;
  fs.mkdirSync(terrainDir, { recursive: true });
  const flt = Buffer.alloc(N * N * 4);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) flt.writeFloatLE(300 + c, (r * N + c) * 4);
  fs.writeFileSync(path.join(terrainDir, 'floatn40w101_1_std.flt'), flt);
  fs.writeFileSync(path.join(terrainDir, 'floatn40w101_1_std.hdr'),
    `ncols ${N}\nnrows ${N}\nxllcorner -101\nyllcorner 39\ncellsize ${1 / N}\nNODATA_value -999999\nbyteorder LSBFIRST\n`);
}

const sas = await startSas({
  SAS_FQDN: FQDN, SAS_TILES_DIR: tilesDir, SAS_TERRAIN_DIR: terrainDir, SAS_TERRAIN_SOURCE_URL: stubUrl,
}, { dataDir });
const base = `http://127.0.0.1:${sas.uiPort}`;

// ---------------------------------------------------------------- making the capture read as a standard install

const PORTS = new Map([[sas.uiPort, 8080], [sas.httpPort, 8000], [sas.httpsPort, 8443]]);
const replacements = [
  [`${stubUrl}/t/{z}/{x}/{y}.png`, TOPO_URL],
  [`${stubUrl}/slow/{z}/{x}/{y}.png`, IMAGERY_URL],
  [stubUrl, USGS_BASE],
  [dataDir, '/data'],
  [root, '/data'],
];
const patterns = [
  ...[...PORTS].map(([from, to]) => [new RegExp(`:${from}(?!\\d)`, 'g'), `:${to}`]),
  [new RegExp(`\\b${os.hostname().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), 'sas-lab'],
  // The host's own addresses (they go into the server certificates) become documentation addresses.
  ...Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a, i) => [new RegExp(`\\b${a.address.replace(/\./g, '\\.')}\\b`, 'g'), `192.0.2.${10 + i}`]),
];
function scrub(s) {
  for (const [from, to] of replacements) s = s.split(from).join(to);
  for (const [re, to] of patterns) s = s.replace(re, to);
  return s;
}
function scrubJson(v, key = '') {
  if (typeof v === 'string') return scrub(v);
  if (typeof v === 'number') return /port/i.test(key) && PORTS.has(v) ? PORTS.get(v) : v;
  if (Array.isArray(v)) return v.map((x) => scrubJson(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k), scrubJson(x, k)]));
  return v;
}

// ---------------------------------------------------------------- shortening long responses

function shortString(s) {
  if (s.includes('-----BEGIN ')) return pemShort(s);
  return s.length > 140 ? `${s.slice(0, 100)}…` : s;
}
/** Each PEM block as its first line of base64 and the END line. */
function pemShort(s) {
  return s.replace(/(-----BEGIN [A-Z0-9 ]+-----)\r?\n([A-Za-z0-9+/=]{1,64})[A-Za-z0-9+/=\r\n]*?\r?\n(-----END [A-Z0-9 ]+-----)/g,
    (_, b, first, e) => `${b}\n${first.slice(0, 40)}…\n${e}`);
}
function trimDeep(v, items) {
  if (Array.isArray(v)) {
    const flat = v.every((x) => x === null || typeof x !== 'object');
    const keep = flat && v.length <= 8 ? v.length : items;
    const out = v.slice(0, keep).map((x) => trimDeep(x, items));
    if (v.length > keep) out.push(`… ${v.length - keep} more`);
    return out;
  }
  if (v && typeof v === 'object') {
    // Very wide objects (all the settings, say) keep their first 24 keys.
    const entries = Object.entries(v);
    const kept = entries.length > 28 ? [...entries.slice(0, 24), ['…', `${entries.length - 24} more`]] : entries;
    return Object.fromEntries(kept.map(([k, x]) => [k, trimDeep(x, items)]));
  }
  return typeof v === 'string' ? shortString(v) : v;
}
/** Containers nested `depth` deep become "{…}" / "[…]", unless they fit on a short line. */
function collapse(v, depth) {
  if (!v || typeof v !== 'object') return v;
  if (depth === 0) return inline(v).length <= 60 ? v : Array.isArray(v) ? '[…]' : '{…}';
  return Array.isArray(v) ? v.map((x) => collapse(x, depth - 1)) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, collapse(x, depth - 1)]));
}
function shape(v, { items = 2, lines = 60 } = {}) {
  let out = trimDeep(v, items);
  for (let depth = 6; depth >= 1 && pretty(out).split('\n').length > lines; depth--) out = collapse(trimDeep(v, items), depth);
  return out;
}
/** JSON with short arrays and objects kept on one line. */
function pretty(v, ind = '') {
  const one = inline(v);
  const wide = v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 5;
  if (one.length + ind.length <= 92 && !wide) return one;
  if (Array.isArray(v)) return `[\n${v.map((x) => `${ind}  ${pretty(x, `${ind}  `)}`).join(',\n')}\n${ind}]`;
  if (v && typeof v === 'object') return `{\n${Object.entries(v).map(([k, x]) => `${ind}  ${JSON.stringify(k)}: ${pretty(x, `${ind}  `)}`).join(',\n')}\n${ind}}`;
  return one;
}
function inline(v) {
  if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')}}`;
  return JSON.stringify(v) ?? 'null';
}
function shortText(t, maxLines = 14) {
  const lines = pemShort(t).replace(/\s+$/, '').split('\n').map((l) => (l.length > 160 ? `${l.slice(0, 120)}…` : l));
  return lines.length > maxLines ? [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`].join('\n') : lines.join('\n');
}

// ---------------------------------------------------------------- calling the API

let KEY = '';
let adminPassword = ADMIN_PASSWORD;
const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

async function call(method, p, o = {}) {
  const headers = { ...o.headers };
  const a = o.auth ?? 'key';
  if (a === 'key') headers.Authorization = `Bearer ${KEY}`;
  else if (a === 'basic') headers.Authorization = basic('admin', adminPassword);
  else if (typeof a === 'object') headers.Authorization = basic(a.user, a.pass);
  let body;
  if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${base}/api/v1${p}`, { method, headers, body });
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') ?? '';
  const text = buf.toString('utf8');
  const json = type.startsWith('application/json') && text ? JSON.parse(text) : undefined;
  const expect = o.expect ?? null;
  if (expect ? res.status !== expect : res.status >= 300) throw new Error(`${method} ${p} → ${res.status}: ${text.slice(0, 500)}`);
  return { status: res.status, type, headers: res.headers, body: json, text, buf };
}
/** A setup call that is not shown. Returns the JSON body. */
const quiet = async (method, p, body, o = {}) => (await call(method, p, { ...o, body })).body;

function curlFor(method, p, o) {
  const a = o.auth ?? 'key';
  const auth = a === 'none' ? null : a === 'key' ? '-H "Authorization: Bearer $KEY"' : a === 'basic' ? '-u "admin:$PASSWORD"' : `-u '${a.user}:${a.pass}'`;
  const head = [`curl -s${o.stream ? 'N' : ''}`, method === 'GET' ? null : `-X ${method}`].filter(Boolean).join(' ');
  const url = `"$API${p}"`;
  const out = o.save ? `-o ${o.save}` : null;
  if (o.body === undefined) {
    const one = [head, auth, out, url].filter(Boolean).join(' ');
    return one.length <= 110 ? one : `${head} ${url} \\\n  ${[auth, out].filter(Boolean).join(' ')}`;
  }
  const json = pretty(o.body, '  ').replace(/'/g, `'\\''`);
  return `${head} ${url} \\\n  ${[auth, "-H 'Content-Type: application/json'"].filter(Boolean).join(' ')} \\\n  -d '${json}'`;
}

const examples = {};
/**
 * Calls an operation and records it as an example. `save`: the file name for a download;
 * `trim`: {items, lines} for shortening the response; `note`: a sentence shown under it;
 * `curl`: the command to show instead of the generated one (for bodies built from files).
 */
async function ex(opId, title, method, p, o = {}) {
  const r = await call(method, p, o);
  const got = r.headers.get('x-operation-id');
  if (got !== opId) throw new Error(`${method} ${p} is ${got}, not ${opId}`);
  const e = { title, curl: scrub(o.curl ?? curlFor(method, p, o)), status: r.status };
  if (r.status === 204) e.kind = 'empty';
  else if (r.body !== undefined && !o.save) Object.assign(e, { kind: 'json', json: pretty(shape(scrubJson(r.body), o.trim)) });
  else if (!o.save && /^text\/|ndjson|pem/.test(r.type)) Object.assign(e, { kind: 'text', contentType: r.type.split(';')[0], text: shortText(scrub(r.text), o.trim?.lines) });
  else Object.assign(e, { kind: 'file', contentType: r.type.split(';')[0], bytes: r.buf.length, file: o.save ?? 'download' });
  if (o.note) e.note = o.note;
  (examples[opId] ??= []).push(e);
  return r.body;
}

// ---------------------------------------------------------------- protocol request bodies

const FCC = 'TEST-FCC';
const regA = (serial, extra = {}) => ({
  userId: 'lab-user', fccId: FCC, cbsdSerialNumber: serial, cbsdCategory: 'A',
  airInterface: { radioTechnology: 'E_UTRA' }, measCapability: [],
  installationParam: { latitude: 37.425, longitude: -122.084, height: 5, heightType: 'AGL', indoorDeployment: true, antennaGain: 5, eirpCapability: 26 },
  ...extra,
});
const grantReq = (cbsdId, lo, hi, maxEirp = 10) => ({ cbsdId, operationParam: { maxEirp, operationFrequencyRange: { lowFrequency: lo * MHz, highFrequency: hi * MHz } } });
const hbReq = (cbsdId, grantId, operationState) => ({ heartbeatRequest: [{ cbsdId, grantId, operationState }] });
const A = cbsdIdFor(FCC, 'SN-0001');
const B2 = cbsdIdFor(FCC, 'SN-0002');
const P3 = cbsdIdFor(FCC, 'SN-0003');
const CATB = cbsdIdFor('TEST-FCC-B', 'SN-B001');
let grantA = '';

// ================================================================== System
await ex('getHealth', 'Health check (no credentials)', 'GET', '/health', { auth: 'none' });
await ex('getApiIndex', null, 'GET', '/', { auth: 'none' });
await ex('getOpenApi', 'Download the OpenAPI description (for Postman, Insomnia or code generators)', 'GET', '/openapi.json', { auth: 'none', trim: { lines: 30 } });

// ================================================================== API keys
const created = await ex('createToken', 'Create a read-write key for a CI pipeline, valid for 90 days', 'POST', '/tokens', {
  auth: 'basic', body: { name: 'CI pipeline', scope: 'write', expiresInDays: 90 },
  note: 'Keys are created by people (user name and password, or the console), not by other keys. The `token` is shown only in this response.',
});
KEY = created.token;
const old = await quiet('POST', '/tokens', { name: 'Grafana dashboard', scope: 'read' }, { auth: 'basic' });
await ex('listTokens', null, 'GET', '/tokens');
await ex('getToken', null, 'GET', `/tokens/${old.id}`);
await ex('deleteToken', 'Revoke a key', 'DELETE', `/tokens/${old.id}`, { auth: 'basic' });
await ex('whoAmI', 'Who is this key?', 'GET', '/auth/whoami');

// ================================================================== System (credentials needed)
await ex('getStatus', null, 'GET', '/status');
await ex('getSystem', null, 'GET', '/system');
await ex('getActivity', 'Message counts for the last hour', 'GET', '/activity?minutes=60');
await ex('getReference', null, 'GET', '/reference', { trim: { items: 2, lines: 40 } });

// ================================================================== Users
const olivia = await ex('createUser', 'Add an operator', 'POST', '/users', {
  body: { username: 'olivia', password: 'correct horse 42', role: 'operator', displayName: 'Olivia Ortiz' },
});
await ex('listUsers', null, 'GET', '/users');
await ex('getUser', null, 'GET', `/users/${olivia.id}`);
await ex('updateUser', 'Make her read-only and fix the display name', 'PATCH', `/users/${olivia.id}`, { body: { displayName: 'Olivia O.', role: 'viewer' } });
// A console session for her, so there is one to list and end.
{
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0' },
    body: JSON.stringify({ username: 'olivia', password: 'correct horse 42' }),
  });
  if (r.status !== 200) throw new Error(`login → ${r.status}`);
}
await ex('listUserSessions', null, 'GET', `/users/${olivia.id}/sessions`);
await ex('revokeUserSessions', 'Sign her out everywhere', 'DELETE', `/users/${olivia.id}/sessions`);
await ex('changePassword', 'Change your own password (here, Olivia changes hers)', 'POST', '/auth/password', {
  auth: { user: 'olivia', pass: 'correct horse 42' }, body: { currentPassword: 'correct horse 42', newPassword: 'battery staple 77' },
  note: 'Needs a user name and password or a console session, not an API key. Your other console sessions are signed out.',
});
await ex('deleteUser', null, 'DELETE', `/users/${olivia.id}`);

// ================================================================== Settings
await ex('getSettings', null, 'GET', '/settings', { trim: { lines: 40 } });
await ex('getSettingsSchema', null, 'GET', '/settings/schema', { trim: { items: 2, lines: 40 } });
await ex('getSetting', null, 'GET', '/settings/heartbeatIntervalSec');
await ex('putSetting', 'Ask radios to heartbeat every 30 seconds', 'PUT', '/settings/heartbeatIntervalSec', { body: { value: 30 }, trim: { lines: 20 } });
await ex('updateSettings', 'Change several settings at once', 'PATCH', '/settings', { body: { heartbeatIntervalSec: 60, maxGrantsPerCbsd: 4 }, trim: { lines: 24 } });
await ex('listSettingsProfiles', null, 'GET', '/settings/profiles', { trim: { items: 3, lines: 40 } });
await ex('applySettingsProfile', 'Switch to the WInnForum strict profile', 'POST', '/settings/profiles/winnforum/apply', { trim: { lines: 24 } });
await ex('resetSettings', 'Back to the defaults (the lab profile)', 'POST', '/settings/reset', { trim: { lines: 24 } });

// ================================================================== Protocol: radios without a radio
const reg = await ex('sendSasRequest', 'Register a Category A radio (this creates the CBSD)', 'POST', '/sas/registration', {
  body: { registrationRequest: [regA('SN-0001')] },
  note: 'The body is exactly what a radio sends. The SAS\'s verdict is in `body`; a refused request is still HTTP 200 here.',
});
if (reg.body.registrationResponse[0].cbsdId !== A) throw new Error('unexpected cbsdId');
await ex('sendSasRequest', 'Ask which channels it may use', 'POST', '/sas/spectrumInquiry', {
  body: { spectrumInquiryRequest: [{ cbsdId: A, inquiredSpectrum: [{ lowFrequency: 3550 * MHz, highFrequency: 3700 * MHz }] }] },
});
const g = await ex('sendSasRequest', 'Request a grant: 3550–3560 MHz at 10 dBm/MHz', 'POST', '/sas/grant', {
  body: { grantRequest: [grantReq(A, 3550, 3560)] },
});
grantA = g.body.grantResponse[0].grantId;
await ex('sendSasRequest', 'Heartbeat: the grant becomes AUTHORIZED and may transmit until transmitExpireTime', 'POST', '/sas/heartbeat', {
  body: hbReq(A, grantA, 'GRANTED'),
});
await quiet('POST', '/sas/heartbeat', hbReq(A, grantA, 'AUTHORIZED'));
await ex('sendSasRequest', 'A Category B radio that sends no location waits at REG_PENDING', 'POST', '/sas/registration', {
  body: { registrationRequest: [{ userId: 'lab-user', fccId: 'TEST-FCC-B', cbsdSerialNumber: 'SN-B001', cbsdCategory: 'B', airInterface: { radioTechnology: 'E_UTRA' }, measCapability: [] }] },
  note: 'Preload its location (POST /registry/conditional) and it registers on its next attempt.',
});
await quiet('POST', '/sas/registration', { registrationRequest: [regA('SN-0002')] });
const g2 = await quiet('POST', '/sas/grant', { grantRequest: [grantReq(B2, 3560, 3570)] });
const grantB2 = g2.body.grantResponse[0].grantId;
await ex('sendSasRequest', 'Relinquish a grant', 'POST', '/sas/relinquishment', { body: { relinquishmentRequest: [{ cbsdId: B2, grantId: grantB2 }] } });
await ex('sendSasRequest', 'Deregister', 'POST', '/sas/deregistration', { body: { deregistrationRequest: [{ cbsdId: B2 }] } });

// ================================================================== CBSDs
await ex('listCbsds', 'Registered CBSDs', 'GET', '/cbsds?state=REGISTERED');
await ex('getCbsd', null, 'GET', `/cbsds/${enc(A)}`, { trim: { items: 1, lines: 60 } });
await ex('updateCbsd', 'Note the bench and cap its EIRP', 'PATCH', `/cbsds/${enc(A)}`, { body: { notes: 'Bench 3, firmware 25R2', eirpCapDbmMhz: 20 }, trim: { lines: 30 } });
await ex('getCbsdAvailability', null, 'GET', `/cbsds/${enc(A)}/availability`);
await ex('listCbsdGrants', null, 'GET', `/cbsds/${enc(A)}/grants`);
await ex('listCbsdEvents', null, 'GET', `/cbsds/${enc(A)}/events?limit=3`);
await ex('listCbsdMessages', null, 'GET', `/cbsds/${enc(A)}/messages?limit=2`, { trim: { items: 2, lines: 40 } });
await ex('addCbsdToRegistry', 'Keep its FCC ID, user ID and registration data in the registry', 'POST', `/cbsds/${enc(A)}/registry`, { body: {} });
// Manual approval: a new registration waits at REG_PENDING until approved.
await quiet('PATCH', '/settings', { manualApproval: true });
await quiet('POST', '/sas/registration', { registrationRequest: [regA('SN-0003')] });
await ex('approveCbsd', 'Approve a radio held by manual approval', 'POST', `/cbsds/${enc(P3)}/approve`, {
  trim: { lines: 30 }, note: 'Its next registration request then succeeds.',
});
await quiet('PATCH', '/settings', { manualApproval: false });
await quiet('POST', '/sas/registration', { registrationRequest: [regA('SN-0003')] });
await ex('deregisterCbsd', 'Send it 105 (DEREGISTER) at its next request', 'POST', `/cbsds/${enc(P3)}/deregister`, { trim: { lines: 30 } });
await ex('deleteCbsd', null, 'DELETE', `/cbsds/${enc(P3)}`);

// ================================================================== Grants
await ex('listGrants', 'Grants that may transmit', 'GET', '/grants?state=AUTHORIZED');
await ex('getGrant', null, 'GET', `/grants/${grantA}`, { trim: { lines: 50 } });
await ex('updateGrant', 'Tell the radio to heartbeat every 30 s from its next heartbeat', 'PATCH', `/grants/${grantA}`, { body: { heartbeatInterval: 30 }, trim: { lines: 30 } });
await ex('suspendGrant', 'Suspend: the next heartbeat gets 501 SUSPENDED_GRANT', 'POST', `/grants/${grantA}/suspend`, { trim: { lines: 30 } });
await ex('resumeGrant', null, 'POST', `/grants/${grantA}/resume`, { trim: { lines: 30 } });
const g3 = await quiet('POST', '/sas/grant', { grantRequest: [grantReq(A, 3570, 3580)] });
const grantA2 = g3.body.grantResponse[0].grantId;
await ex('terminateGrant', 'Terminate: the next heartbeat gets 500 TERMINATED_GRANT', 'POST', `/grants/${grantA2}/terminate`, { body: { reason: 'Interference test 4' }, trim: { lines: 30 } });
await ex('purgeEndedGrants', 'Delete terminated, relinquished and expired grants', 'DELETE', '/grants/ended');

// ================================================================== Faults
const f1 = await ex('createFault', 'Answer the next heartbeat from SN-0001 with 501', 'POST', '/faults', {
  body: { name: 'HB 501 once', method: 'heartbeat', action: 'response_code', responseCode: 501, matchCbsd: 'SN-0001', remaining: 1 },
});
await ex('sendSasRequest', 'Through the real HTTP listener, where fault rules apply', 'POST', '/sas/heartbeat?transport=http', {
  body: hbReq(A, grantA, 'AUTHORIZED'),
});
await ex('getFault', 'The rule has fired once and is used up', 'GET', `/faults/${f1.id}`);
await ex('listFaults', null, 'GET', '/faults');
await ex('updateFault', 'Two more times', 'PATCH', `/faults/${f1.id}`, { body: { remaining: 2 } });
await ex('replaceFault', 'Replace the rule: delay every grant response by 2 s', 'PUT', `/faults/${f1.id}`, { body: { name: 'Slow grants', method: 'grant', action: 'delay', delayMs: 2000 } });
await ex('deleteFault', null, 'DELETE', `/faults/${f1.id}`);
await quiet('POST', '/faults', { method: 'spectrumInquiry', action: 'http_status', httpStatus: 503, responseData: { error: 'busy' } });
await ex('deleteAllFaults', null, 'DELETE', '/faults');

// ================================================================== Logs
const msgs = await ex('listMessages', 'The last two heartbeats', 'GET', '/messages?method=heartbeat&limit=2', { trim: { items: 2, lines: 50 } });
await ex('getMessage', null, 'GET', `/messages/${msgs.items[0].id}`, { trim: { lines: 50 } });
await ex('exportMessages', 'Export as NDJSON, one exchange per line', 'GET', '/messages/export?method=grant&limit=2', { trim: { lines: 4 } });
await ex('deleteMessage', null, 'DELETE', `/messages/${msgs.items[1].id}`);
const evs = await ex('listEvents', 'Warnings', 'GET', '/events?level=warn&limit=2');
await ex('getEvent', null, 'GET', `/events/${evs.items[0].id}`);
await ex('exportEvents', null, 'GET', '/events/export?category=admin&limit=3', { trim: { lines: 6 } });
{
  // The live stream: a heartbeat and an operator action while it is open.
  const ctrl = new AbortController();
  const r = await fetch(`${base}/api/v1/stream?types=event,message`, { headers: { Authorization: `Bearer ${KEY}` }, signal: ctrl.signal });
  if (r.headers.get('x-operation-id') !== 'streamEvents' || r.status !== 200) throw new Error(`stream → ${r.status}`);
  const reader = r.body.getReader();
  let text = '';
  const until = async (re) => {
    const end = Date.now() + 10000;
    while (!re.test(text)) {
      if (Date.now() > end) throw new Error(`stream: no ${re}`);
      text += Buffer.from((await reader.read()).value).toString('utf8');
    }
  };
  await until(/event: hello\n/);
  await quiet('POST', '/sas/heartbeat', hbReq(A, grantA, 'AUTHORIZED'));
  await until(/event: message\n/);
  await quiet('PUT', '/operations/measurement-triggers', { measInHeartbeat: false });
  await until(/event: event\n/);
  ctrl.abort();
  // Frames as sent, with each data line shortened (the hello frame starts with a retry line).
  const frames = text.split('\n\n').filter((f) => /^event: (hello|message|event)$/m.test(f)).map((f) => f.split('\n')
    .map((l) => (l.startsWith('data: ') ? `data: ${inline(collapse(trimDeep(scrubJson(JSON.parse(l.slice(6))), 1), 1))}` : l)).join('\n'));
  (examples.streamEvents ??= []).push({
    title: 'Follow exchanges and events live (Server-Sent Events)', curl: 'curl -sN -H "Authorization: Bearer $KEY" "$API/stream?types=event,message"',
    status: 200, kind: 'text', contentType: 'text/event-stream', text: frames.join('\n\n'),
    note: 'Each `message` is a wire-log entry and each `event` an event-log entry, the same objects GET /messages and GET /events return (cut short here). A comment line (`: ping`) is sent every 15 s to keep the connection open.',
  });
}

// ================================================================== Registry
await ex('listRegistryCandidates', 'Radios that have registered, and what the registry holds for each', 'GET', '/registry/from-cbsds');
await ex('addCbsdsToRegistry', 'Add every radio not yet in the registry', 'POST', '/registry/from-cbsds', { body: {}, trim: { items: 2, lines: 40 } });
await ex('addFccId', null, 'POST', '/registry/fcc-ids', { body: { fccId: 'TEST-FCC-2', maxEirp: 30 } });
await ex('listFccIds', null, 'GET', '/registry/fcc-ids');
await ex('getFccId', null, 'GET', '/registry/fcc-ids/TEST-FCC-2');
await ex('deleteFccId', null, 'DELETE', '/registry/fcc-ids/TEST-FCC-2');
await ex('addUserId', null, 'POST', '/registry/user-ids', { body: { userId: 'bench-team' } });
await ex('listUserIds', null, 'GET', '/registry/user-ids');
await ex('getUserId', null, 'GET', '/registry/user-ids/bench-team');
await ex('deleteUserId', null, 'DELETE', '/registry/user-ids/bench-team');
const bl = await ex('addBlacklistEntry', 'Blacklist one device', 'POST', '/registry/blacklist', { body: { fccId: 'BAD-FCC', serial: 'SN-666', reason: 'Firmware sends malformed grants' } });
await ex('listBlacklist', null, 'GET', '/registry/blacklist');
await ex('getBlacklistEntry', null, 'GET', `/registry/blacklist/${bl.id}`);
await ex('deleteBlacklistEntry', null, 'DELETE', `/registry/blacklist/${bl.id}`);
await ex('preloadRegistrations', 'Preload the location of the Category B radio waiting at REG_PENDING', 'POST', '/registry/conditional', {
  body: {
    fccId: 'TEST-FCC-B', cbsdSerialNumber: 'SN-B001', cbsdCategory: 'B', airInterface: { radioTechnology: 'E_UTRA' },
    installationParam: { latitude: 37.4215, longitude: -122.0839, height: 12, heightType: 'AGL', indoorDeployment: false, antennaGain: 15, eirpCapability: 40, antennaAzimuth: 180, antennaDowntilt: 4, antennaBeamwidth: 65 },
  },
});
await quiet('POST', '/sas/registration', { registrationRequest: [{ userId: 'lab-user', fccId: 'TEST-FCC-B', cbsdSerialNumber: 'SN-B001', cbsdCategory: 'B', airInterface: { radioTechnology: 'E_UTRA' }, measCapability: [] }] });
await ex('listConditionalRegistrations', null, 'GET', '/registry/conditional', { trim: { items: 2, lines: 50 } });
await ex('getConditionalRegistration', null, 'GET', '/registry/conditional/TEST-FCC-B/SN-B001');
await ex('deleteConditionalRegistration', null, 'DELETE', '/registry/conditional/TEST-FCC-B/SN-B001');
const cpiKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' });
await ex('addCpiUser', 'Register a certified professional installer by public key', 'POST', '/registry/cpi-users', {
  body: { cpiId: 'CPI-0042', name: 'Jordan Lee', publicKey: cpiKey },
  curl: `jq -n --rawfile publicKey cpi-0042.pem '{cpiId: "CPI-0042", name: "Jordan Lee", publicKey: $publicKey}' \\\n  | curl -s -X POST "$API/registry/cpi-users" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d @-`,
  note: '`jq` builds the body from the PEM file: `{"cpiId": "CPI-0042", "name": "Jordan Lee", "publicKey": "-----BEGIN PUBLIC KEY-----\\n…"}`.',
});
await ex('listCpiUsers', null, 'GET', '/registry/cpi-users');
await ex('getCpiUser', null, 'GET', '/registry/cpi-users/CPI-0042');
await ex('deleteCpiUser', null, 'DELETE', '/registry/cpi-users/CPI-0042');
await ex('getRegistry', 'Everything in the registry at once', 'GET', '/registry', { trim: { items: 2, lines: 45 } });

// ================================================================== Spectrum and protections
await ex('getSpectrum', null, 'GET', '/spectrum', { trim: { items: 1, lines: 45 } });
const prot = await ex('createProtection', 'Block 3550–3560 MHz: grants inside it are suspended', 'POST', '/protections', {
  body: { name: 'Radar test block', low: 3550 * MHz, high: 3560 * MHz, active: true, action: 'suspend' },
});
await ex('listProtections', 'Active administrator protections', 'GET', '/protections?kind=ADMIN&active=true');
await ex('getProtection', null, 'GET', `/protections/${enc(prot.id)}`);
await ex('deactivateProtection', null, 'POST', `/protections/${enc(prot.id)}/deactivate`);
await ex('activateProtection', 'Activate it on 3555–3560 MHz only', 'POST', `/protections/${enc(prot.id)}/activate`, { body: { channels: [[3555 * MHz, 3560 * MHz]] } });
await ex('putProtection', 'Create or replace a protection under your own id: an ESC sensor neighbourhood', 'PUT', '/protections/esc-norfolk', {
  body: { name: 'ESC sensor Norfolk', kind: 'ESC', low: 3600 * MHz, high: 3650 * MHz, latitude: 36.9, longitude: -76.0, radiusKm: 40 },
});
await ex('deleteProtection', null, 'DELETE', `/protections/${enc(prot.id)}`);
await quiet('DELETE', '/protections/esc-norfolk');
await quiet('POST', `/grants/${grantA}/resume`).catch(() => undefined);

// ================================================================== DPAs
await ex('loadDpas', 'Load the NTIA east-coast DPAs', 'POST', '/dpas/load', { body: { file: 'E-DPAs.kml' } });
const dpas = await ex('listDpas', null, 'GET', '/dpas?limit=2');
const dpa = dpas.items[0].name;
await ex('activateDpaChannel', 'Activate a DPA on one channel', 'POST', `/dpas/${enc(dpa)}/channels/activate`, { body: { lowFrequency: 3550 * MHz, highFrequency: 3560 * MHz } });
await ex('deactivateDpaChannel', null, 'POST', `/dpas/${enc(dpa)}/channels/deactivate`, { body: { lowFrequency: 3550 * MHz, highFrequency: 3560 * MHz } });
await ex('activateAllDpas', null, 'POST', '/dpas/activate-all');
await ex('deactivateAllDpas', null, 'POST', '/dpas/deactivate-all');
await ex('clearDpas', 'Unload every DPA', 'DELETE', '/dpas');

// ================================================================== Incumbents and PPAs
const pt = (lat, lon, lo, hi) => [{ installationParam: { latitude: lat, longitude: lon }, operationParam: { operationFrequencyRange: { lowFrequency: lo, highFrequency: hi } } }];
await ex('injectIncumbent', 'An FSS earth station (adds its GWBL exclusion as a protection)', 'POST', '/incumbents/fss', {
  body: { record: { id: 'fss/lab/1', deploymentParam: pt(39.1, -98.6, 3600 * MHz, 4200 * MHz) }, ttc: false },
});
await ex('injectIncumbent', 'A PAL record', 'POST', '/incumbents/pal', {
  body: { palId: 'pal/lab/1', userId: 'lab-user', channelAssignment: { primaryAssignment: { lowFrequency: 3550 * MHz, highFrequency: 3560 * MHz } }, license: { licenseExpiration: '2035-01-01T00:00:00Z' } },
});
await ex('listIncumbents', null, 'GET', '/incumbents');
await ex('getIncumbent', null, 'GET', `/incumbents/fss/${enc('fss/lab/1')}`);
const fromPal = await ex('createPpaFromPal', 'A PPA for the PAL, with SN-0001 as its cluster', 'POST', '/ppas/from-pal', { body: { cbsdIds: [A], palIds: ['pal/lab/1'] } });
await quiet('DELETE', `/ppas/${enc(fromPal.id)}`);
await ex('deleteIncumbent', null, 'DELETE', `/incumbents/fss/${enc('fss/lab/1')}`);
await quiet('DELETE', `/incumbents/pal/${enc('pal/lab/1')}`);
const ppaBody = { name: 'Lab PPA', channels: [{ low: 3550 * MHz, high: 3560 * MHz, palId: 'pal/lab/1', licenseExpiration: '2035-01-01T00:00:00Z' }], members: [A] };
const ppa = await ex('createPpa', 'A PAL protection area around SN-0001', 'POST', '/ppas', { body: ppaBody });
await ex('listPpas', null, 'GET', '/ppas');
await ex('getPpa', null, 'GET', `/ppas/${enc(ppa.id)}`);
await ex('putPpa', 'Replace it (here: rename)', 'PUT', `/ppas/${enc(ppa.id)}`, { body: { ...ppaBody, name: 'Lab PPA (bench 3)' } });
await ex('deletePpa', null, 'DELETE', `/ppas/${enc(ppa.id)}`);

// ================================================================== Operations
await ex('getOperationsState', null, 'GET', '/operations/state');
await ex('runDailyActivities', 'Run the daily activities now and wait for them', 'POST', '/operations/daily-activities');
await ex('getDailyActivities', null, 'GET', '/operations/daily-activities');
await ex('scheduleDailyActivities', null, 'POST', '/operations/daily-activities/schedule');
await ex('setMeasurementTriggers', 'Ask radios for measurement reports in registration responses', 'PUT', '/operations/measurement-triggers', { body: { measInRegistration: true } });
await ex('getMeasurementTriggers', null, 'GET', '/operations/measurement-triggers');
await quiet('PUT', '/operations/measurement-triggers', { measInRegistration: false });
await ex('setOperationFlags', 'Simulate the ESC network going down', 'PATCH', '/operations/flags', { body: { escConnected: false } });
await quiet('PATCH', '/operations/flags', { escConnected: true });

// ================================================================== Listeners and harness
await ex('getListeners', null, 'GET', '/listeners');
await ex('restartListeners', null, 'POST', '/listeners/restart');
await ex('reloadTls', 'Reload certificates and CRLs into the HTTPS listener', 'POST', '/listeners/reload-tls');
await ex('listHarnessMethods', null, 'GET', '/harness/methods', { trim: { items: 3, lines: 30 } });
await ex('callHarnessMethod', 'Inject an FCC ID, as the harness does', 'POST', '/harness/injectdata/fcc_id', { body: { fccId: 'HARN-FCC', fccMaxEirp: 30 } });
await ex('callHarnessMethod', 'Ask whether the daily activities have finished', 'POST', '/harness/get_daily_activities_status');
await ex('getHarnessConfig', 'A sas.cfg for the WInnForum harness', 'GET', `/harness/sas.cfg?host=${FQDN}`, { trim: { lines: 30 } });

// ================================================================== Certificates
const subCas = await ex('listCerts', 'The intermediate CAs', 'GET', '/certs?kind=sub_ca');
const cbsdCa = subCas.items.find((c) => c.role === 'cbsd');
const installerCa = subCas.items.find((c) => c.role === 'installer');
const operatorCa = subCas.items.find((c) => c.role === 'operator');
const sasCa = subCas.items.find((c) => c.role === 'sas');
await ex('getCert', 'The CBSD CA', 'GET', `/certs/${cbsdCa.id}`, { trim: { items: 2, lines: 50 } });
const leaf = await ex('issueCbsdCert', 'A device certificate for TEST-FCC / SN-0001', 'POST', '/certs/cbsd', { body: { parentId: cbsdCa.id, fccId: FCC, serial: 'SN-0001' }, trim: { lines: 50 } });
await ex('downloadCert', 'The radio bundle: certificate, key, chains, PKCS#12 and the SAS root CA in one zip', 'GET', `/certs/${leaf.id}/download?format=bundle&password=cbrs`, { save: 'radio-bundle.zip' });
await ex('downloadCert', 'Just the certificate, PEM', 'GET', `/certs/${leaf.id}/download?format=pem`);
await ex('issueCbsdCertBatch', 'Certificates for three radios at once (a zip of bundles)', 'POST', '/certs/cbsd-batch', {
  body: { parentId: cbsdCa.id, devices: [{ fccId: FCC, serial: 'SN-0101' }, { fccId: FCC, serial: 'SN-0102' }, { fccId: FCC, serial: 'SN-0103' }] }, save: 'bundles.zip',
});
await ex('issueDomainProxyCert', null, 'POST', '/certs/domain-proxy', { body: { parentId: operatorCa.id, CN: 'Lab Domain Proxy', frn: '0123456789' }, trim: { lines: 40 } });
const inst = await ex('issueInstallerCert', 'A CPI certificate (also registers the CPI)', 'POST', '/certs/installer', { body: { parentId: installerCa.id, cpiId: 'CPI-0007', cpiName: 'Sam Rivera' }, trim: { lines: 40 } });
await ex('signCpiData', 'Sign installation data as that CPI', 'POST', '/cpi/sign', {
  body: {
    installerCertId: inst.id, fccId: 'TEST-FCC-B', cbsdSerialNumber: 'SN-B002',
    installationParam: { latitude: 37.4215, longitude: -122.0839, height: 12, heightType: 'AGL', indoorDeployment: false, antennaGain: 15, eirpCapability: 40 },
  },
});
await ex('issueServerCert', 'A SAS server certificate for another name', 'POST', '/certs/server', { body: { parentId: sasCa.id, CN: 'sas2.lab.example', sans: ['sas2.lab.example', '192.0.2.20'] }, trim: { lines: 40 } });
const labRoot = await ex('createRootCa', 'A second root CA', 'POST', '/certs/root', { body: { CN: 'Bench 3 Root CA', O: 'Example Lab', C: 'US', keyType: 'ec256', days: 3650 }, trim: { lines: 40 } });
await ex('createSubCa', 'A CBSD CA under it', 'POST', '/certs/sub-ca', { body: { parentId: labRoot.id, role: 'cbsd', CN: 'Bench 3 CBSD CA', keyType: 'ec256' }, trim: { lines: 40 } });
await ex('updateCert', 'Rename', 'PATCH', `/certs/${labRoot.id}`, { body: { name: 'Bench 3 root' }, trim: { lines: 30 } });
// Imports: a partner's root (certificate only) and a PKCS#12 file.
const partner = await quiet('POST', '/certs/root', { CN: 'Partner Root CA', O: 'Partner Lab', keyType: 'ec256', days: 3650 });
const partnerPem = (await call('GET', `/certs/${partner.id}/download?format=pem`)).text;
await quiet('DELETE', `/certs/${partner.id}`);
const imported = await ex('importCerts', 'Import a CA certificate (PEM; add keyPem to import its key too)', 'POST', '/certs/import', {
  body: { pem: partnerPem, name: 'Partner Root CA' }, trim: { lines: 40 },
  curl: `jq -n --rawfile pem partner-root-ca.pem '{pem: $pem, name: "Partner Root CA"}' \\\n  | curl -s -X POST "$API/certs/import" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d @-`,
  note: '`jq` builds the body from the PEM file: `{"pem": "-----BEGIN CERTIFICATE-----\\n…", "name": "Partner Root CA"}`.',
});
const p12 = (await call('GET', `/certs/${leaf.id}/download?format=p12&password=cbrs`)).buf;
await ex('importPkcs12', 'Import a PKCS#12 file', 'POST', '/certs/import-p12', {
  body: { data: p12.toString('base64'), password: 'cbrs', name: 'SN-0001 from p12' }, trim: { items: 1, lines: 40 },
  curl: `jq -n --arg data "$(base64 -w0 device.p12)" '{data: $data, password: "cbrs", name: "SN-0001 from p12"}' \\\n  | curl -s -X POST "$API/certs/import-p12" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d @-`,
  note: 'The file goes in `data` as base64: `{"data": "MIIK…", "password": "cbrs", "name": "SN-0001 from p12"}`.',
});
await ex('deleteCert', null, 'DELETE', `/certs/${imported.items[0].id}`);
const revoked = await quiet('POST', '/certs/cbsd', { parentId: cbsdCa.id, fccId: FCC, serial: 'SN-0666' });
await ex('revokeCert', null, 'POST', `/certs/${revoked.id}/revoke`, { trim: { lines: 30 } });
// HTTPS with mutual TLS, presenting a device certificate from the store.
const tlsCert = await quiet('POST', '/certs/cbsd', { parentId: cbsdCa.id, fccId: FCC, serial: 'SN-0004' });
await ex('sendSasRequest', 'Register over HTTPS with mutual TLS, presenting a lab device certificate', 'POST', `/sas/registration?transport=https&clientCertId=${tlsCert.id}`, {
  body: { registrationRequest: [regA('SN-0004')] },
});

// ================================================================== TLS and CRLs
const tls = await ex('getTls', null, 'GET', '/tls', { trim: { items: 2, lines: 50 } });
await ex('setServerCerts', 'Choose the certificates the HTTPS listener presents', 'PUT', '/tls/server-certs', { body: { ids: tls.serverCertIds }, trim: { items: 2, lines: 40 } });
await ex('setTrustedClientCas', 'Trust client certificates from the CBSD CA only', 'PUT', '/tls/trusted-cas', { body: { ids: [cbsdCa.id] }, trim: { items: 2, lines: 40 } });
await quiet('PUT', '/tls/trusted-cas', { ids: [] });
await ex('downloadTrustBundle', 'The root CAs, for a radio\'s trust store', 'GET', '/trust-bundle?which=roots');
const crlPem = (await call('GET', `/certs/${cbsdCa.id}/download?format=crl`)).text;
const crls = await ex('importCrls', 'Import a CRL', 'POST', '/crls', {
  body: { files: [{ name: 'CBSD CA CRL', data: Buffer.from(crlPem).toString('base64') }] },
  curl: `jq -n --arg data "$(base64 -w0 cbsd-ca.crl)" '{files: [{name: "CBSD CA CRL", data: $data}]}' \\\n  | curl -s -X POST "$API/crls" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d @-`,
  note: 'Each file (PEM or DER) goes in `data` as base64: `{"files": [{"name": "CBSD CA CRL", "data": "LS0tLS1CRUdJTi…"}]}`.',
});
await ex('listCrls', null, 'GET', '/crls');
await ex('getCrl', null, 'GET', `/crls/${crls.items[0].id}`);
await ex('downloadCrl', null, 'GET', `/crls/${crls.items[0].id}/download`);
await ex('deleteCrl', null, 'DELETE', `/crls/${crls.items[0].id}`);
await ex('unrevokeCert', null, 'POST', `/certs/${revoked.id}/unrevoke`, { trim: { lines: 30 } });

// ================================================================== Map
await ex('getMap', null, 'GET', '/map', { trim: { items: 2, lines: 40 } });
await ex('listTileSets', null, 'GET', '/map/tilesets');
await ex('rescanTileSets', 'Pick up files copied into the tile store', 'POST', '/map/tilesets/rescan');
await ex('getTileSet', null, 'GET', '/map/tilesets/lab-topo');
await ex('getTile', 'One tile (z/x/y)', 'GET', '/map/tilesets/lab-topo/tiles/10/163/396', { save: 'tile.png' });
const bounds = [-122.2, 37.3, -121.9, 37.5];
await ex('estimateTileDownload', 'How many tiles is the area around the bench?', 'GET', `/map/download/estimate?bounds=${bounds.join(',')}&minZoom=10&maxZoom=13`);
await ex('startTileDownload', 'Download that area from the USGS topo map for offline use', 'POST', '/map/download', {
  body: { url: `${stubUrl}/t/{z}/{x}/{y}.png`, bounds, minZoom: 10, maxZoom: 13, name: 'bench-area', attribution: 'USGS The National Map' },
});
for (let i = 0; i < 100 && (await quiet('GET', '/map/download')).job?.state === 'running'; i++) await sleep(100);
await ex('getTileDownload', 'Progress of the download (here, finished)', 'GET', '/map/download');
await quiet('POST', '/map/download', { url: `${stubUrl}/slow/{z}/{x}/{y}.png`, bounds: [-123, 37, -121, 38.5], minZoom: 8, maxZoom: 11, name: 'imagery' });
await ex('cancelTileDownload', 'Stop a download in progress', 'DELETE', '/map/download');
await ex('deleteTileSet', null, 'DELETE', '/map/tilesets/bench-area.mbtiles');

// ================================================================== Terrain
await ex('getTerrain', null, 'GET', '/terrain');
await ex('rescanTerrain', 'Pick up tiles copied into the terrain folder', 'POST', '/terrain/rescan');
await ex('getElevation', null, 'GET', '/terrain/elevation?lat=39.5&lon=-100.5');
await ex('getHaat', 'Height above average terrain of a 10 m antenna, as the Category A check computes it', 'GET', '/terrain/haat?lat=39.5&lon=-100.5&height=10', { trim: { items: 3, lines: 30 } });
await ex('getTerrainTilesNeeded', 'Which tiles do HAAT checks at these two sites need?', 'GET', `/terrain/tiles-needed?points=${enc('39.5,-100.5;37.425,-122.084')}`);
await ex('startTerrainDownload', 'Download a tile from USGS', 'POST', '/terrain/download', { body: { tiles: ['n10w010'] } });
for (let i = 0; i < 100 && (await quiet('GET', '/terrain/download')).job?.state === 'running'; i++) await sleep(100);
await ex('getTerrainDownload', 'Progress of the download (here, finished)', 'GET', '/terrain/download');
await quiet('POST', '/terrain/download', { tiles: ['n11w010'] });
await ex('cancelTerrainDownload', null, 'DELETE', '/terrain/download');

// ================================================================== Configuration and data
await ex('exportConfig', 'Settings, registry, protections, PPAs and fault rules as one JSON document', 'GET', '/config/export', { trim: { items: 1, lines: 40 } });
await ex('importConfig', 'Import a configuration (here, one setting and one FCC ID)', 'POST', '/config/import', {
  body: { settings: { heartbeatIntervalSec: 60 }, fccIds: [{ fcc_id: 'IMPORTED-FCC', max_eirp: 33, created_at: Date.now() }] },
});
await ex('downloadBackup', 'A consistent copy of the whole database, while the SAS runs (admins only)', 'GET', '/system/backup', { save: 'sasbench-backup.db' });
await ex('listTables', null, 'GET', '/data/tables', { trim: { items: 4, lines: 30 } });
await ex('getTable', null, 'GET', '/data/tables/fcc_ids');
await ex('listTableRows', 'Rows of a table, filtered', 'GET', '/data/tables/fcc_ids/rows?column=fcc_id&like=TEST&limit=5');

// ================================================================== Clearing up
await ex('clearMessages', 'Empty the wire log', 'DELETE', '/messages');
await ex('clearEvents', 'Empty the event log', 'DELETE', '/events');
await ex('resetSasState', 'Reset the SAS like the harness does: CBSDs, grants, registry, incumbents, PPAs and protections', 'POST', '/operations/reset', { body: { confirm: 'RESET', clearLogs: false } });

// ---------------------------------------------------------------- coverage and output

await sas.stop();
stub.close();
fs.rmSync(root, { recursive: true, force: true });

const doc = buildOpenApi(VERSION);
const order = [];
for (const methods of Object.values(doc.paths)) for (const op of Object.values(methods)) order.push(op.operationId);
const missing = order.filter((id) => !examples[id]);
if (missing.length) {
  console.error(`No example for: ${missing.join(', ')}`);
  process.exit(1);
}
const sorted = Object.fromEntries(order.map((id) => [id, examples[id]]));
fs.writeFileSync(OUT, `${JSON.stringify({ version: VERSION, generatedBy: 'npm run api:examples', examples: sorted }, null, 2)}\n`);
console.log(`Wrote ${path.relative(ROOT, OUT)}: ${Object.values(sorted).flat().length} examples for ${order.length} operations.`);
