import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Db } from './db.ts';
import { SettingsStore, LISTENER_KEYS, type Settings } from './settings.ts';
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
import { ApiTokens, authenticate } from './api/v1/auth.ts';
import { TerrainDownloader } from './tools/terrainFetch.ts';
import { sendJson } from './net/http.ts';
import { PRESETS } from './presets.ts';

// SASBench — entry point. One process serves:
//   - the SAS-CBSD protocol on HTTP (default 8000) and HTTPS/mTLS (default 8443), plus the
//     WInnForum test-harness admin API under /admin/ on the same listeners;
//   - the web UI, its private REST API (/api/*) and the public REST API (/api/v1, see docs/API.md)
//     on UI_PORT (default 8080).

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string;
const DATA_DIR = path.resolve(process.env.SAS_DATA_DIR ?? path.join(ROOT, 'data'));
const UI_PORT = Number(process.env.UI_PORT ?? 8080);
const WEB_DIR = path.resolve(process.env.SAS_WEB_DIR ?? path.join(ROOT, 'web', 'dist'));
const RESOURCE_DIR = path.join(ROOT, 'server', 'data');

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

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
const tiles = new TileStore(path.resolve(process.env.SAS_TILES_DIR ?? path.join(DATA_DIR, 'tiles')));
const tileDownloader = new TileDownloader(tiles, bus);
sas.adminHook = harnessHook(admin, bus);

// Hostnames / IPs that should appear in the SAS server certificate.
const hostnames = [...new Set([
  ...(process.env.SAS_HOSTNAMES ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  'localhost', '127.0.0.1', os.hostname(),
  ...Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address),
])];

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

// ---------------------------------------------------------------- UI / REST server

const startedAt = Date.now();
const api = buildApi({ db, settings, bus, pki, engine, sas, admin, startedAt, version: VERSION, uiPort: UI_PORT, hostnames, tiles, tileDownloader });
const apiTokens = new ApiTokens(db);
const terrainDownloader = new TerrainDownloader(() => engine.terrain?.directory ?? null, () => engine.terrain?.reindex(), bus);
const apiV1 = buildApiV1({
  db, settings, bus, pki, engine, sas, admin, tiles, tileDownloader, terrainDownloader, tokens: apiTokens, startedAt, version: VERSION,
  uiPort: UI_PORT, hostnames, dataDir: DATA_DIR,
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
    const auth = authenticate(req, settings, apiTokens, null, 'ignore');
    if (!auth.ok) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="SASBench", charset="UTF-8"', 'Content-Type': 'text/plain' });
      res.end('Authentication required');
      return;
    }
    // The console's private API can change anything and download private keys: read-only tokens stop at /api/v1.
    if (auth.principal.scope !== 'write' && url.pathname.startsWith('/api/')) {
      return sendJson(res, 403, { error: `A read-only API token cannot use ${url.pathname}; use ${API_V1}` });
    }
    if (url.pathname === '/api/stream') return stream(req, res);
    if (url.pathname.startsWith('/api/')) {
      if (await api.handle(req, res, url.pathname, url.searchParams)) return;
      return sendJson(res, 404, { error: 'Not found' });
    }
    if (url.pathname.startsWith('/admin/') || /\/v\d+\.\d+\//.test(url.pathname)) {
      return sendJson(res, 404, { error: `This is the UI port. Send SAS protocol requests to port ${settings.get().sasHttpsPort} (HTTPS) or ${settings.get().sasHttpPort} (HTTP).` });
    }
    const t = /^\/tiles\/([^/]+)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})(?:\.\w+)?$/.exec(url.pathname);
    if (t) return serveTile(res, decodeURIComponent(t[1]), Number(t[2]), Number(t[3]), Number(t[4]));
    serveStatic(req, url.pathname, res);
  } catch (e: any) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
  }
});
ui.on('error', (e: NodeJS.ErrnoException) => {
  log(e.code === 'EADDRINUSE' ? `Web UI port ${UI_PORT} is already in use (set UI_PORT to another port)` : `Web UI server error: ${e.message}`);
  process.exit(1);
});
ui.listen(UI_PORT, '0.0.0.0', () => log(`Web UI on http://0.0.0.0:${UI_PORT}`));

function stream(req: http.IncomingMessage, res: http.ServerResponse) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const onEvent = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  bus.on('sse', onEvent);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('sse', onEvent);
  });
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
  const patch: Partial<Settings> = {};
  const int = (k: string) => (process.env[k] ? Number(process.env[k]) : undefined);
  if (int('SAS_HTTP_PORT')) patch.sasHttpPort = int('SAS_HTTP_PORT');
  if (int('SAS_HTTPS_PORT')) patch.sasHttpsPort = int('SAS_HTTPS_PORT');
  if (process.env.SAS_UI_PASSWORD) patch.uiPassword = process.env.SAS_UI_PASSWORD;
  if (Object.keys(patch).length) store.update(patch);
  const profile = process.env.SAS_PROFILE;
  if (profile && PRESETS[profile] && !db.get("SELECT 1 FROM settings WHERE key = 'profileApplied'")) {
    store.update(PRESETS[profile].patch);
    db.run("INSERT OR REPLACE INTO settings(key, value) VALUES ('profileApplied', ?)", JSON.stringify(profile));
  }
}

const shutdown = async () => {
  log('Shutting down');
  engine.stopSweeper();
  await sas.stop();
  ui.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
