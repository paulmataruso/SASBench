// Downloads USGS 3DEP 1-arc-second elevation tiles (public domain) for the Category A outdoor
// HAAT check. Each tile is 1°×1°, 40–70 MB.
//
//   node server/src/tools/fetch-terrain.ts n39w078 n39w077       # tiles by name (north-west corner)
//   node server/src/tools/fetch-terrain.ts --around 39.74,-104.99   # tiles a HAAT check at this point reads
//   node server/src/tools/fetch-terrain.ts --harness             # tiles for the WInnForum harness CBSD tests
//   docker exec sasbench node server/src/tools/fetch-terrain.ts --harness
//
// Files go to SAS_TERRAIN_DIR, else $SAS_DATA_DIR/terrain (./data/terrain); --dir DIR overrides.
// Existing tiles are kept unless --force. A running SAS picks new tiles up within 30 s.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { haatTiles } from '../sas/terrain.ts';

const USGS = 'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1/TIFF/current';

// CBSD installation points in the harness's CBSD-facing suites (REG, DRG, SIQ, GRA, HBT, RLQ, MES,
// SCS): testcases/testdata/device_*.json plus the locations the test cases set themselves.
const HARNESS_POINTS: Array<[number, number]> = [
  [39.0119, -98.4842], [39.139836, -97.770094], [38.815291, -97.198805], [39.190944, -99.022535], // device_a–d
  [39.173912, -99.923414], [38.815291, -100.253004], [39.32705, -100.604567], // device_e–g
  [42.0001, -110.0001], [42.6001, -105.0001], [41.6001, -105.0001], // device_h–j
  [38.882162, -77.113755], [38.882162, -77.013055], // REG.7 elements 7 and 13
  [36.711538, -76.016275], // HBT
  [30.7157, -88.0935], [38.2, -99.5], [38.4, -98.9], [38.775, -97.291], [38.82767, -97.20497], // SIQ
  [38.854, -97.195], [39.0, -98.6], [40.0, -97.87],
];

function usage(msg?: string): never {
  if (msg) console.error(msg);
  console.error('usage: fetch-terrain.ts [--dir DIR] [--force] (--harness | --around LAT,LON | TILE...)   e.g. TILE = n39w078');
  process.exit(2);
}

const args = process.argv.slice(2);
let dir = process.env.SAS_TERRAIN_DIR ?? path.join(process.env.SAS_DATA_DIR ?? './data', 'terrain');
let force = false;
const tiles = new Set<string>();
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dir') dir = args[++i] ?? usage('--dir needs a directory');
  else if (a === '--force') force = true;
  else if (a === '--harness') for (const [lat, lon] of HARNESS_POINTS) for (const t of haatTiles(lat, lon)) tiles.add(t);
  else if (a === '--around') {
    const [lat, lon] = (args[++i] ?? '').split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) usage('--around needs LAT,LON in degrees');
    for (const t of haatTiles(lat, lon)) tiles.add(t);
  } else if (/^[ns]\d{2}[ew]\d{3}$/i.test(a)) tiles.add(a.toLowerCase());
  else usage(a === '--help' || a === '-h' ? undefined : `unknown argument: ${a}`);
}
if (!tiles.size) usage();
fs.mkdirSync(dir, { recursive: true });

// Tiles already present in any supported naming (USGS GeoTIFF, NED GridFloat).
const present = new Set(
  fs.readdirSync(dir).filter((f) => /\.(flt|tiff?)$/i.test(f)).map((f) => /([ns]\d{2}[ew]\d{3})/i.exec(f)?.[1].toLowerCase()).filter(Boolean),
);

async function fetchTile(name: string): Promise<string> {
  if (!force && present.has(name)) return 'already present';
  const file = path.join(dir, `USGS_1_${name}.tif`);
  const res = await fetch(`${USGS}/${name}/USGS_1_${name}.tif`);
  // S3 answers 403 or 404 for keys that do not exist: open ocean or outside USGS coverage.
  if (res.status === 403 || res.status === 404) return 'not published by USGS (open water or outside coverage)';
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const part = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(part));
  fs.renameSync(part, file);
  return `${(fs.statSync(file).size / 1e6).toFixed(0)} MB`;
}

const queue = [...tiles].sort();
console.log(`${queue.length} tile(s) → ${path.resolve(dir)}`);
let failed = 0;
await Promise.all(Array.from({ length: 3 }, async () => {
  for (let name = queue.shift(); name; name = queue.shift()) {
    try {
      console.log(`  ${name}: ${await fetchTile(name)}`);
    } catch (e: any) {
      failed++;
      console.error(`  ${name}: failed (${e.message})`);
    }
  }
}));
process.exit(failed ? 1 : 0);
