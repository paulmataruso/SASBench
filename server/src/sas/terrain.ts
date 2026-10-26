import fs from 'node:fs';
import path from 'node:path';
import { unzlibSync } from 'fflate';

// Optional terrain support for the Category A outdoor HAAT rule (FCC 96.43(b), WINNF-TS-0016
// §8.3 / reference_models/tools/cata_max_height.py). Reads 1-arc-second elevation tiles named
// after their north-west corner (n40w101):
//   - USGS 3DEP GeoTIFF as USGS publishes it today, e.g. USGS_1_n40w101.tif
//     (download with `node server/src/tools/fetch-terrain.ts`);
//   - NED GridFloat (.flt + .hdr) as in the WInnForum Common-Data repository, e.g.
//     floatn40w101_1_std.flt / usgs_ned_1_n40w101_gridfloat_std.flt.
// Missing tiles simply disable the check for that location. Files added while the SAS runs are
// found on the next lookup (the directory is rescanned at most every 30 s).

interface Grid {
  file: string;
  fd: number;
  ncols: number;
  nrows: number;
  left: number; // west edge of the raster (degrees)
  top: number; // north edge
  cell: number; // degrees per sample
  nodata: number;
  little: boolean;
}
interface FltTile extends Grid {
  kind: 'flt';
}
interface TifTile extends Grid {
  kind: 'tif';
  blockW: number;
  blockH: number;
  blocksAcross: number;
  offsets: number[];
  counts: number[];
  compression: number;
  predictor: number;
}
type Tile = FltTile | TifTile;

const R_EARTH_M = 6378137.0;
const MAX_BLOCKS = 64; // decoded GeoTIFF blocks kept in memory (512×512 floats = 1 MB each)

export class Terrain {
  private root: string | null;
  private rescanMs: number;
  private scannedAt = 0;
  private index = new Map<string, string>();
  private tiles = new Map<string, Tile | null>();
  private blocks = new Map<string, Float32Array>();

  constructor(dir: string | null, opts: { rescanMs?: number } = {}) {
    this.root = dir;
    this.rescanMs = opts.rescanMs ?? 30_000;
    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch { /* read-only location: use whatever is there */ }
    }
    this.reindex();
  }

  /** Rescans the directory. Tiles whose file is unchanged stay open; new files become visible. */
  reindex() {
    const next = new Map<string, string>();
    const scan = (d: string, depth: number) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory() && depth < 2) scan(p, depth + 1);
        else if (ent.isFile() && /\.(flt|tiff?)$/i.test(ent.name)) {
          const m = /([ns]\d{2})([ew]\d{3})/i.exec(ent.name);
          if (!m) continue;
          const key = (m[1] + m[2]).toLowerCase();
          // GridFloat wins over GeoTIFF: it is what the WInnForum reference models read.
          if (!next.has(key) || p.endsWith('.flt')) next.set(key, p);
        }
      }
    };
    if (this.root && fs.existsSync(this.root)) scan(this.root, 0);
    let closed = false;
    for (const [key, t] of this.tiles) {
      if (t && next.get(key) === t.file) continue;
      if (t) {
        fs.closeSync(t.fd);
        closed = true;
      }
      this.tiles.delete(key); // also forgets "no tile here" answers
    }
    if (closed) this.blocks.clear();
    this.index = next;
    this.scannedAt = Date.now();
  }

  private rescanIfStale() {
    if (Date.now() - this.scannedAt >= this.rescanMs) this.reindex();
  }

  get tileCount(): number {
    this.rescanIfStale();
    return this.index.size;
  }

  get directory(): string | null {
    return this.root;
  }

  private tileFor(lat: number, lon: number): Tile | null {
    const key = tileKey(lat, lon);
    if (this.tiles.has(key)) return this.tiles.get(key)!;
    this.rescanIfStale();
    const file = this.index.get(key);
    let tile: Tile | null = null;
    if (file) {
      try {
        tile = file.endsWith('.flt') ? openGridFloat(file) : openGeoTiff(file);
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
    let v: number;
    if (t.kind === 'flt') {
      const buf = Buffer.alloc(4);
      fs.readSync(t.fd, buf, 0, 4, (row * t.ncols + col) * 4);
      v = t.little ? buf.readFloatLE(0) : buf.readFloatBE(0);
    } else {
      const bx = Math.floor(col / t.blockW);
      const by = Math.floor(row / t.blockH);
      v = this.block(t, by * t.blocksAcross + bx)[(row % t.blockH) * t.blockW + (col % t.blockW)];
    }
    return v === t.nodata || !Number.isFinite(v) ? 0 : v;
  }

  private block(t: TifTile, i: number): Float32Array {
    const key = `${t.file}#${i}`;
    let b = this.blocks.get(key);
    if (b) {
      this.blocks.delete(key); // move to the most-recently-used end
    } else {
      b = decodeBlock(t, i);
      if (this.blocks.size >= MAX_BLOCKS) this.blocks.delete(this.blocks.keys().next().value!);
    }
    this.blocks.set(key, b);
    return b;
  }

  /** Terrain elevation (m AMSL) with bilinear interpolation, or null when no tile covers the point. */
  elevation(lat: number, lon: number): number | null {
    const t = this.tileFor(lat, lon);
    if (!t) return null;
    const fr = (t.top - lat) / t.cell - 0.5;
    const fc = (lon - t.left) / t.cell - 0.5;
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
    for (const [plat, plon] of radialPoints(lat, lon)) {
      const e = this.elevation(plat, plon);
      if (e == null) return null;
      sum += e;
      n++;
    }
    const mean = sum / n;
    const amsl = heightType === 'AMSL' ? height : center + height;
    return amsl - mean;
  }
}

/** Name of the 1°×1° tile holding a point, after its north-west corner: n40w101. */
export function tileKey(lat: number, lon: number): string {
  const la = Math.ceil(lat);
  const lo = Math.floor(lon);
  return `${la >= 0 ? 'n' : 's'}${String(Math.abs(la)).padStart(2, '0')}${lo < 0 ? 'w' : 'e'}${String(Math.abs(lo)).padStart(3, '0')}`;
}

/** Tiles a HAAT computation at this point reads: its own and those under the radials. */
export function haatTiles(lat: number, lon: number): string[] {
  const keys = new Set([tileKey(lat, lon)]);
  for (const [a, o] of radialPoints(lat, lon)) keys.add(tileKey(a, o));
  return [...keys].sort();
}

function radialPoints(lat: number, lon: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let az = 0; az < 360; az += 45) {
    for (let i = 0; i < 50; i++) pts.push(destination(lat, lon, az, (3 + (13 * i) / 49) * 1000));
  }
  return pts;
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

function openGridFloat(file: string): FltTile {
  const hdr = fs.readFileSync(file.replace(/\.flt$/, '.hdr'), 'utf8');
  const h: Record<string, string> = {};
  for (const line of hdr.split(/\r?\n/)) {
    const [k, v] = line.trim().split(/\s+/);
    if (k && v) h[k.toLowerCase()] = v;
  }
  const ncols = Number(h.ncols), nrows = Number(h.nrows), cell = Number(h.cellsize);
  // *center variants give the centre of the lower-left sample instead of its corner.
  const xll = h.xllcorner != null ? Number(h.xllcorner) : Number(h.xllcenter) - cell / 2;
  const yll = h.yllcorner != null ? Number(h.yllcorner) : Number(h.yllcenter) - cell / 2;
  return {
    kind: 'flt', file, fd: fs.openSync(file, 'r'), ncols, nrows, cell, left: xll, top: yll + nrows * cell,
    little: !/msb/i.test(h.byteorder ?? 'LSBFIRST'), nodata: Math.fround(Number(h.nodata_value ?? -9999)),
  };
}

// ---- GeoTIFF ------------------------------------------------------------------------------
// Enough of TIFF 6.0 + GeoTIFF for single-band 32-bit float elevation rasters: classic TIFF and
// BigTIFF, tiles or strips, no/LZW/Deflate compression, horizontal floating-point predictor.

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 6: 1, 7: 1, 8: 2, 9: 4, 11: 4, 12: 8, 16: 8 };

function openGeoTiff(file: string): TifTile {
  const fd = fs.openSync(file, 'r');
  try {
    const read = (pos: number, len: number) => {
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, pos);
      return b;
    };
    const head = read(0, 16);
    const bom = head.toString('latin1', 0, 2);
    if (bom !== 'II' && bom !== 'MM') throw new Error('not a TIFF file');
    const little = bom === 'II';
    const u16 = (b: Buffer, o: number) => (little ? b.readUInt16LE(o) : b.readUInt16BE(o));
    const u32 = (b: Buffer, o: number) => (little ? b.readUInt32LE(o) : b.readUInt32BE(o));
    const u64 = (b: Buffer, o: number) => Number(little ? b.readBigUInt64LE(o) : b.readBigUInt64BE(o));
    const version = u16(head, 2);
    if (version !== 42 && version !== 43) throw new Error('not a TIFF file');
    const big = version === 43;
    const ifd = big ? u64(head, 8) : u32(head, 4);
    const n = big ? u64(read(ifd, 8), 0) : u16(read(ifd, 2), 0);
    const esz = big ? 20 : 12;
    const ents = read(ifd + (big ? 8 : 2), n * esz);

    const tags = new Map<number, number[] | string>();
    for (let i = 0; i < n; i++) {
      const e = i * esz;
      const tag = u16(ents, e), type = u16(ents, e + 2);
      const count = big ? u64(ents, e + 4) : u32(ents, e + 4);
      const size = TYPE_SIZE[type];
      if (!size) continue;
      const at = e + (big ? 12 : 8);
      const bytes = size * count;
      const data = bytes <= (big ? 8 : 4) ? ents.subarray(at, at + bytes) : read(big ? u64(ents, at) : u32(ents, at), bytes);
      if (type === 2) {
        tags.set(tag, data.toString('latin1').replace(/\0+$/, ''));
        continue;
      }
      const vals: number[] = [];
      for (let k = 0, o = 0; k < count; k++, o += size) {
        vals.push(
          type === 3 ? u16(data, o)
            : type === 4 ? u32(data, o)
            : type === 16 ? u64(data, o)
            : type === 8 ? (little ? data.readInt16LE(o) : data.readInt16BE(o))
            : type === 9 ? (little ? data.readInt32LE(o) : data.readInt32BE(o))
            : type === 11 ? (little ? data.readFloatLE(o) : data.readFloatBE(o))
            : type === 12 ? (little ? data.readDoubleLE(o) : data.readDoubleBE(o))
            : data[o],
        );
      }
      tags.set(tag, vals);
    }
    const list = (t: number) => {
      const v = tags.get(t);
      return Array.isArray(v) ? v : [];
    };
    const one = (t: number, dflt: number) => list(t)[0] ?? dflt;

    const ncols = one(256, 0), nrows = one(257, 0);
    const bits = one(258, 1), format = one(339, 1), bands = one(277, 1);
    if (bits !== 32 || format !== 3 || bands !== 1) throw new Error(`unsupported samples: need one 32-bit float band, got ${bands} × ${bits}-bit (format ${format})`);
    const compression = one(259, 1), predictor = one(317, 1);
    if (![1, 5, 8, 32946].includes(compression)) throw new Error(`unsupported compression ${compression}`);
    if (predictor !== 1 && predictor !== 3) throw new Error(`unsupported predictor ${predictor}`);
    const tiled = tags.has(322);
    const blockW = tiled ? one(322, 0) : ncols;
    const blockH = tiled ? one(323, 0) : one(278, nrows);
    const offsets = list(tiled ? 324 : 273), counts = list(tiled ? 325 : 279);

    const scale = list(33550), tie = list(33922);
    if (scale.length < 2 || tie.length < 6) throw new Error('no GeoTIFF georeferencing (ModelPixelScale / ModelTiepoint)');
    const cell = scale[0];
    // GTRasterTypeGeoKey (1025): 1 = PixelIsArea (tiepoint at the sample's corner), 2 = PixelIsPoint (its centre).
    const keys = list(34735);
    let rasterType = 1;
    for (let k = 4; k + 3 < keys.length; k += 4) if (keys[k] === 1025 && keys[k + 1] === 0) rasterType = keys[k + 3];
    const half = rasterType === 2 ? cell / 2 : 0;
    const nodata = tags.get(42113);
    return {
      kind: 'tif', file, fd, ncols, nrows, cell, little,
      left: tie[3] - tie[0] * cell - half,
      top: tie[4] + tie[1] * scale[1] + half,
      nodata: typeof nodata === 'string' && nodata.trim() ? Math.fround(Number(nodata)) : NaN,
      blockW, blockH, blocksAcross: Math.ceil(ncols / blockW), offsets, counts, compression, predictor,
    };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

function decodeBlock(t: TifTile, i: number): Float32Array {
  const w = t.blockW, h = t.blockH, size = w * h * 4;
  const raw = Buffer.alloc(t.counts[i] ?? 0);
  if (raw.length) fs.readSync(t.fd, raw, 0, raw.length, t.offsets[i]);
  let bytes: Uint8Array = t.compression === 1 ? raw : t.compression === 5 ? lzwDecode(raw, size) : unzlibSync(raw);
  if (bytes.length < size) {
    const padded = new Uint8Array(size); // last strip, or a missing block
    padded.set(bytes);
    bytes = padded;
  }
  const out = new Float32Array(w * h);
  if (t.predictor === 3) {
    // Each row holds the samples' bytes as planes, most significant first, byte-differenced.
    const tmp = new DataView(new ArrayBuffer(4));
    const rowBytes = w * 4;
    for (let r = 0; r < h; r++) {
      const o = r * rowBytes;
      for (let k = 1; k < rowBytes; k++) bytes[o + k] = (bytes[o + k] + bytes[o + k - 1]) & 0xff;
      for (let c = 0; c < w; c++) {
        tmp.setUint8(0, bytes[o + c]);
        tmp.setUint8(1, bytes[o + w + c]);
        tmp.setUint8(2, bytes[o + 2 * w + c]);
        tmp.setUint8(3, bytes[o + 3 * w + c]);
        out[r * w + c] = tmp.getFloat32(0, false);
      }
    }
  } else {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, size);
    for (let k = 0; k < out.length; k++) out[k] = dv.getFloat32(k * 4, t.little);
  }
  return out;
}

/** TIFF LZW (MSB-first codes, 9–12 bits, early change), decoding at most `size` bytes. */
export function lzwDecode(src: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  const prefix = new Int16Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096), len = new Uint16Array(4096);
  for (let k = 0; k < 256; k++) {
    prefix[k] = -1;
    suffix[k] = k;
    first[k] = k;
    len[k] = 1;
  }
  let next = 258, width = 9, old = -1, op = 0, pos = 0;
  const end = src.length * 8;
  const emit = (code: number) => {
    for (let p = op + len[code] - 1, c = code; c >= 0; p--, c = prefix[c]) if (p < size) out[p] = suffix[c];
    op += len[code];
  };
  const add = (pre: number, byte: number) => {
    if (next >= 4096) return;
    prefix[next] = pre;
    suffix[next] = byte;
    first[next] = first[pre];
    len[next] = len[pre] + 1;
    next++;
  };
  while (op < size && pos + width <= end) {
    const b = pos >>> 3;
    const code = ((((src[b] << 16) | ((src[b + 1] ?? 0) << 8) | (src[b + 2] ?? 0)) >>> (24 - (pos & 7) - width)) & ((1 << width) - 1));
    pos += width;
    if (code === 257) break; // end of information
    if (code === 256) { // clear
      next = 258;
      width = 9;
      old = -1;
      continue;
    }
    if (old < 0) {
      if (code > 255) break;
      emit(code);
    } else if (code < next) {
      emit(code);
      add(old, first[code]);
    } else if (code === next) {
      add(old, first[old]);
      emit(code);
    } else {
      break; // corrupt stream
    }
    old = code;
    if (next >= (1 << width) - 1 && width < 12) width++;
  }
  return out;
}
