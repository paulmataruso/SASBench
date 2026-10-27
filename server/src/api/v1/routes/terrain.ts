import fs from 'node:fs';
import path from 'node:path';
import { haatTiles, tileKey } from '../../../sas/terrain.ts';
import { HARNESS_POINTS, TILE_NAME, presentTiles, terrainSource } from '../../../tools/terrainFetch.ts';
import type { Route, V1Deps } from '../http.ts';
import { accepted, badRequest, conflict } from '../http.ts';
import { S, ref } from '../schema.ts';
import { ok, okRef } from './common.ts';

// Terrain: the 1-arc-second elevation tiles used for the Category A outdoor HAAT check
// (with the haatCheck setting on, registration rejects a Category A outdoor CBSD whose antenna HAAT exceeds 6 m).

const lat = S.num({ minimum: -90, maximum: 90 });
const lon = S.num({ minimum: -180, maximum: 180 });
const point = S.obj({ lat, lon }, ['lat', 'lon']);

/** Elevation files under the terrain directory (two levels deep, as the terrain index scans). */
function tileFiles(dir: string | null) {
  const out: Array<{ name: string; file: string; sizeBytes: number }> = [];
  if (!dir || !fs.existsSync(dir)) return out;
  const scan = (d: string, depth: number) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory() && depth < 2) scan(p, depth + 1);
      else if (ent.isFile() && /\.(flt|tiff?)$/i.test(ent.name)) {
        const m = /([ns]\d{2}[ew]\d{3})/i.exec(ent.name);
        if (m) out.push({ name: m[1].toLowerCase(), file: path.relative(dir, p), sizeBytes: fs.statSync(p).size });
      }
    }
  };
  scan(dir, 0);
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
}

function needed(d: V1Deps, tiles: string[]) {
  const dir = d.engine.terrain?.directory ?? null;
  const present = dir ? presentTiles(dir) : new Set<string>();
  const all = [...new Set(tiles)].sort();
  return { tiles: all, present: all.filter((t) => present.has(t)), missing: all.filter((t) => !present.has(t)) };
}

function terrainOr409(d: V1Deps) {
  const t = d.engine.terrain;
  if (!t) throw conflict('Terrain is not configured');
  return t;
}

/** Tile names from an explicit list, points to cover for HAAT, and/or the harness test locations. */
function tilesFor(b: { tiles?: string[]; around?: Array<{ lat: number; lon: number }>; harness?: boolean }): string[] {
  const out = new Set<string>();
  for (const t of b.tiles ?? []) {
    if (!TILE_NAME.test(t.toLowerCase())) throw badRequest(`Invalid tile name ${t} (expected e.g. n39w078)`);
    out.add(t.toLowerCase());
  }
  for (const p of b.around ?? []) for (const t of haatTiles(p.lat, p.lon)) out.add(t);
  if (b.harness) for (const [a, o] of HARNESS_POINTS) for (const t of haatTiles(a, o)) out.add(t);
  return [...out].sort();
}

export const terrainRoutes: Route[] = [
  {
    method: 'GET', path: '/terrain', operationId: 'getTerrain', tag: 'Terrain', scope: 'read',
    summary: 'Terrain tiles',
    description: 'The terrain directory (SAS_TERRAIN_DIR), the elevation tiles found there, where downloads come from, and the current download job. With no tiles, the HAAT check is skipped (and logged).',
    responses: okRef('Terrain.', 'Terrain'),
    handler: ({ d }) => {
      const t = d.engine.terrain;
      t?.reindex();
      const files = tileFiles(t?.directory ?? null);
      return {
        directory: t?.directory ?? null, tileCount: t?.tileCount ?? 0, files, source: terrainSource(), download: d.terrainDownloader.job,
      };
    },
  },
  {
    method: 'POST', path: '/terrain/rescan', operationId: 'rescanTerrain', tag: 'Terrain', scope: 'write', errors: [409],
    summary: 'Rescan the terrain directory', description: 'Makes tiles copied in by hand visible at once (otherwise within 30 s).',
    responses: ok('Tile count.', S.obj({ tileCount: S.int() }, ['tileCount'])),
    handler: ({ d }) => {
      const t = terrainOr409(d);
      t.reindex();
      d.bus.changed('terrain');
      return { tileCount: t.tileCount };
    },
  },
  {
    method: 'GET', path: '/terrain/elevation', operationId: 'getElevation', tag: 'Terrain', scope: 'read', errors: [409],
    summary: 'Terrain elevation at a point', description: 'Metres above mean sea level, bilinear interpolation. Null when no tile covers the point.',
    query: { lat: { description: 'Latitude.', schema: lat, required: true }, lon: { description: 'Longitude.', schema: lon, required: true } },
    responses: ok('Elevation.', S.obj({ lat: S.num(), lon: S.num(), tile: S.str(), elevationM: S.nullable(S.num()) }, ['lat', 'lon', 'tile', 'elevationM'])),
    handler: ({ d, query }) => ({ lat: query.lat, lon: query.lon, tile: tileKey(query.lat, query.lon), elevationM: terrainOr409(d).elevation(query.lat, query.lon) }),
  },
  {
    method: 'GET', path: '/terrain/haat', operationId: 'getHaat', tag: 'Terrain', scope: 'read', errors: [409],
    summary: 'Height above average terrain',
    description: 'As the registration check computes it (reference_models/geo/terrain.py): 8 radials × 50 points from 3 to 16 km; HAAT = antenna height AMSL − mean radial elevation. Null when a needed tile is missing; `missingTiles` lists them.',
    query: {
      lat: { description: 'Latitude.', schema: lat, required: true }, lon: { description: 'Longitude.', schema: lon, required: true },
      height: { description: 'Antenna height (m).', schema: S.num(), required: true },
      heightType: { description: 'AGL or AMSL.', schema: S.enum(['AGL', 'AMSL'], { default: 'AGL' }) },
    },
    responses: ok('HAAT.', S.obj({
      lat: S.num(), lon: S.num(), height: S.num(), heightType: S.str(), haatM: S.nullable(S.num()), elevationM: S.nullable(S.num()),
      tiles: S.arr(S.str()), missingTiles: S.arr(S.str()),
    }, ['lat', 'lon', 'height', 'heightType', 'haatM', 'elevationM', 'tiles', 'missingTiles'])),
    handler: ({ d, query }) => {
      const t = terrainOr409(d);
      const n = needed(d, haatTiles(query.lat, query.lon));
      return {
        lat: query.lat, lon: query.lon, height: query.height, heightType: query.heightType,
        haatM: t.haat(query.lat, query.lon, query.height, query.heightType), elevationM: t.elevation(query.lat, query.lon),
        tiles: n.tiles, missingTiles: n.missing,
      };
    },
  },
  {
    method: 'GET', path: '/terrain/tiles-needed', operationId: 'getTerrainTilesNeeded', tag: 'Terrain', scope: 'read',
    summary: 'Tiles needed for HAAT at some points',
    description: 'The tiles a HAAT computation reads around each point (its own and those under the 16 km radials), and which of them are present.',
    query: {
      points: { description: 'Semicolon-separated "lat,lon" pairs, e.g. 39.01,-98.48;38.8,-97.2', schema: S.str({ pattern: '^-?[\\d.]+,-?[\\d.]+(;-?[\\d.]+,-?[\\d.]+)*$' }) },
      harness: { description: 'Include the CBSD locations used by the WInnForum harness CBSD test suites.', schema: S.bool({ default: false }) },
    },
    responses: okRef('Tiles.', 'TerrainTilesNeeded'),
    handler: ({ d, query }) => {
      const around = (query.points ? String(query.points).split(';') : []).map((p) => {
        const [a, o] = p.split(',').map(Number);
        if (!(a >= -90 && a <= 90 && o >= -180 && o <= 180)) throw badRequest(`Invalid point ${p}`);
        return { lat: a, lon: o };
      });
      if (!around.length && !query.harness) throw badRequest('Give points and/or harness=true');
      return needed(d, tilesFor({ around, harness: query.harness }));
    },
  },
  {
    method: 'GET', path: '/terrain/download', operationId: 'getTerrainDownload', tag: 'Terrain', scope: 'read',
    summary: 'Current or last terrain download', description: 'Null when no download has run since the SAS started.',
    responses: ok('The job.', S.obj({ job: S.nullable(ref('TerrainDownloadJob')) }, ['job'])),
    handler: ({ d }) => ({ job: d.terrainDownloader.job }),
  },
  {
    method: 'POST', path: '/terrain/download', operationId: 'startTerrainDownload', tag: 'Terrain', scope: 'write', errors: [409],
    summary: 'Download terrain tiles',
    description: 'Downloads USGS 3DEP 1-arc-second GeoTIFF tiles (public domain, about 50 MB each) into the terrain directory in the background (202), three at a time, like `node server/src/tools/fetch-terrain.ts`. Give tile names, points to cover for HAAT (`around`), and/or `harness: true` for the harness test locations. Tiles already present are skipped unless `force`. Set SAS_TERRAIN_SOURCE_URL to use a mirror.',
    body: {
      schema: S.obj({
        tiles: S.arr(S.str({ pattern: '^[NSns]\\d{2}[EWew]\\d{3}$' }), { description: 'Tile names, e.g. n39w099.' }),
        around: S.arr(point, { description: 'Points to cover for the HAAT computation.' }),
        harness: S.bool({ default: false }), force: S.bool({ default: false }),
      }),
      example: { around: [{ lat: 39.0119, lon: -98.4842 }] },
    },
    responses: { 202: { description: 'Started.', schema: ref('TerrainDownloadJob') } },
    handler: ({ d, body }) => {
      if (d.terrainDownloader.job?.state === 'running') throw conflict('A terrain download is already running');
      const tiles = tilesFor(body);
      if (!tiles.length) throw badRequest('Give tiles, around and/or harness: true');
      try {
        return accepted(d.terrainDownloader.start({ tiles, force: !!body.force }));
      } catch (e: any) {
        throw badRequest(e.message);
      }
    },
  },
  {
    method: 'DELETE', path: '/terrain/download', operationId: 'cancelTerrainDownload', tag: 'Terrain', scope: 'write',
    summary: 'Cancel the terrain download', description: 'Tiles already downloaded are kept; the one in progress is discarded.',
    responses: ok('The job.', S.obj({ cancelled: S.bool(), job: S.nullable(ref('TerrainDownloadJob')) }, ['cancelled', 'job'])),
    handler: ({ d }) => ({ cancelled: d.terrainDownloader.cancel(), job: d.terrainDownloader.job }),
  },
];
