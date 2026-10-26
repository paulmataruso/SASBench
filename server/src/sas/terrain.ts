import fs from 'node:fs';
import path from 'node:path';

// Optional terrain support for the Category A outdoor HAAT rule (FCC 96.43(b), WINNF-TS-0016
// §8.3 / reference_models/tools/cata_max_height.py). Reads USGS NED 1-arc-second GridFloat
// tiles (.flt + .hdr) as distributed in the WInnForum SAS-Data repository, e.g.
//   floatn40w101_1_std.flt / usgs_ned_1_n40w101_gridfloat_std.flt
// Missing tiles simply disable the check for that location.

interface Tile {
  fd: number;
  ncols: number;
  nrows: number;
  xll: number;
  yll: number;
  cell: number;
  little: boolean;
  nodata: number;
}

const R_EARTH_M = 6378137.0;

export class Terrain {
  private dir: string | null;
  private index = new Map<string, string>();
  private tiles = new Map<string, Tile | null>();

  constructor(dir: string | null) {
    this.dir = dir && fs.existsSync(dir) ? dir : null;
    this.reindex();
  }

  reindex() {
    this.index.clear();
    for (const t of this.tiles.values()) if (t) fs.closeSync(t.fd);
    this.tiles.clear();
    if (!this.dir) return;
    const scan = (d: string, depth: number) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory() && depth < 2) scan(p, depth + 1);
        else if (ent.isFile() && ent.name.endsWith('.flt')) {
          const m = /([ns]\d{2})([ew]\d{3})/i.exec(ent.name);
          if (m) this.index.set((m[1] + m[2]).toLowerCase(), p);
        }
      }
    };
    scan(this.dir, 0);
  }

  get tileCount(): number {
    return this.index.size;
  }

  get directory(): string | null {
    return this.dir;
  }

  private tileFor(lat: number, lon: number): Tile | null {
    const la = Math.ceil(lat);
    const lo = Math.floor(lon);
    const key = `${la >= 0 ? 'n' : 's'}${String(Math.abs(la)).padStart(2, '0')}${lo < 0 ? 'w' : 'e'}${String(Math.abs(lo)).padStart(3, '0')}`;
    if (this.tiles.has(key)) return this.tiles.get(key)!;
    const flt = this.index.get(key);
    let tile: Tile | null = null;
    if (flt) {
      try {
        const hdr = fs.readFileSync(flt.replace(/\.flt$/, '.hdr'), 'utf8');
        const h: Record<string, string> = {};
        for (const line of hdr.split(/\r?\n/)) {
          const [k, v] = line.trim().split(/\s+/);
          if (k && v) h[k.toLowerCase()] = v;
        }
        tile = {
          fd: fs.openSync(flt, 'r'),
          ncols: Number(h.ncols), nrows: Number(h.nrows),
          xll: Number(h.xllcorner ?? h.xllcenter), yll: Number(h.yllcorner ?? h.yllcenter),
          cell: Number(h.cellsize), little: !/msb/i.test(h.byteorder ?? 'LSBFIRST'),
          nodata: Number(h.nodata_value ?? -9999),
        };
      } catch {
        tile = null;
      }
    }
    this.tiles.set(key, tile);
    return tile;
  }

  private sample(t: Tile, row: number, col: number): number {
    row = Math.max(0, Math.min(t.nrows - 1, row));
    col = Math.max(0, Math.min(t.ncols - 1, col));
    const buf = Buffer.alloc(4);
    fs.readSync(t.fd, buf, 0, 4, (row * t.ncols + col) * 4);
    const v = t.little ? buf.readFloatLE(0) : buf.readFloatBE(0);
    return v === t.nodata || !Number.isFinite(v) ? 0 : v;
  }

  /** Terrain elevation (m AMSL) with bilinear interpolation, or null when no tile covers the point. */
  elevation(lat: number, lon: number): number | null {
    const t = this.tileFor(lat, lon);
    if (!t) return null;
    const yTop = t.yll + t.nrows * t.cell;
    const fr = (yTop - lat) / t.cell - 0.5;
    const fc = (lon - t.xll) / t.cell - 0.5;
    const r0 = Math.floor(fr);
    const c0 = Math.floor(fc);
    const dr = fr - r0;
    const dc = fc - c0;
    const a = this.sample(t, r0, c0), b = this.sample(t, r0, c0 + 1);
    const c = this.sample(t, r0 + 1, c0), d = this.sample(t, r0 + 1, c0 + 1);
    return a * (1 - dr) * (1 - dc) + b * (1 - dr) * dc + c * dr * (1 - dc) + d * dr * dc;
  }

  /**
   * Height above average terrain of the antenna (m), per reference_models/geo/terrain.py:
   * 8 radials (0..315°) × 50 points evenly spaced 3–16 km; HAAT = antenna AMSL − mean radial elevation.
   */
  haat(lat: number, lon: number, height: number, heightType: string): number | null {
    const center = this.elevation(lat, lon);
    if (center == null) return null;
    let sum = 0;
    let n = 0;
    for (let az = 0; az < 360; az += 45) {
      for (let i = 0; i < 50; i++) {
        const dKm = 3 + (13 * i) / 49;
        const [plat, plon] = destination(lat, lon, az, dKm * 1000);
        const e = this.elevation(plat, plon);
        if (e == null) return null;
        sum += e;
        n++;
      }
    }
    const mean = sum / n;
    const amsl = heightType === 'AMSL' ? height : center + height;
    return amsl - mean;
  }
}

function destination(lat: number, lon: number, azDeg: number, distM: number): [number, number] {
  const r = Math.PI / 180;
  const d = distM / R_EARTH_M;
  const az = azDeg * r;
  const la1 = lat * r;
  const lo1 = lon * r;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(az));
  const lo2 = lo1 + Math.atan2(Math.sin(az) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [la2 / r, lo2 / r];
}
