import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startSas, type TestSas } from './helpers.ts';

// Map configuration, the offline tile store (MBTiles + z/x/y folders) and the tile downloader's
// validation. No network access: downloads are only checked up to the point they would start.

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC', 'base64');
let sas: TestSas;
let tilesDir: string;

before(async () => {
  tilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sasbench-tiles-'));
  const db = new DatabaseSync(path.join(tilesDir, 'lab.mbtiles'));
  db.exec(`CREATE TABLE metadata (name TEXT, value TEXT);
    CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);`);
  for (const [k, v] of [['name', 'Lab area'], ['format', 'png'], ['minzoom', '1'], ['maxzoom', '2'], ['bounds', '-105,39,-104,40'], ['attribution', 'Test tiles']]) {
    db.prepare('INSERT INTO metadata VALUES (?, ?)').run(k, v);
  }
  // z=1, x=0, XYZ y=0 is TMS row 1.
  db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)').run(1, 0, 1, PNG);
  db.close();
  fs.mkdirSync(path.join(tilesDir, 'folder', '3', '2'), { recursive: true });
  fs.writeFileSync(path.join(tilesDir, 'folder', '3', '2', '5.png'), PNG);
  sas = await startSas({ SAS_TILES_DIR: tilesDir });
});

after(async () => {
  await sas?.stop();
  fs.rmSync(tilesDir, { recursive: true, force: true });
});

const tile = (p: string) => fetch(`http://127.0.0.1:${sas.uiPort}${p}`);

test('the built-in offline basemap is the default source', async () => {
  const m = await sas.api('GET', '/api/map');
  assert.equal(m.source, 'builtin');
  assert.equal(m.local, null);
  assert.match(m.url, /nationalmap\.gov/);
});

test('MBTiles and z/x/y folders in the tile store are listed and served', async () => {
  const m = await sas.api('GET', '/api/map');
  const byId = Object.fromEntries(m.store.sets.map((s: any) => [s.id, s]));
  assert.equal(byId['lab.mbtiles'].usable, true);
  assert.equal(byId['lab.mbtiles'].name, 'Lab area');
  assert.deepEqual([byId['lab.mbtiles'].minZoom, byId['lab.mbtiles'].maxZoom], [1, 2]);
  assert.deepEqual(byId['lab.mbtiles'].bounds, [-105, 39, -104, 40]);
  assert.equal(byId.folder.usable, true);
  assert.equal(byId.folder.format, 'png');

  const r = await tile('/tiles/lab.mbtiles/1/0/0');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);
  assert.equal((await tile('/tiles/lab.mbtiles/1/1/1')).status, 404);
  assert.equal((await tile('/tiles/folder/3/2/5.png')).status, 200);
  assert.equal((await tile('/tiles/nope.mbtiles/1/0/0')).status, 404);
  assert.equal((await tile('/tiles/..%2F..%2Fetc/1/0/0')).status, 404);
});

test('mapSource local resolves the chosen tile set', async () => {
  await sas.api('PUT', '/api/settings', { mapSource: 'local', mapLocalTiles: 'folder' });
  assert.equal((await sas.api('GET', '/api/map')).local.id, 'folder');
  await sas.api('PUT', '/api/settings', { mapLocalTiles: '' });
  assert.equal((await sas.api('GET', '/api/map')).local.id, 'folder', 'first usable set when none is chosen');
  await sas.api('PUT', '/api/settings', { mapSource: 'builtin' });
});

test('map settings are validated', async () => {
  await assert.rejects(sas.api('PUT', '/api/settings', { mapSource: 'satellite' }), /400/);
  await assert.rejects(sas.api('PUT', '/api/settings', { mapTileUrl: 'https://tiles.example.com/tile.png' }), /must contain \{z\}/);
  await assert.rejects(sas.api('PUT', '/api/settings', { mapTileMaxZoom: 40 }), /400/);
  await sas.api('PUT', '/api/settings', { mapTileUrl: 'https://tiles.example.com/{z}/{x}/{-y}.png' });
});

test('downloads refuse OpenStreetMap servers, oversized areas and bad zooms', async () => {
  const base = { bounds: [-105, 39, -104, 40], minZoom: 6, maxZoom: 10, name: 'x' };
  await assert.rejects(sas.api('POST', '/api/map/download', { ...base, url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' }), /usage policy/);
  await assert.rejects(sas.api('POST', '/api/map/download', { ...base, url: 'https://tiles.example.com/{z}/{x}/{y}.png', bounds: [-125, 25, -66, 49], maxZoom: 14 }), /limit/);
  await assert.rejects(sas.api('POST', '/api/map/download', { ...base, url: 'https://tiles.example.com/{z}/{x}/{y}.png', minZoom: 9, maxZoom: 4 }), /Zoom/);
  await assert.rejects(sas.api('POST', '/api/map/download', { ...base, url: 'ftp://tiles.example.com/{z}/{x}/{y}.png' }), /http/);
});

test('deleting a tile set removes it from the store', async () => {
  await sas.api('DELETE', '/api/map/tiles/folder');
  const m = await sas.api('GET', '/api/map');
  assert.deepEqual(m.store.sets.map((s: any) => s.id), ['lab.mbtiles']);
  assert.equal(fs.existsSync(path.join(tilesDir, 'folder')), false);
  await assert.rejects(sas.api('DELETE', '/api/map/tiles/..'), /404/);
});

test('static files are gzip-compressed for clients that accept it', async () => {
  const r = await fetch(`http://127.0.0.1:${sas.uiPort}/third-party-notices.txt`, { headers: { 'Accept-Encoding': 'gzip' } });
  if (r.headers.get('content-type')?.startsWith('text/html')) return; // web UI not built in this checkout
  assert.equal(r.status, 200);
  // fetch decompresses transparently; the header shows what went over the wire.
  assert.equal(r.headers.get('content-encoding'), 'gzip');
  assert.match(await r.text(), /Third-party notices/);
});
