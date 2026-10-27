import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Bus } from '../bus.ts';

// Download of USGS 3DEP 1-arc-second elevation tiles (public domain) for the Category A outdoor
// HAAT check, shared by the fetch-terrain.ts command-line tool and the API's terrain download job.

/** USGS staged products. SAS_TERRAIN_SOURCE_URL points at a mirror with the same layout. */
export const USGS_BASE = 'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1/TIFF/current';

export const terrainSource = () => (process.env.SAS_TERRAIN_SOURCE_URL || USGS_BASE).replace(/\/+$/, '');

// CBSD installation points in the harness's CBSD-facing suites (REG, DRG, SIQ, GRA, HBT, RLQ, MES,
// SCS): testcases/testdata/device_*.json plus the locations the test cases set themselves.
export const HARNESS_POINTS: Array<[number, number]> = [
  [39.0119, -98.4842], [39.139836, -97.770094], [38.815291, -97.198805], [39.190944, -99.022535], // device_a–d
  [39.173912, -99.923414], [38.815291, -100.253004], [39.32705, -100.604567], // device_e–g
  [42.0001, -110.0001], [42.6001, -105.0001], [41.6001, -105.0001], // device_h–j
  [38.882162, -77.113755], [38.882162, -77.013055], // REG.7 elements 7 and 13
  [36.711538, -76.016275], // HBT
  [30.7157, -88.0935], [38.2, -99.5], [38.4, -98.9], [38.775, -97.291], [38.82767, -97.20497], // SIQ
  [38.854, -97.195], [39.0, -98.6], [40.0, -97.87],
];

export const TILE_NAME = /^[ns]\d{2}[ew]\d{3}$/;

/** Tiles already present in any supported naming (USGS GeoTIFF, NED GridFloat). */
export function presentTiles(dir: string): Set<string> {
  const out = new Set<string>();
  // As deep as the terrain index looks (sas/terrain.ts): the folder and two levels of subfolders.
  const scan = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < 2) scan(path.join(d, e.name), depth + 1);
      } else if (/\.(flt|tiff?)$/i.test(e.name)) {
        const m = /([ns]\d{2}[ew]\d{3})/i.exec(e.name);
        if (m) out.add(m[1].toLowerCase());
      }
    }
  };
  scan(dir, 0);
  return out;
}

export type FetchOutcome = { status: 'present' } | { status: 'unavailable' } | { status: 'downloaded'; bytes: number };

/** Download one tile into dir as USGS_1_<name>.tif. Throws on network or HTTP errors. */
export async function fetchTile(name: string, dir: string, o: { force?: boolean; present?: Set<string>; signal?: AbortSignal } = {}): Promise<FetchOutcome> {
  if (!o.force && (o.present ?? presentTiles(dir)).has(name)) return { status: 'present' };
  const file = path.join(dir, `USGS_1_${name}.tif`);
  const res = await fetch(`${terrainSource()}/${name}/USGS_1_${name}.tif`, { signal: o.signal });
  // S3 answers 403 or 404 for keys that do not exist: open ocean or outside USGS coverage.
  if (res.status === 403 || res.status === 404) return { status: 'unavailable' };
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const part = `${file}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(part), { signal: o.signal });
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
  fs.renameSync(part, file);
  return { status: 'downloaded', bytes: fs.statSync(file).size };
}

export interface TerrainTileJob {
  name: string;
  status: 'queued' | 'downloading' | 'downloaded' | 'present' | 'unavailable' | 'failed' | 'cancelled';
  bytes: number | null;
  error: string | null;
}

export interface TerrainJob {
  state: 'running' | 'done' | 'failed' | 'cancelled';
  directory: string;
  source: string;
  force: boolean;
  total: number;
  finished: number;
  failed: number;
  bytes: number;
  tiles: TerrainTileJob[];
  startedAt: number;
  finishedAt: number | null;
}

/** One background download at a time, three tiles in parallel (as the command-line tool). */
export class TerrainDownloader {
  job: TerrainJob | null = null;
  private abort: AbortController | null = null;
  private dir: () => string | null;
  private onTiles: () => void;
  private bus: Bus;

  constructor(dir: () => string | null, onTiles: () => void, bus: Bus) {
    this.dir = dir;
    this.onTiles = onTiles;
    this.bus = bus;
  }

  start(o: { tiles: string[]; force: boolean }): TerrainJob {
    if (this.job?.state === 'running') throw new Error('A terrain download is already running');
    const dir = this.dir();
    if (!dir) throw new Error('No terrain directory is configured');
    const names = [...new Set(o.tiles.map((t) => t.toLowerCase()))].sort();
    if (!names.length) throw new Error('No tiles to download');
    const bad = names.filter((n) => !TILE_NAME.test(n));
    if (bad.length) throw new Error(`Invalid tile name(s): ${bad.join(', ')} (expected e.g. n39w078)`);
    fs.mkdirSync(dir, { recursive: true });
    this.job = {
      state: 'running', directory: dir, source: terrainSource(), force: o.force, total: names.length, finished: 0, failed: 0, bytes: 0,
      tiles: names.map((name) => ({ name, status: 'queued', bytes: null, error: null })), startedAt: Date.now(), finishedAt: null,
    };
    this.abort = new AbortController();
    this.bus.event('info', 'terrain', `Downloading ${names.length} terrain tile(s) into ${dir}`);
    void this.run(this.job, dir, this.abort.signal);
    this.bus.changed('terrain');
    return this.job;
  }

  cancel(): boolean {
    if (this.job?.state !== 'running') return false;
    this.abort?.abort();
    return true;
  }

  private async run(job: TerrainJob, dir: string, signal: AbortSignal) {
    const present = presentTiles(dir);
    const queue = [...job.tiles];
    await Promise.all(Array.from({ length: 3 }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        if (signal.aborted) {
          t.status = 'cancelled';
          continue;
        }
        t.status = 'downloading';
        try {
          const r = await fetchTile(t.name, dir, { force: job.force, present, signal });
          t.status = r.status;
          if (r.status === 'downloaded') {
            t.bytes = r.bytes;
            job.bytes += r.bytes;
          }
        } catch (e: any) {
          if (signal.aborted) t.status = 'cancelled';
          else {
            t.status = 'failed';
            t.error = e.message;
            job.failed++;
          }
        }
        job.finished++;
        this.bus.changed('terrain');
      }
    }));
    job.state = signal.aborted ? 'cancelled' : job.failed ? 'failed' : 'done';
    job.finishedAt = Date.now();
    this.onTiles();
    const got = job.tiles.filter((t) => t.status === 'downloaded').length;
    this.bus.event(job.failed ? 'warn' : 'info', 'terrain',
      `Terrain download ${job.state}: ${got} downloaded, ${job.tiles.filter((t) => t.status === 'present').length} already present, ${job.failed} failed`);
    this.bus.changed('terrain');
  }
}
