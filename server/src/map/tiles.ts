import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Bus } from '../bus.ts';

// Offline raster map tiles for the web UI. The tile store is a directory (SAS_TILES_DIR,
// default <data>/tiles) holding MBTiles files (SQLite, the format most tile tools export) and/or
// z/x/y folder trees. The downloader saves an area from a tile server into a new MBTiles file so
// the map keeps working without internet.

export interface TileSet {
  id: string;
  kind: 'mbtiles' | 'directory';
  name: string;
  format: string | null;
  minZoom: number | null;
  maxZoom: number | null;
  /** west, south, east, north */
  bounds: [number, number, number, number] | null;
  attribution: string | null;
  sizeBytes: number | null;
  /** Leaflet can only draw raster tiles (png/jpg/webp). */
  usable: boolean;
  error: string | null;
}

export interface DownloadJob {
  state: 'running' | 'done' | 'failed' | 'cancelled';
  file: string;
  url: string;
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  total: number;
  done: number;
  missing: number;
  failed: number;
  bytes: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const RASTER = new Set(['png', 'jpg', 'jpeg', 'webp']);
export const MAX_DOWNLOAD_TILES = 100_000;

export class TileStore {
  readonly dir: string;
  private sets = new Map<string, TileSet>();
  private dbs = new Map<string, { db: DatabaseSync; get: StatementSync }>();

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.rescan();
  }

  rescan(): TileSet[] {
    for (const { db } of this.dbs.values()) db.close();
    this.dbs.clear();
    this.sets.clear();
    for (const ent of fs.readdirSync(this.dir, { withFileTypes: true })) {
      const p = path.join(this.dir, ent.name);
      if (ent.isFile() && ent.name.endsWith('.mbtiles')) {
        this.sets.set(ent.name, this.openMbtiles(ent.name, p));
      } else if (ent.isDirectory()) {
        const s = scanDirectory(ent.name, p);
        if (s) this.sets.set(ent.name, s);
      }
    }
    return this.list();
  }

  list(): TileSet[] {
    return [...this.sets.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The named tile set, or the first usable one when the name is empty or unknown. */
  pick(id: string): TileSet | null {
    const named = id ? this.sets.get(id) : undefined;
    if (named?.usable) return named;
    return this.list().find((s) => s.usable) ?? null;
  }

  tile(id: string, z: number, x: number, y: number): { data: Buffer; type: string } | null {
    const s = this.sets.get(id);
    if (!s?.usable || !s.format) return null;
    if (s.kind === 'mbtiles') {
      const h = this.dbs.get(id);
      // MBTiles rows are numbered bottom-up (TMS); Leaflet asks top-down (XYZ).
      const row = h?.get.get(z, x, (1 << z) - 1 - y) as { tile_data: Uint8Array } | undefined;
      return row ? { data: Buffer.from(row.tile_data), type: MIME[s.format] } : null;
    }
    const file = path.join(this.dir, id, String(z), String(x), `${y}.${s.format}`);
    return fs.existsSync(file) ? { data: fs.readFileSync(file), type: MIME[s.format] } : null;
  }

  remove(id: string) {
    const s = this.sets.get(id);
    if (!s) throw new Error('Unknown tile set');
    this.dbs.get(id)?.db.close();
    this.dbs.delete(id);
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    this.rescan();
  }

  private openMbtiles(id: string, file: string): TileSet {
    const base: TileSet = {
      id, kind: 'mbtiles', name: id.replace(/\.mbtiles$/, ''), format: null, minZoom: null, maxZoom: null, bounds: null,
      attribution: null, sizeBytes: fs.statSync(file).size, usable: false, error: null,
    };
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      const meta: Record<string, string> = {};
      for (const r of db.prepare('SELECT name, value FROM metadata').all() as Array<{ name: string; value: string }>) meta[r.name] = r.value;
      let format = (meta.format ?? '').toLowerCase() || null;
      if (!format) {
        const t = db.prepare('SELECT tile_data FROM tiles LIMIT 1').get() as { tile_data: Uint8Array } | undefined;
        format = t ? sniffFormat(Buffer.from(t.tile_data)) : null;
      }
      let minZoom = toNum(meta.minzoom);
      let maxZoom = toNum(meta.maxzoom);
      if (minZoom == null || maxZoom == null) {
        const r = db.prepare('SELECT MIN(zoom_level) AS lo, MAX(zoom_level) AS hi FROM tiles').get() as { lo: number | null; hi: number | null };
        minZoom ??= r.lo;
        maxZoom ??= r.hi;
      }
      const b = (meta.bounds ?? '').split(',').map(Number);
      const usable = !!format && RASTER.has(format);
      if (usable) this.dbs.set(id, { db, get: db.prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?') });
      else db.close();
      return {
        ...base, name: meta.name || base.name, format: format === 'jpeg' ? 'jpg' : format, minZoom, maxZoom,
        bounds: b.length === 4 && b.every(Number.isFinite) ? (b as [number, number, number, number]) : null,
        attribution: meta.attribution || null, usable,
        error: usable ? null : format === 'pbf' ? 'Vector tiles (pbf) are not supported; use a raster MBTiles file' : 'Unknown tile format',
      };
    } catch (e: any) {
      return { ...base, error: `Not a readable MBTiles file: ${e.message}` };
    }
  }
}

/** A z/x/y.{png,jpg,webp} folder tree, or null if the folder does not look like one. */
function scanDirectory(id: string, dir: string): TileSet | null {
  const zooms = fs.readdirSync(dir).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b);
  if (!zooms.length) return null;
  let format: string | null = null;
  outer: for (const z of zooms) {
    for (const x of fs.readdirSync(path.join(dir, String(z)))) {
      const f = fs.readdirSync(path.join(dir, String(z), x)).find((n) => /^\d+\.(png|jpe?g|webp)$/i.test(n));
      if (f) {
        format = f.split('.').pop()!.toLowerCase();
        break outer;
      }
    }
  }
  return {
    id, kind: 'directory', name: id, format, minZoom: zooms[0], maxZoom: zooms[zooms.length - 1], bounds: null,
    attribution: null, sizeBytes: null, usable: !!format, error: format ? null : 'No tile images found in the z/x/y folders',
  };
}

function sniffFormat(b: Buffer): string | null {
  if (b[0] === 0x89 && b[1] === 0x50) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'pbf';
  return null;
}

function toNum(v: string | undefined): number | null {
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- tile maths

function lon2x(lon: number, z: number): number {
  return Math.min((1 << z) - 1, Math.max(0, Math.floor(((lon + 180) / 360) * (1 << z))));
}

function lat2y(lat: number, z: number): number {
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * (1 << z));
  return Math.min((1 << z) - 1, Math.max(0, y));
}

/** Tile ranges per zoom covering bounds = [west, south, east, north]. */
export function tileRanges(bounds: [number, number, number, number], minZoom: number, maxZoom: number) {
  const [w, s, e, n] = bounds;
  const out: Array<{ z: number; x0: number; x1: number; y0: number; y1: number }> = [];
  for (let z = minZoom; z <= maxZoom; z++) out.push({ z, x0: lon2x(w, z), x1: lon2x(e, z), y0: lat2y(n, z), y1: lat2y(s, z) });
  return out;
}

export function tileCount(bounds: [number, number, number, number], minZoom: number, maxZoom: number): number {
  return tileRanges(bounds, minZoom, maxZoom).reduce((a, r) => a + (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1), 0);
}

// ---------------------------------------------------------------- downloader

export class TileDownloader {
  job: DownloadJob | null = null;
  private store: TileStore;
  private bus: Bus;
  private abort: AbortController | null = null;

  constructor(store: TileStore, bus: Bus) {
    this.store = store;
    this.bus = bus;
  }

  start(o: { url: string; bounds: [number, number, number, number]; minZoom: number; maxZoom: number; name: string; attribution: string }): DownloadJob {
    if (this.job?.state === 'running') throw new Error('A download is already running');
    const url = validateTemplate(o.url);
    if (/(^|\.)(openstreetmap\.(org|fr|de)|osm\.org)$/i.test(url.host)) {
      throw new Error("OpenStreetMap's tile usage policy forbids bulk downloading from its tile servers. Use a public-domain source such as USGS The National Map.");
    }
    const [w, s, e, n] = o.bounds;
    if (![w, s, e, n].every(Number.isFinite) || w >= e || s >= n || w < -180 || e > 180 || s < -85.06 || n > 85.06) throw new Error('Invalid bounds');
    if (!Number.isInteger(o.minZoom) || !Number.isInteger(o.maxZoom) || o.minZoom < 0 || o.maxZoom > 18 || o.minZoom > o.maxZoom) {
      throw new Error('Zoom levels must be whole numbers with 0 ≤ min ≤ max ≤ 18');
    }
    const total = tileCount(o.bounds, o.minZoom, o.maxZoom);
    if (total > MAX_DOWNLOAD_TILES) throw new Error(`That area is ${total.toLocaleString('en-US')} tiles; the limit is ${MAX_DOWNLOAD_TILES.toLocaleString('en-US')}. Lower the maximum zoom or shrink the area.`);
    const name = (o.name || 'offline').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'offline';
    const file = `${name}.mbtiles`;
    this.job = {
      state: 'running', file, url: o.url, bounds: o.bounds, minZoom: o.minZoom, maxZoom: o.maxZoom, total, done: 0, missing: 0, failed: 0, bytes: 0,
      startedAt: Date.now(), finishedAt: null, error: null,
    };
    this.abort = new AbortController();
    this.bus.event('info', 'map', `Downloading ${total.toLocaleString('en-US')} map tiles (zoom ${o.minZoom}–${o.maxZoom}) into ${file}`);
    void this.run(this.job, this.abort.signal, o.attribution);
    this.bus.changed('map');
    return this.job;
  }

  cancel() {
    if (this.job?.state === 'running') this.abort?.abort();
  }

  private async run(job: DownloadJob, signal: AbortSignal, attribution: string) {
    const part = path.join(this.store.dir, `${job.file}.part`);
    fs.rmSync(part, { force: true });
    const db = new DatabaseSync(part);
    db.exec(`CREATE TABLE metadata (name TEXT, value TEXT);
      CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
      CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);`);
    const put = db.prepare('INSERT OR REPLACE INTO tiles VALUES (?, ?, ?, ?)');
    let format: string | null = null;
    let lastNotify = 0;
    const notify = () => {
      if (Date.now() - lastNotify > 1000) {
        lastNotify = Date.now();
        this.bus.changed('map');
      }
    };
    const queue = (function* () {
      for (const r of tileRanges(job.bounds, job.minZoom, job.maxZoom)) {
        for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) yield [r.z, x, y] as const;
      }
    })();
    const worker = async () => {
      for (const [z, x, y] of queue) {
        if (signal.aborted) return;
        const got = await fetchTile(expand(job.url, z, x, y), signal);
        if (got === 'missing') job.missing++;
        else if (got === 'failed') job.failed++;
        else {
          format ??= got.format;
          put.run(z, x, (1 << z) - 1 - y, got.data);
          job.bytes += got.data.length;
        }
        job.done++;
        notify();
      }
    };
    try {
      await Promise.all(Array.from({ length: 6 }, worker));
      if (signal.aborted) throw new Error('cancelled');
      if (job.failed > job.total / 2) throw new Error(`${job.failed} of ${job.total} tiles failed to download; check the URL and internet access`);
      const meta = db.prepare('INSERT INTO metadata VALUES (?, ?)');
      const [w, s, e, n] = job.bounds;
      for (const [k, v] of Object.entries({
        name: job.file.replace(/\.mbtiles$/, ''), format: format ?? 'png', type: 'baselayer', version: '1.0',
        minzoom: String(job.minZoom), maxzoom: String(job.maxZoom), bounds: `${w},${s},${e},${n}`,
        attribution, description: `Downloaded by SASBench from ${job.url}`,
      })) meta.run(k, v);
      db.close();
      fs.renameSync(part, path.join(this.store.dir, job.file));
      job.state = 'done';
      this.store.rescan();
      this.bus.event('success', 'map', `Offline map ${job.file} ready: ${(job.done - job.missing - job.failed).toLocaleString('en-US')} tiles, ${(job.bytes / 1e6).toFixed(1)} MB`);
    } catch (e: any) {
      try { db.close(); } catch { /* already closed */ }
      fs.rmSync(part, { force: true });
      job.state = signal.aborted ? 'cancelled' : 'failed';
      job.error = signal.aborted ? null : e.message;
      this.bus.event(signal.aborted ? 'info' : 'error', 'map', signal.aborted ? `Map tile download cancelled (${job.file})` : `Map tile download failed: ${e.message}`);
    } finally {
      job.finishedAt = Date.now();
      this.abort = null;
      this.bus.changed('map');
    }
  }
}

/** Checks a {z}/{x}/{y} URL template and returns it parsed (with sample values). */
export function validateTemplate(template: string): URL {
  if (!/\{z\}/.test(template) || !/\{x\}/.test(template) || !/\{-?y\}/.test(template)) throw new Error('The tile URL must contain {z}, {x} and {y}');
  let url: URL;
  try {
    url = new URL(expand(template, 0, 0, 0));
  } catch {
    throw new Error('The tile URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The tile URL must start with http:// or https://');
  return url;
}

function expand(t: string, z: number, x: number, y: number): string {
  return t.replace('{s}', 'abc'[(x + y) % 3]).replace('{z}', String(z)).replace('{x}', String(x))
    .replace('{-y}', String((1 << z) - 1 - y)).replace('{y}', String(y));
}

async function fetchTile(url: string, signal: AbortSignal): Promise<{ data: Buffer; format: string } | 'missing' | 'failed'> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted) return 'failed';
    try {
      const r = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), headers: { 'User-Agent': 'SASBench offline map cache' } });
      if (r.status === 404 || r.status === 204) return 'missing';
      if (r.ok) {
        const data = Buffer.from(await r.arrayBuffer());
        const format = sniffFormat(data);
        if (format && RASTER.has(format)) return { data, format };
        return 'missing'; // e.g. a blank/HTML placeholder
      }
      if (r.status < 500 && r.status !== 429) return 'failed';
    } catch {
      if (signal.aborted) return 'failed';
    }
    await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
  }
  return 'failed';
}
