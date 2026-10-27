import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Db } from './db.ts';
import { SettingsStore, LISTENER_KEYS } from './settings.ts';
import { Bus } from './bus.ts';
import { Pki } from './pki/pki.ts';
import { Engine } from './sas/engine.ts';
import { FaultInjector } from './sas/faults.ts';
import { SasAdmin } from './sas/admin.ts';
import { Terrain } from './sas/terrain.ts';
import { SasServer } from './net/sasServer.ts';
import { TileDownloader, TileStore } from './map/tiles.ts';
import { buildApi, harnessHook } from './api.ts';
import { BASE as API_V1, buildApiV1 } from './api/v1/index.ts';
import { ApiTokens, Auth, type Principal } from './api/v1/auth.ts';
import { DEFAULT_ADMIN, Sessions, Users } from './auth/users.ts';
import { gate, handleAuthRoute } from './auth/console.ts';
import { TerrainDownloader } from './tools/terrainFetch.ts';
import { sendJson } from './net/http.ts';
import { PRESETS } from './presets.ts';
import { dropBlankEnv, hostOrIp, isWildcard, primaryIPv4 } from './net/addresses.ts';

// SASBench — entry point. One process serves:
//   - the SAS-CBSD protocol on HTTP (default 8000) and HTTPS/mTLS (default 8443), plus the
//     WInnForum test-harness admin API under /admin/ on the same listeners;
//   - the web UI, its private REST API (/api/*) and the public REST API (/api/v1, see docs/API.md)
//     on UI_PORT (default 8080), and the public REST API alone on SAS_API_PORT when it is set.
// Every listener binds SAS_BIND_IP (default: all addresses). The UI and the REST API require a
// user account (first start: admin / admin) or an API key, unless SAS_AUTH=off.

dropBlankEnv();
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string;
const DATA_DIR = path.resolve(process.env.SAS_DATA_DIR ?? path.join(ROOT, 'data'));
const BIND_IP = process.env.SAS_BIND_IP ?? '0.0.0.0';
const FQDN = process.env.SAS_FQDN ? hostOrIp(process.env.SAS_FQDN) : null;
const WEB_DIR = path.resolve(process.env.SAS_WEB_DIR ?? path.join(ROOT, 'web', 'dist'));
const RESOURCE_DIR = path.join(ROOT, 'server', 'data');

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const fatal = (m: string): never => {
  log(m);
  process.exit(1);
};
/** A port number from the environment; null when the variable is not set. Exits on anything else. */
const envPort = (name: string): number | null => {
  const v = process.env[name];
  if (v === undefined) return null;
  const n = Number(v.trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fatal(`${name} must be a port number (1-65535), not "${v}"`);
};
const UI_PORT = envPort('UI_PORT') ?? 8080;
const API_PORT = envPort('SAS_API_PORT');
const SAS_HTTP_PORT = envPort('SAS_HTTP_PORT');
const SAS_HTTPS_PORT = envPort('SAS_HTTPS_PORT');
if (!net.isIP(BIND_IP)) fatal(`SAS_BIND_IP must be an IP address of this machine (or 0.0.0.0 for all), not "${BIND_IP}"`);
if (process.env.SAS_FQDN && !FQDN) fatal(`SAS_FQDN must be a host name or an IP address, not "${process.env.SAS_FQDN}"`);

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Db(path.join(DATA_DIR, 'sas.db'));
const settings = new SettingsStore(db);
applyEnvOverrides(settings);
const bus = new Bus(db, settings);
const pki = new Pki(db, path.join(DATA_DIR, 'tmp'));
const engine = new Engine(db, settings, bus);
engine.terrain = new Terrain(process.env.SAS_TERRAIN_DIR ?? path.join(DATA_DIR, 'terrain'));
if (engine.terrain.tileCount) {
  log(`Terrain: ${engine.terrain.tileCount} elevation tile(s) in ${engine.terrain.directory} for the Category A HAAT check`);
} else {
  log(`No terrain tiles in ${engine.terrain.directory}: the Category A HAAT check is skipped until tiles are added (node server/src/tools/fetch-terrain.ts)`);
}
const faults = new FaultInjector(db, bus);
const admin = new SasAdmin(db, engine, bus, settings, pki, RESOURCE_DIR);
const sas = new SasServer(settings, pki, bus, engine, faults);
sas.bindHost = BIND_IP;
const tiles = new TileStore(path.resolve(process.env.SAS_TILES_DIR ?? path.join(DATA_DIR, 'tiles')));
const tileDownloader = new TileDownloader(tiles, bus);
sas.adminHook = harnessHook(admin, bus);

// Hostnames / IPs that should appear in the SAS server certificate; the first is its common name.
const hostnames = [...new Set([
  ...(FQDN ? [FQDN] : []),
  ...(process.env.SAS_HOSTNAMES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  ...(isWildcard(BIND_IP) ? [] : [BIND_IP]),
  'localhost', '127.0.0.1', os.hostname(),
  ...Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address),
])];
// The SAS endpoints shown to people and put in radio bundles: the FQDN and the address in use.
const ownIp = isWildcard(BIND_IP) ? await primaryIPv4() : BIND_IP;
const advertised = [...new Set([...(FQDN ? [FQDN] : []), ...(ownIp ? [ownIp] : [])])];
if (!advertised.length) advertised.push('localhost');

const { serverCertIds } = pki.ensureLabPki(hostnames, (m) => {
  log(m);
  bus.event('info', 'certs', m);
});
if (!settings.get().serverCertIds.length && serverCertIds.length) settings.update({ serverCertIds });
const refreshed = pki.refreshAutoServerCerts(hostnames, settings.get().serverCertIds, (m) => {
  log(m);
  bus.event('info', 'certs', m);
});
if (refreshed) settings.update({ serverCertIds: refreshed });

settings.onChange((changed) => {
  if (changed.some((k) => LISTENER_KEYS.includes(k))) void sas.restart();
});
// Certificate / CRL changes also affect the TLS context.
bus.on('sse', (type: string, data: any) => {
  if (type === 'changed' && data?.what === 'certs') sas.reloadTls();
});

await sas.restart();
engine.startSweeper();
for (const [name, l] of [['SAS HTTPS', sas.getStatus().https], ['SAS HTTP', sas.getStatus().http]] as const) {
  if (l.enabled) log(l.listening ? `${name} on port ${l.port}` : `${name} is not listening: ${l.error}`);
}

// ---------------------------------------------------------------- UI / REST server

const startedAt = Date.now();
const api = buildApi({ db, settings, bus, pki, engine, sas, admin, startedAt, version: VERSION, uiPort: UI_PORT, hostnames, advertised, tiles, tileDownloader });
const apiTokens = new ApiTokens(db);
const users = new Users(db);
const auth = new Auth({ users, sessions: new Sessions(db), tokens: apiTokens, off: process.env.SAS_AUTH === 'off' });
await ensureAdminAccount();
if (auth.off) log('SAS_AUTH=off: the web UI and the REST API are open to anyone who can reach them');
const terrainDownloader = new TerrainDownloader(() => engine.terrain?.directory ?? null, () => engine.terrain?.reindex(), bus);
const apiV1 = buildApiV1({
  db, settings, bus, pki, engine, sas, admin, tiles, tileDownloader, terrainDownloader, tokens: apiTokens, auth, startedAt, version: VERSION,
  uiPort: UI_PORT, apiPort: API_PORT ?? UI_PORT, bindIp: BIND_IP, hostnames, advertised, dataDir: DATA_DIR,
  corsOrigins: (process.env.SAS_API_CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
});

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.map', '.txt']);
const gzipped = new Map<string, { mtime: number; data: Buffer }>();

const ui = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    // The public API authenticates and reports errors itself.
    if (url.pathname === API_V1 || url.pathname.startsWith(`${API_V1}/`)) return await apiV1.handle(req, res, url);
    if (url.pathname.startsWith('/api/auth/') && (await handleAuthRoute(auth, bus, req, res, url))) return;
    const t = /^\/tiles\/([^/]+)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})(?:\.\w+)?$/.exec(url.pathname);
    if (url.pathname.startsWith('/api/') || t) {
      // Everything the console loads (its private API, live stream and map tiles) needs a signed-in user.
      const principal = await gate(auth, req, res, url);
      if (!principal) return;
      if (t) return serveTile(res, decodeURIComponent(t[1]), Number(t[2]), Number(t[3]), Number(t[4]));
      if (url.pathname === '/api/stream') return stream(req, res, principal);
      if (await api.handle(req, res, url.pathname, url.searchParams)) return;
      return sendJson(res, 404, { error: 'Not found' });
    }
    if (url.pathname.startsWith('/admin/') || /\/v\d+\.\d+\//.test(url.pathname)) {
      return sendJson(res, 404, { error: `This is the UI port. Send SAS protocol requests to port ${settings.get().sasHttpsPort} (HTTPS) or ${settings.get().sasHttpPort} (HTTP).` });
    }
    serveStatic(req, url.pathname, res);
  } catch (e: any) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
  }
});
ui.on('error', (e: NodeJS.ErrnoException) => {
  fatal(e.code === 'EADDRINUSE' ? `Web UI port ${UI_PORT} is already in use (set UI_PORT to another port)`
    : e.code === 'EADDRNOTAVAIL' ? `SAS_BIND_IP ${BIND_IP} is not an address of this machine` : `Web UI server error: ${e.message}`);
});
ui.listen(UI_PORT, BIND_IP, () => log(`Web UI on http://${BIND_IP}:${UI_PORT}`));

// The public API alone on its own port (SAS_API_PORT), for firewalls and reverse proxies.
let apiServer: http.Server | null = null;
if (API_PORT !== null && API_PORT !== UI_PORT) {
  apiServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (url.pathname === API_V1 || url.pathname.startsWith(`${API_V1}/`)) return await apiV1.handle(req, res, url);
      sendJson(res, 404, { error: { status: 404, code: 'not_found', message: `This port serves only the REST API, under ${API_V1}` } });
    } catch (e: any) {
      if (!res.headersSent) sendJson(res, 500, { error: { status: 500, code: 'internal_error', message: e.message } });
    }
  });
  apiServer.on('error', (e: NodeJS.ErrnoException) => fatal(e.code === 'EADDRINUSE' ? `API port ${API_PORT} is already in use (set SAS_API_PORT to another port)` : `API server error: ${e.message}`));
  apiServer.listen(API_PORT, BIND_IP, () => log(`REST API on http://${BIND_IP}:${API_PORT}${API_V1}`));
}

function stream(req: http.IncomingMessage, res: http.ServerResponse, principal: Principal) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const onEvent = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const stop = () => {
    clearInterval(ping);
    bus.off('sse', onEvent);
    bus.off('auth-changed', onAuthChanged);
  };
  const end = () => {
    stop();
    res.end();
  };
  // Ends when the user signs out, is disabled or deleted, or their session expires.
  const onAuthChanged = (userId: number) => {
    if (userId === principal.userId && !auth.stillValid(principal)) end();
  };
  bus.on('sse', onEvent);
  bus.on('auth-changed', onAuthChanged);
  const ping = setInterval(() => (auth.stillValid(principal) ? res.write(': ping\n\n') : end()), 15000);
  req.on('close', stop);
}

/**
 * First start: the admin account. Its password comes from SAS_ADMIN_PASSWORD, else from the UI
 * password of earlier versions (setting or SAS_UI_PASSWORD), else the default admin / admin.
 */
async function ensureAdminAccount() {
  const legacy = db.get("SELECT value FROM settings WHERE key = 'uiPassword'")?.value;
  if (!users.count()) {
    let old: string | null = null;
    try {
      old = legacy ? JSON.parse(legacy) || null : null;
    } catch { /* not JSON */ }
    const password = process.env.SAS_ADMIN_PASSWORD || process.env.SAS_UI_PASSWORD || old || DEFAULT_ADMIN.password;
    const isDefault = password === DEFAULT_ADMIN.password;
    await users.create({ username: DEFAULT_ADMIN.username, password, role: 'admin', displayName: 'Administrator', defaultPassword: isDefault });
    const from = process.env.SAS_ADMIN_PASSWORD ? 'SAS_ADMIN_PASSWORD' : process.env.SAS_UI_PASSWORD ? 'SAS_UI_PASSWORD' : old ? 'the previous UI password' : null;
    const msg = from ? `Created the admin account (user name admin, password from ${from})`
      : 'Created the admin account: user name admin, password admin. Sign in and change the password (account menu, top right → Your account).';
    log(msg);
    bus.event(from ? 'info' : 'warn', 'auth', msg);
  }
  if (legacy !== undefined) db.run("DELETE FROM settings WHERE key = 'uiPassword'");
}

/** Offline map tiles from the tile store: /tiles/<tile set>/<z>/<x>/<y>. */
function serveTile(res: http.ServerResponse, id: string, z: number, x: number, y: number) {
  const t = tiles.tile(id, z, x, y);
  if (!t) {
    res.writeHead(404, { 'Cache-Control': 'public, max-age=300' });
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': t.type, 'Content-Length': t.data.length, 'Cache-Control': 'public, max-age=86400' });
  res.end(t.data);
}

function serveStatic(req: http.IncomingMessage, pathname: string, res: http.ServerResponse) {
  let file = path.join(WEB_DIR, path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(WEB_DIR)) file = WEB_DIR;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIR, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>SASBench</h1><p>The web UI has not been built. Run <code>npm run build:web</code>. The REST API is available under /api/.</p>');
    return;
  }
  const ext = path.extname(file);
  let data: Buffer = fs.readFileSync(file);
  const headers: Record<string, string | number> = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (COMPRESSIBLE.has(ext)) {
    headers.Vary = 'Accept-Encoding';
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      const mtime = fs.statSync(file).mtimeMs;
      let gz = gzipped.get(file);
      if (!gz || gz.mtime !== mtime) gzipped.set(file, (gz = { mtime, data: zlib.gzipSync(data) }));
      data = gz.data;
      headers['Content-Encoding'] = 'gzip';
    }
  }
  headers['Content-Length'] = data.length;
  res.writeHead(200, headers);
  res.end(data);
}

/** Environment variables applied on every start (useful for docker-compose). */
function applyEnvOverrides(store: SettingsStore) {
  // SAS_HTTP_PORT and SAS_HTTPS_PORT: the radio ports for this run, in place of the ones in Settings.
  const s = store.get();
  const taken: Array<[number | null, string]> = [
    [UI_PORT, 'the web UI port (UI_PORT)'], [API_PORT, 'the REST API port (SAS_API_PORT)'],
    [SAS_HTTP_PORT === null ? s.sasHttpPort : null, 'the SAS HTTP port set in Settings'],
    [SAS_HTTPS_PORT === null ? s.sasHttpsPort : null, 'the SAS HTTPS port set in Settings'],
  ];
  for (const [name, port] of [['SAS_HTTPS_PORT', SAS_HTTPS_PORT], ['SAS_HTTP_PORT', SAS_HTTP_PORT]] as const) {
    if (port === null) continue;
    const clash = taken.find(([p]) => p === port);
    if (clash) fatal(`${name} ${port} is also ${clash[1]}; every listener needs a port of its own`);
    taken.push([port, name]);
  }
  if (SAS_HTTP_PORT !== null) store.setFromEnv('sasHttpPort', SAS_HTTP_PORT, 'SAS_HTTP_PORT');
  if (SAS_HTTPS_PORT !== null) store.setFromEnv('sasHttpsPort', SAS_HTTPS_PORT, 'SAS_HTTPS_PORT');
  // SAS_PROFILE: applied on first start and whenever its value changes, so later changes made in
  // Settings survive restarts; SAS_PROFILE_APPLY=always applies it on every start.
  const profile = process.env.SAS_PROFILE;
  if (profile && !PRESETS[profile]) log(`SAS_PROFILE "${profile}" is not a profile (${Object.keys(PRESETS).join(', ')}); ignored`);
  else if (profile) {
    const last = db.get("SELECT value FROM settings WHERE key = 'profileApplied'")?.value;
    if (process.env.SAS_PROFILE_APPLY === 'always' || last !== JSON.stringify(profile)) {
      store.update(PRESETS[profile].patch);
      db.run("INSERT OR REPLACE INTO settings(key, value) VALUES ('profileApplied', ?)", JSON.stringify(profile));
      log(`Applied the ${profile} settings profile (SAS_PROFILE)`);
    }
  }
}

const shutdown = async () => {
  log('Shutting down');
  engine.stopSweeper();
  await sas.stop();
  ui.close();
  apiServer?.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
