import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zlibSync } from 'fflate';
import { Terrain, haatTiles, lzwDecode } from '../src/sas/terrain.ts';

// Terrain tiles: GeoTIFF (as USGS publishes them) must read exactly like the same grid as NED
// GridFloat. The fixtures are small synthetic rasters for the 1°×1° tile n40w101.

const LEFT = -101, TOP = 40, N = 150, CELL = 1 / N;
let root: string;

/** Hilly surface with a little pseudo-random noise, so LZW tables fill up and reset. */
function surface(): Float32Array {
  const z = new Float32Array(N * N);
  let seed = 7;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      z[r * N + c] = 800 + 60 * Math.sin(r / 9) + 40 * Math.cos(c / 6) + (seed % 1000) / 100;
    }
  }
  z[5 * N + 7] = -999999; // NoData
  return z;
}

/** TIFF LZW encoder (libtiff-compatible code-width changes and table reset). */
function lzwEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let acc = 0, bits = 0, width = 9;
  const put = (code: number) => {
    acc = (acc << width) | code;
    bits += width;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  };
  let dict = new Map<number, number>();
  let next = 258;
  put(256);
  let prefix = data[0];
  for (let i = 1; i < data.length; i++) {
    const hit = dict.get(prefix * 256 + data[i]);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    put(prefix);
    dict.set(prefix * 256 + data[i], next++);
    if (next === 4094) {
      put(256);
      dict = new Map();
      next = 258;
      width = 9;
    } else if (next > (1 << width) - 1) width++;
    prefix = data[i];
  }
  put(prefix);
  if (++next > (1 << width) - 1 && width < 12) width++;
  put(257);
  if (bits) out.push((acc << (8 - bits)) & 0xff);
  return Uint8Array.from(out);
}

/** Block bytes as stored: optional floating-point predictor (byte planes, differenced), then compression. */
function encodeBlock(z: Float32Array, bx: number, by: number, b: number, compression: number, predictor: number): Uint8Array {
  const bytes = new Uint8Array(b * b * 4);
  const dv = new DataView(bytes.buffer);
  const tmp = new DataView(new ArrayBuffer(4));
  for (let r = 0; r < b; r++) {
    for (let c = 0; c < b; c++) {
      const R = by * b + r, C = bx * b + c;
      const v = R < N && C < N ? z[R * N + C] : 0;
      if (predictor === 3) {
        tmp.setFloat32(0, v, false);
        for (let p = 0; p < 4; p++) bytes[r * b * 4 + p * b + c] = tmp.getUint8(p);
      } else {
        dv.setFloat32((r * b + c) * 4, v, true);
      }
    }
    if (predictor === 3) for (let k = b * 4 - 1; k > 0; k--) bytes[r * b * 4 + k] = (bytes[r * b * 4 + k] - bytes[r * b * 4 + k - 1]) & 0xff;
  }
  return compression === 5 ? lzwEncode(bytes) : compression === 8 ? zlibSync(bytes) : bytes;
}

/** Minimal little-endian GeoTIFF writer (classic or BigTIFF), tiled. */
function geoTiff(z: Float32Array, o: { compression: number; predictor: number; block: number; big?: boolean }): Buffer {
  const across = Math.ceil(N / o.block);
  const blocks: Uint8Array[] = [];
  for (let by = 0; by < across; by++) for (let bx = 0; bx < across; bx++) blocks.push(encodeBlock(z, bx, by, o.block, o.compression, o.predictor));
  const big = !!o.big;
  const head = big ? 16 : 8;
  const offsets: number[] = [];
  let pos = head;
  for (const b of blocks) {
    offsets.push(pos);
    pos += b.length;
  }
  const LONG = big ? 16 : 4;
  const entries: Array<[number, number, number[] | string]> = [
    [256, 3, [N]], [257, 3, [N]], [258, 3, [32]], [259, 3, [o.compression]], [262, 3, [1]], [277, 3, [1]], [284, 3, [1]],
    [317, 3, [o.predictor]], [322, 3, [o.block]], [323, 3, [o.block]], [324, LONG, offsets], [325, LONG, blocks.map((b) => b.length)],
    [339, 3, [3]], [33550, 12, [CELL, CELL, 0]], [33922, 12, [0, 0, 0, LEFT, TOP, 0]],
    [34735, 3, [1, 1, 0, 2, 1024, 0, 1, 2, 1025, 0, 1, 1]], [42113, 2, '-999999\0'],
  ];
  const size: Record<number, number> = { 2: 1, 3: 2, 4: 4, 12: 8, 16: 8 };
  const esz = big ? 20 : 12, inline = big ? 8 : 4;
  const ifd = pos;
  let extra = ifd + (big ? 8 : 2) + entries.length * esz + (big ? 8 : 4);
  const buf = Buffer.alloc(extra + 4096);
  buf.write('II', 0, 'latin1');
  buf.writeUInt16LE(big ? 43 : 42, 2);
  if (big) {
    buf.writeUInt16LE(8, 4);
    buf.writeBigUInt64LE(BigInt(ifd), 8);
  } else buf.writeUInt32LE(ifd, 4);
  for (let i = 0; i < blocks.length; i++) buf.set(blocks[i], offsets[i]);
  if (big) buf.writeBigUInt64LE(BigInt(entries.length), ifd);
  else buf.writeUInt16LE(entries.length, ifd);
  entries.forEach(([tag, type, vals], i) => {
    const e = ifd + (big ? 8 : 2) + i * esz;
    const count = typeof vals === 'string' ? vals.length : vals.length;
    buf.writeUInt16LE(tag, e);
    buf.writeUInt16LE(type, e + 2);
    if (big) buf.writeBigUInt64LE(BigInt(count), e + 4);
    else buf.writeUInt32LE(count, e + 4);
    const bytes = size[type] * count;
    let at = e + (big ? 12 : 8);
    if (bytes > inline) {
      if (big) buf.writeBigUInt64LE(BigInt(extra), at);
      else buf.writeUInt32LE(extra, at);
      at = extra;
      extra += bytes + (bytes & 1);
    }
    if (typeof vals === 'string') buf.write(vals, at, 'latin1');
    else vals.forEach((v, k) => {
      const p = at + k * size[type];
      if (type === 3) buf.writeUInt16LE(v, p);
      else if (type === 4) buf.writeUInt32LE(v, p);
      else if (type === 16) buf.writeBigUInt64LE(BigInt(v), p);
      else buf.writeDoubleLE(v, p);
    });
  });
  return buf.subarray(0, extra);
}

function gridFloat(dir: string, z: Float32Array) {
  fs.mkdirSync(dir, { recursive: true });
  const flt = Buffer.alloc(N * N * 4);
  z.forEach((v, i) => flt.writeFloatLE(v, i * 4));
  fs.writeFileSync(path.join(dir, 'floatn40w101_1_std.flt'), flt);
  fs.writeFileSync(path.join(dir, 'floatn40w101_1_std.hdr'),
    `ncols ${N}\nnrows ${N}\nxllcorner ${LEFT}\nyllcorner ${TOP - 1}\ncellsize ${CELL}\nNODATA_value -999999\nbyteorder LSBFIRST\n`);
}

const VARIANTS = {
  lzw: { compression: 5, predictor: 3, block: 64 },
  deflate: { compression: 8, predictor: 3, block: 64 },
  plain: { compression: 1, predictor: 1, block: 32 },
  bigtiff: { compression: 5, predictor: 3, block: 48, big: true },
};

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cbrs-sas-terrain-'));
  const z = surface();
  gridFloat(path.join(root, 'flt'), z);
  for (const [name, o] of Object.entries(VARIANTS)) {
    fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, name, 'USGS_1_n40w101.tif'), geoTiff(z, o));
  }
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('LZW decoding round-trips through code-width changes and table resets', () => {
  const data = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 7919) % 251 ^ (i >> 9));
  assert.deepEqual(lzwDecode(lzwEncode(data), data.length), data);
});

test('GeoTIFF tiles read the same as the grid in GridFloat', () => {
  const ref = new Terrain(path.join(root, 'flt'));
  const z = surface();
  const points: Array<[number, number]> = [[39.5, -100.5], [39.987, -100.013], [39.003, -100.998], [39.31, -100.77]];
  for (const name of Object.keys(VARIANTS)) {
    const t = new Terrain(path.join(root, name));
    assert.equal(t.tileCount, 1, name);
    for (const [lat, lon] of points) assert.ok(Math.abs(t.elevation(lat, lon)! - ref.elevation(lat, lon)!) < 1e-9, `${name} at ${lat},${lon}`);
    // At a sample centre the interpolation returns the sample itself.
    const [r, c] = [100, 37];
    assert.ok(Math.abs(t.elevation(TOP - (r + 0.5) * CELL, LEFT + (c + 0.5) * CELL)! - z[r * N + c]) < 1e-3, name);
    assert.ok(Math.abs(t.elevation(TOP - 5.5 * CELL, LEFT + 7.5 * CELL)!) < 1e-6, `${name}: NoData reads as 0`);
    assert.equal(t.elevation(38.5, -100.5), null, `${name}: no tile south of it`);
  }
});

test('HAAT on flat ground equals the antenna height', () => {
  const dir = path.join(root, 'flat');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'USGS_1_n40w101.tif'), geoTiff(new Float32Array(N * N).fill(500), VARIANTS.lzw));
  const t = new Terrain(dir);
  assert.ok(Math.abs(t.haat(39.5, -100.5, 10, 'AGL')! - 10) < 1e-6);
  assert.ok(Math.abs(t.haat(39.5, -100.5, 520, 'AMSL')! - 20) < 1e-6);
  assert.equal(t.haat(39.05, -100.5, 10, 'AGL'), null, 'radials leave the tile: not checked');
});

test('tiles added while running are picked up', () => {
  const dir = path.join(root, 'later');
  const t = new Terrain(dir, { rescanMs: 0 });
  assert.equal(t.tileCount, 0);
  assert.equal(t.elevation(39.5, -100.5), null);
  fs.copyFileSync(path.join(root, 'lzw', 'USGS_1_n40w101.tif'), path.join(dir, 'USGS_1_n40w101.tif'));
  assert.equal(t.tileCount, 1);
  assert.ok(t.elevation(39.5, -100.5)! > 0);
});

test('haatTiles lists the tiles under the radials', () => {
  // WINNF.FT.S.REG.7 element 7 (Arlington, VA): 16 km reaches north into n40 and east into w077.
  assert.deepEqual(haatTiles(38.882162, -77.113755), ['n39w077', 'n39w078', 'n40w078']);
  assert.deepEqual(haatTiles(39.5, -100.5), ['n40w101']);
});
