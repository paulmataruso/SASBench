import { useMemo, useState } from 'react';
import { Download, RefreshCw, Trash2, X } from 'lucide-react';
import { api } from '../../lib/api';
import { useResource } from '../../lib/live';
import type { Cbsd, MapConfig, TileSet } from '../../lib/types';
import { Button, Field, Input, Module, Note, Select, Tag, cx, useAction, useConfirm } from '../../components/ui';
import { Choice, Grid, Num, Text, Toggle, type FProps } from './fields';

// Settings → Map: base map source, the offline tile store, and downloading an area for offline use.

const USGS = 'https://basemap.nationalmap.gov/arcgis/rest/services';
const PRESETS = [
  { id: 'usgs-topo', label: 'USGS Topo', url: `${USGS}/USGSTopo/MapServer/tile/{z}/{y}/{x}`, attribution: 'USGS The National Map', maxZoom: 16, download: true },
  { id: 'usgs-imagery', label: 'USGS Imagery', url: `${USGS}/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}`, attribution: 'USGS The National Map: Orthoimagery', maxZoom: 16, download: true },
  { id: 'usgs-imagery-topo', label: 'USGS Imagery + Topo', url: `${USGS}/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}`, attribution: 'USGS The National Map', maxZoom: 16, download: true },
  { id: 'osm', label: 'OpenStreetMap (light use only)', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors', maxZoom: 19, download: false },
] as const;

export function MapSettings({ field }: { field: FProps }) {
  const cfg = useResource<MapConfig>('/api/map', ['map']);
  const { cur, set } = field;
  const preset = PRESETS.find((p) => p.url === cur.mapTileUrl)?.id ?? 'custom';

  return (
    <Module id="map" title="Map">
      <Grid>
        <Choice
          {...field}
          k="mapSource"
          label="Base map"
          options={[['builtin', 'Offline basemap (built in, no internet needed)'], ['local', 'Offline tiles from the tile store'], ['url', 'Online tile server']]}
          hint="The built-in basemap (Natural Earth, public domain) is always drawn underneath, so the map never goes blank."
        />
        {cur.mapSource !== 'builtin' && (
          <Toggle {...field} k="mapDarkenTiles" label="Darken map tiles in the dark theme" desc="Inverts tile imagery so it matches the dark UI. Turn off for aerial imagery." />
        )}
      </Grid>

      {cur.mapSource === 'url' && (
        <div className="mt-5 border-t border-line pt-4">
          <Grid>
            <Field label="Tile server">
              <Select
                value={preset}
                onChange={(e) => {
                  const p = PRESETS.find((x) => x.id === e.target.value);
                  if (!p) return;
                  set('mapTileUrl', p.url);
                  set('mapTileAttribution', p.attribution);
                  set('mapTileMaxZoom', p.maxZoom);
                }}
                className="max-w-[380px]"
              >
                {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                <option value="custom" disabled={preset !== 'custom'}>Custom URL</option>
              </Select>
            </Field>
            <Num {...field} k="mapTileMaxZoom" label="Highest zoom the server provides" min={1} max={22} hint="Beyond this the map enlarges the last tiles instead of asking for more." />
            <Text {...field} k="mapTileUrl" label="Tile URL template" hint={<>Needs <code>{'{z}'}</code>, <code>{'{x}'}</code> and <code>{'{y}'}</code>; <code>{'{s}'}</code> and <code>{'{-y}'}</code> (TMS) also work. Add an API key here if your provider needs one.</>} />
            <Text {...field} k="mapTileAttribution" label="Attribution shown on the map" />
          </Grid>
          {preset === 'osm' ? (
            <Note tone="warn" className="mt-4">
              OpenStreetMap's tile servers are run by volunteers. Occasional lab use is fine with the attribution shown; products and heavy use must use another
              provider (<a className="underline" href="https://operations.osmfoundation.org/policies/tiles/" target="_blank" rel="noreferrer">tile usage policy</a>).
              Bulk downloading for offline use is not allowed.
            </Note>
          ) : preset.startsWith('usgs') ? (
            <Note className="mt-4">USGS The National Map: US government work, public domain, no API key. It can also be downloaded for offline use below.</Note>
          ) : (
            <Note className="mt-4">Check that your licence for this tile service covers how you use it.</Note>
          )}
        </div>
      )}

      <TileStorePanel cfg={cfg.data} field={field} reload={cfg.reload} />
      <DownloadPanel cfg={cfg.data} field={field} />
    </Module>
  );
}

// ---------------------------------------------------------------- tile store

function TileStorePanel({ cfg, field, reload }: { cfg: MapConfig | null | undefined; field: FProps; reload: () => Promise<void> | void }) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const { cur, set } = field;
  const sets = cfg?.store.sets ?? [];
  const local = cur.mapSource === 'local';
  const chosen = cur.mapLocalTiles || sets.find((s) => s.usable)?.id || '';

  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-ink-2">Offline tile store</span>
        {cfg && <code className="text-xs text-ink-3">{cfg.store.dir}</code>}
        <Button size="sm" icon={RefreshCw} className="ml-auto" loading={busy === 'rescan'} onClick={() => run('rescan', async () => {
          await api.post('/api/map/rescan');
          await reload();
        })}>Rescan</Button>
      </div>
      {sets.length === 0 ? (
        <p className="text-sm text-ink-3">
          No tile sets yet. Download an area below, or copy a raster <code>.mbtiles</code> file (or a <code>z/x/y</code> folder of PNG/JPEG tiles) into the folder
          above, e.g. <code>docker cp lab.mbtiles sasbench:/data/tiles/</code>, then press Rescan.
        </p>
      ) : (
        <ul className="divide-y divide-line rounded border border-line">
          {sets.map((s) => (
            <li key={s.id} className={cx('flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2', local && chosen === s.id && 'bg-sel-soft/60')}>
              {local && (
                <input
                  type="radio"
                  name="mapLocalTiles"
                  aria-label={`Use ${s.name}`}
                  className="accent-[rgb(var(--sel))]"
                  disabled={!s.usable}
                  checked={chosen === s.id}
                  onChange={() => set('mapLocalTiles', s.id)}
                />
              )}
              <span className="min-w-0 font-mono text-sm text-ink">{s.id}</span>
              <span className="text-xs text-ink-3">{describe(s)}</span>
              {s.error && <Tag tone="bad">{s.error}</Tag>}
              {cfg?.download?.state === 'running' && cfg.download.file === s.id && <Tag tone="warn">downloading</Tag>}
              <Button
                size="sm"
                variant="danger-ghost"
                icon={Trash2}
                className="ml-auto"
                aria-label={`Delete ${s.id}`}
                loading={busy === `del-${s.id}`}
                onClick={async () => {
                  if (await confirm({ title: `Delete ${s.id}?`, body: 'Removes the tile set from the tile store. This cannot be undone.', confirm: 'Delete', danger: true })) {
                    await run(`del-${s.id}`, () => api.del(`/api/map/tiles/${encodeURIComponent(s.id)}`), 'Tile set deleted');
                  }
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {local && !cur.mapLocalTiles && sets.some((s) => s.usable) && <p className="mt-2 text-xs text-ink-3">No set chosen: the first usable one is shown.</p>}
    </div>
  );
}

function describe(s: TileSet): string {
  const parts = [s.kind === 'mbtiles' ? 'MBTiles' : 'folder', s.format?.toUpperCase()];
  if (s.minZoom != null && s.maxZoom != null) parts.push(`zoom ${s.minZoom}–${s.maxZoom}`);
  if (s.sizeBytes != null) parts.push(bytes(s.sizeBytes));
  return parts.filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- download

function DownloadPanel({ cfg, field }: { cfg: MapConfig | null | undefined; field: FProps }) {
  const cbsds = useResource<Cbsd[]>('/api/cbsds', ['cbsds']);
  const { run, busy } = useAction();
  const [src, setSrc] = useState<string>('usgs-topo');
  const [customUrl, setCustomUrl] = useState('');
  const [area, setArea] = useState<'cbsds' | 'custom'>('cbsds');
  const [radiusKm, setRadiusKm] = useState('25');
  const [box, setBox] = useState({ w: '', s: '', e: '', n: '' });
  const [minZoom, setMinZoom] = useState('6');
  const [maxZoom, setMaxZoom] = useState('14');
  const [name, setName] = useState('');

  const located = (cbsds.data ?? []).filter((c) => c.latitude != null && c.longitude != null);
  const bounds = useMemo((): [number, number, number, number] | null => {
    if (area === 'custom') {
      const v = [box.w, box.s, box.e, box.n].map(Number);
      return [box.w, box.s, box.e, box.n].every((x) => x.trim() !== '') && v.every(Number.isFinite) && v[0] < v[2] && v[1] < v[3] ? (v as [number, number, number, number]) : null;
    }
    if (!located.length) return null;
    const km = Math.max(0, Number(radiusKm) || 0);
    const lats = located.map((c) => c.latitude!);
    const lons = located.map((c) => c.longitude!);
    const s = Math.min(...lats), n = Math.max(...lats);
    const dLat = km / 111.32;
    const dLon = km / (111.32 * Math.max(0.1, Math.cos(((s + n) / 2) * Math.PI / 180)));
    return [Math.min(...lons) - dLon, Math.max(-85, s - dLat), Math.max(...lons) + dLon, Math.min(85, n + dLat)];
  }, [area, box, located, radiusKm]);

  const p = PRESETS.find((x) => x.id === src);
  const url = src === 'custom' ? customUrl.trim() : p?.url ?? '';
  const zMin = Number(minZoom), zMax = Number(maxZoom);
  const zOk = Number.isInteger(zMin) && Number.isInteger(zMax) && zMin >= 0 && zMax <= 18 && zMin <= zMax;
  const count = bounds && zOk ? tileCount(bounds, zMin, zMax) : 0;
  const limit = cfg?.maxDownloadTiles ?? 100_000;
  const job = cfg?.download;
  const running = job?.state === 'running';
  const fileName = (name.trim() || `${src}-${area === 'cbsds' ? 'cbsds' : 'area'}`).replace(/[^A-Za-z0-9._-]+/g, '-');

  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="mb-1 text-sm font-medium text-ink-2">Download an area for offline use</div>
      <p className="mb-3 text-xs text-ink-3">Saves map tiles into a new MBTiles file in the tile store, so the detailed map keeps working when the lab has no internet.</p>
      <Grid>
        <Field label="Source">
          <Select value={src} onChange={(e) => setSrc(e.target.value)} className="max-w-[380px]">
            {PRESETS.filter((x) => x.download).map((x) => <option key={x.id} value={x.id}>{x.label} (public domain)</option>)}
            <option value="custom">Custom URL (you must have the right to download it)</option>
          </Select>
        </Field>
        {src === 'custom' ? (
          <Field label="Tile URL template">
            <Input value={customUrl} onChange={(e) => setCustomUrl(e.target.value)} placeholder="https://tiles.example.com/{z}/{x}/{y}.png" className="max-w-[380px] font-mono text-sm" />
          </Field>
        ) : <div className="hidden md:block" />}
        <Field label="Area">
          <Select value={area} onChange={(e) => setArea(e.target.value as 'cbsds' | 'custom')} className="max-w-[380px]">
            <option value="cbsds">Around the registered CBSDs</option>
            <option value="custom">Custom bounding box</option>
          </Select>
        </Field>
        {area === 'cbsds' ? (
          <Field label="Margin around the CBSDs (km)" hint={located.length ? `${located.length} CBSD${located.length > 1 ? 's' : ''} with a location` : 'No registered CBSD has a location yet; use a custom box.'}>
            <Input type="number" min={0} value={radiusKm} onChange={(e) => setRadiusKm(e.target.value)} className="w-32" />
          </Field>
        ) : (
          <Field label="West, south, east, north (degrees)">
            <div className="flex flex-wrap gap-2">
              {(['w', 's', 'e', 'n'] as const).map((k) => (
                <Input key={k} type="number" step="0.01" aria-label={{ w: 'West longitude', s: 'South latitude', e: 'East longitude', n: 'North latitude' }[k]} placeholder={k.toUpperCase()} value={box[k]} onChange={(e) => setBox({ ...box, [k]: e.target.value })} className="w-24" />
              ))}
            </div>
          </Field>
        )}
        <Field label="Zoom levels" hint="14 shows streets; every extra level is about 4× the tiles. The built-in basemap already covers low zooms.">
          <div className="flex items-center gap-2">
            <Input type="number" min={0} max={18} aria-label="Lowest zoom" value={minZoom} onChange={(e) => setMinZoom(e.target.value)} className="w-20" />
            <span className="text-ink-3">to</span>
            <Input type="number" min={0} max={18} aria-label="Highest zoom" value={maxZoom} onChange={(e) => setMaxZoom(e.target.value)} className="w-20" />
          </div>
        </Field>
        <Field label="File name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={fileName} className="max-w-[380px] font-mono text-sm" />
        </Field>
      </Grid>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {running ? (
          <Button icon={X} loading={busy === 'cancel'} onClick={() => run('cancel', () => api.del('/api/map/download'))}>Cancel download</Button>
        ) : (
          <Button
            variant="primary"
            icon={Download}
            disabled={!bounds || !zOk || !url || count === 0 || count > limit}
            loading={busy === 'download'}
            onClick={() => run('download', () => api.post('/api/map/download', {
              url, attribution: p?.attribution ?? '', bounds, minZoom: zMin, maxZoom: zMax, name: fileName,
            }))}
          >
            Download {count ? `${count.toLocaleString('en-US')} tiles` : 'tiles'}
          </Button>
        )}
        {!running && count > 0 && (
          <span className={cx('text-sm', count > limit ? 'text-bad-ink' : 'text-ink-3')}>
            {count > limit ? `Over the ${limit.toLocaleString('en-US')}-tile limit: lower the highest zoom or shrink the area.` : `About ${bytes(count * 20_000)} at ~20 KB per tile.`}
          </span>
        )}
      </div>

      {job && <JobStatus job={job} onUse={() => { field.set('mapSource', 'local'); field.set('mapLocalTiles', job.file); }} using={field.cur.mapSource === 'local' && field.cur.mapLocalTiles === job.file} />}
    </div>
  );
}

function JobStatus({ job, onUse, using }: { job: NonNullable<MapConfig['download']>; onUse: () => void; using: boolean }) {
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  if (job.state === 'running') {
    return (
      <div className="mt-4">
        <div className="mb-1 flex justify-between text-xs text-ink-3">
          <span>Downloading <code>{job.file}</code>: {job.done.toLocaleString('en-US')} of {job.total.toLocaleString('en-US')} tiles · {bytes(job.bytes)}</span>
          <span className="num">{pct}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-panel-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-sel transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }
  if (job.state === 'done') {
    return (
      <Note tone="ok" className="mt-4 flex flex-wrap items-center gap-3">
        <span><code>{job.file}</code> is ready: {(job.done - job.missing - job.failed).toLocaleString('en-US')} tiles, {bytes(job.bytes)}{job.missing ? ` (${job.missing} empty)` : ''}.</span>
        {!using && <Button size="sm" onClick={onUse}>Use it as the base map</Button>}
        {using && <span className="text-xs">Selected; save to apply.</span>}
      </Note>
    );
  }
  if (job.state === 'failed') return <Note tone="bad" className="mt-4">Download of <code>{job.file}</code> failed: {job.error}</Note>;
  return <Note className="mt-4">Download of <code>{job.file}</code> was cancelled.</Note>;
}

// ---------------------------------------------------------------- helpers

function bytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

/** Same tile maths as the server (server/src/map/tiles.ts). */
function tileCount([w, s, e, n]: [number, number, number, number], minZoom: number, maxZoom: number): number {
  const x = (lon: number, z: number) => Math.min((1 << z) - 1, Math.max(0, Math.floor(((lon + 180) / 360) * (1 << z))));
  const y = (lat: number, z: number) => {
    const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
    return Math.min((1 << z) - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * (1 << z))));
  };
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) total += (x(e, z) - x(w, z) + 1) * (y(s, z) - y(n, z) + 1);
  return total;
}
