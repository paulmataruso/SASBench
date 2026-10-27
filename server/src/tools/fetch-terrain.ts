// Downloads USGS 3DEP 1-arc-second elevation tiles (public domain) for the Category A outdoor
// HAAT check. Each tile is 1°×1°, 40–70 MB.
//
//   node server/src/tools/fetch-terrain.ts n39w078 n39w077       # tiles by name (north-west corner)
//   node server/src/tools/fetch-terrain.ts --around 39.74,-104.99   # tiles a HAAT check at this point reads
//   node server/src/tools/fetch-terrain.ts --harness             # tiles for the WInnForum harness CBSD tests
//   docker exec sasbench node server/src/tools/fetch-terrain.ts --harness
//
// Files go to SAS_TERRAIN_DIR, else $SAS_DATA_DIR/terrain (./data/terrain); --dir DIR overrides.
// SAS_TERRAIN_SOURCE_URL replaces the USGS address with a mirror that has the same layout.
// Existing tiles are kept unless --force. A running SAS picks new tiles up within 30 s.
import fs from 'node:fs';
import path from 'node:path';
import { haatTiles } from '../sas/terrain.ts';
import { HARNESS_POINTS, fetchTile, presentTiles } from './terrainFetch.ts';

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

const present = presentTiles(dir);

async function describeFetch(name: string): Promise<string> {
  const r = await fetchTile(name, dir, { force, present });
  if (r.status === 'present') return 'already present';
  if (r.status === 'unavailable') return 'not published by USGS (open water or outside coverage)';
  return `${(r.bytes / 1e6).toFixed(0)} MB`;
}

const queue = [...tiles].sort();
console.log(`${queue.length} tile(s) → ${path.resolve(dir)}`);
let failed = 0;
await Promise.all(Array.from({ length: 3 }, async () => {
  for (let name = queue.shift(); name; name = queue.shift()) {
    try {
      console.log(`  ${name}: ${await describeFetch(name)}`);
    } catch (e: any) {
      failed++;
      console.error(`  ${name}: failed (${e.message})`);
    }
  }
}));
process.exit(failed ? 1 : 0);
