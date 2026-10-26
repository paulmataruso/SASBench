import { Fragment, useMemo, useState } from 'react';
import { Download, Pencil, Plus, Power, PowerOff, Search, ShieldAlert, SlidersHorizontal, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { mhz, range } from '../../lib/format';
import type { Protection } from '../../lib/types';
import {
  Button, Drawer, Empty, Field, Input, Led, Module, Segmented, Select, Switch, Tag, Textarea, useAction, useConfirm, useToast, cx,
} from '../../components/ui';
import { KIND_LABEL, activeRanges, areaOf, hz, kindRank, mergeRanges, protectionTone, type SpectrumData } from './shared';

// Protections: incumbent / administrative areas that take spectrum away from CBSDs.

const EDIT_KINDS = ['ADMIN', 'ESC', 'FSS', 'EXCLUSION', 'DPA'];

export function ProtectionsModule({ data, reload }: { data: SpectrumData; reload: () => Promise<void> }) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);
  const [activateOnLoad, setActivateOnLoad] = useState(false);
  const [channelsFor, setChannelsFor] = useState<string | null>(null);
  const [editing, setEditing] = useState<Protection | 'new' | null>(null);

  const kinds = useMemo(() => [...new Set(data.protections.map((p) => p.kind))].sort((a, b) => kindRank(a) - kindRank(b)), [data.protections]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.protections
      .filter((p) => (!kind || p.kind === kind) && (!onlyActive || p.active))
      .filter((p) => !needle || `${p.name} ${p.id} ${p.notes ?? ''} ${p.source}`.toLowerCase().includes(needle))
      .sort((a, b) => Number(b.active) - Number(a.active) || kindRank(a.kind) - kindRank(b.kind) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [data.protections, q, kind, onlyActive]);
  const dpaCount = data.protections.filter((p) => p.kind === 'DPA').length;
  const activeCount = data.protections.filter((p) => p.active).length;

  const setActive = (p: Protection, active: boolean, channels?: Array<[number, number]>) => run(`act:${p.id}`, async () => {
    await api.post(`/api/protections/${encodeURIComponent(p.id)}/active`, { active, channels });
    await reload();
  }, `${p.name} ${active ? 'activated' : 'deactivated'}`);

  const remove = async (p: Protection) => {
    if (!(await confirm({ title: `Delete ${p.name}?`, body: 'Spectrum it blocks becomes available again on the next request.', confirm: 'Delete', danger: true }))) return;
    await run(`del:${p.id}`, async () => {
      await api.del(`/api/protections/${encodeURIComponent(p.id)}`);
      await reload();
    }, 'Protection deleted');
  };

  const loadDpas = async (file: 'E-DPAs.kml' | 'P-DPAs.kml') => {
    const r = await run(`load:${file}`, async () => {
      const out = await api.post<{ loaded: number }>('/api/dpas/load', { file, activate: activateOnLoad });
      await reload();
      return out;
    });
    if (r) toast.ok(`Loaded ${r.loaded} DPAs from ${file}${activateOnLoad ? ' with all channels active' : ' (inactive)'}`);
  };

  const bulk = (activate: boolean) => run(`bulk:${activate}`, async () => {
    await api.post('/api/dpas/bulk', { activate });
    await reload();
  }, `All DPAs ${activate ? 'activated' : 'deactivated'}`);

  const clearDpas = async () => {
    if (!(await confirm({ title: `Remove all ${dpaCount} DPAs?`, body: 'They can be loaded again from the NTIA KML files.', confirm: 'Remove DPAs', danger: true }))) return;
    await run('clear', async () => {
      await api.post('/api/dpas/clear');
      await reload();
    }, 'DPAs removed');
  };

  return (
    <Module
      title="Protections"
      meta={`${activeCount} active of ${data.protections.length}`}
      bodyClass="p-0"
      actions={<Button size="sm" variant="primary" icon={Plus} onClick={() => setEditing('new')}>New protection</Button>}
    >
      <p className="border-b border-line px-3 py-2 text-sm text-ink-2">
        An active protection removes its band from every CBSD inside its area (or DPA neighbourhood; band-wide when it has no area).
        <strong className="font-medium text-ink"> suspend</strong>: affected grants get heartbeat responseCode <span className="font-mono text-xs">501 SUSPENDED_GRANT</span> until it is deactivated.
        <strong className="font-medium text-ink"> terminate</strong>: they get <span className="font-mono text-xs">500 TERMINATED_GRANT</span> and end.
        New grants that overlap are refused with <span className="font-mono text-xs">400 INTERFERENCE</span>. Spectrum inquiry ignores DPAs unless enabled in Settings.
      </p>

      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <div className="relative w-full sm:w-60">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input className="pl-7" placeholder="Search name, id, notes" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search protections" />
        </div>
        <Select className="w-auto" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter by kind">
          <option value="">All kinds</option>
          {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k] ?? k} ({data.protections.filter((p) => p.kind === k).length})</option>)}
        </Select>
        <label className="flex items-center gap-1.5 text-sm text-ink-2">
          <input type="checkbox" className="accent-[rgb(var(--sel))]" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
          Active only
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line bg-panel-2/60 px-3 py-2">
        <span className="silk mr-1">NTIA DPAs</span>
        <Button size="sm" icon={Download} onClick={() => void loadDpas('E-DPAs.kml')} loading={busy === 'load:E-DPAs.kml'} title="ESC-monitored coastal DPAs">Load E-DPAs</Button>
        <Button size="sm" icon={Download} onClick={() => void loadDpas('P-DPAs.kml')} loading={busy === 'load:P-DPAs.kml'} title="Portal-activated inland DPAs">Load P-DPAs</Button>
        <label className="mr-2 flex items-center gap-1.5 text-sm text-ink-2">
          <input type="checkbox" className="accent-[rgb(var(--sel))]" checked={activateOnLoad} onChange={(e) => setActivateOnLoad(e.target.checked)} />
          activate on load
        </label>
        {dpaCount > 0 && (
          <>
            <span className="hidden h-4 w-px bg-line-strong sm:block" aria-hidden />
            <Button size="sm" icon={Power} onClick={() => void bulk(true)} loading={busy === 'bulk:true'}>Activate all</Button>
            <Button size="sm" icon={PowerOff} onClick={() => void bulk(false)} loading={busy === 'bulk:false'}>Deactivate all</Button>
            <Button size="sm" variant="danger-ghost" icon={Trash2} onClick={() => void clearDpas()} loading={busy === 'clear'}>Remove {dpaCount}</Button>
          </>
        )}
      </div>

      {!data.protections.length ? (
        <Empty icon={ShieldAlert} title="No protections">
          Load the NTIA DPAs to simulate ESC / portal activations, inject incumbents below, or create an administrative protection to block part of the band.
        </Empty>
      ) : !rows.length ? (
        <Empty title="Nothing matches">Clear the search or the filters to see all {data.protections.length} protections.</Empty>
      ) : (
        <div className="max-h-[460px] overflow-auto">
          <table className="dtable">
            <thead>
              <tr>
                <th className="w-8"><span className="sr-only">Active</span></th>
                <th>Name</th>
                <th>Kind</th>
                <th>Band MHz</th>
                <th>Blocking now</th>
                <th>Action</th>
                <th>Area</th>
                <th className="w-[1%]"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const tone = protectionTone(p);
                const derived = p.source === 'harness';
                return (
                  <Fragment key={p.id}>
                    <tr aria-selected={channelsFor === p.id}>
                      <td><Led c={tone === 'off' ? 'off' : tone} title={p.active ? 'active' : 'inactive'} /></td>
                      <td className="max-w-[260px]">
                        <div className="truncate font-medium" title={p.name}>{p.name}</div>
                        <div className="truncate font-mono text-2xs text-ink-3" title={p.id}>{p.source}{p.id !== p.name ? ` · ${p.id}` : ''}</div>
                      </td>
                      <td><Tag>{KIND_LABEL[p.kind] ?? p.kind}</Tag></td>
                      <td className="num whitespace-nowrap font-mono text-xs">{range(p.low, p.high)}</td>
                      <td className="num whitespace-nowrap font-mono text-xs">
                        {p.active ? activeRanges(p).map(([l, h]) => range(l, h)).join(', ') : <span className="text-ink-3">—</span>}
                      </td>
                      <td>
                        <Tag tone={p.active ? (p.action === 'terminate' ? 'bad' : 'warn') : 'off'} title={p.action === 'terminate' ? 'Heartbeat → 500 TERMINATED_GRANT' : 'Heartbeat → 501 SUSPENDED_GRANT'}>
                          {p.action} → {p.action === 'terminate' ? '500' : '501'}
                        </Tag>
                      </td>
                      <td className="whitespace-nowrap text-xs text-ink-2">
                        {areaOf(p) === 'circle' ? `${p.radiusKm} km circle` : areaOf(p) === 'polygon' ? (p.neighborhood ? 'polygon + neighbourhood' : 'polygon') : 'band-wide'}
                      </td>
                      <td>
                        <div className="flex justify-end gap-0.5">
                          {p.kind === 'DPA' && (
                            <Button size="sm" variant="ghost" icon={SlidersHorizontal} title="Choose channels" aria-label="Choose channels"
                              onClick={() => setChannelsFor(channelsFor === p.id ? null : p.id)} />
                          )}
                          <Button size="sm" icon={p.active ? PowerOff : Power} className="w-[104px]" onClick={() => void setActive(p, !p.active)} loading={busy === `act:${p.id}`}>
                            {p.active ? 'Deactivate' : 'Activate'}
                          </Button>
                          <Button size="sm" variant="ghost" icon={Pencil} aria-label="Edit" disabled={derived}
                            title={derived ? 'Derived from injected incumbent data; edit the incumbent instead' : 'Edit'} onClick={() => setEditing(p)} />
                          <Button size="sm" variant="danger-ghost" icon={Trash2} aria-label="Delete" disabled={derived}
                            title={derived ? 'Derived from injected incumbent data; delete the incumbent instead' : 'Delete'} onClick={() => void remove(p)} loading={busy === `del:${p.id}`} />
                        </div>
                      </td>
                    </tr>
                    {channelsFor === p.id && (
                      <tr aria-selected="true">
                        <td colSpan={8} className="h-auto py-3">
                          <DpaChannels p={p} band={data.band} busy={busy === `act:${p.id}`} onApply={(ch, active) => void setActive(p, active, ch).then(() => setChannelsFor(null))} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ProtectionEditor
        value={editing}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await reload();
        }}
      />
    </Module>
  );
}

/** 10 MHz channel picker for a DPA (activation per channel, like an ESC / portal activation). */
function DpaChannels({ p, band, busy, onApply }: {
  p: Protection; band: { low: number; high: number }; busy: boolean; onApply: (channels: Array<[number, number]> | undefined, active: boolean) => void;
}) {
  // Only channels inside the CBRS band matter to CBSDs (some NTIA DPAs list 3500–3650 MHz).
  const lo = Math.max(p.low, band.low);
  const hi = Math.min(p.high, band.high);
  const chans: Array<[number, number]> = [];
  for (let f = lo; f + 10e6 <= hi; f += 10e6) chans.push([f, f + 10e6]);
  if (!chans.length) chans.push([p.low, p.high]);
  const current = activeRanges(p);
  const [sel, setSel] = useState<Set<number>>(() => new Set(chans.map((c, i) => (current.some(([l, h]) => c[0] >= l && c[1] <= h) ? i : -1)).filter((i) => i >= 0)));
  const toggle = (i: number) => setSel((s) => {
    const n = new Set(s);
    if (n.has(i)) n.delete(i);
    else n.add(i);
    return n;
  });
  const chosen = mergeRanges(chans.filter((_, i) => sel.has(i)));
  const all = sel.size === chans.length && lo === p.low && hi === p.high;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm text-ink-2">Active channels of <span className="font-medium text-ink">{p.name}</span>:</span>
      <div className="flex flex-wrap gap-1" role="group" aria-label="DPA channels">
        {chans.map((c, i) => (
          <button
            key={i}
            type="button"
            aria-pressed={sel.has(i)}
            onClick={() => toggle(i)}
            className={cx(
              'h-7 rounded-sm border px-2 font-mono text-2xs transition-colors duration-150',
              sel.has(i) ? 'border-warn bg-warn-soft text-warn-ink' : 'border-line-strong bg-panel text-ink-2 hover:border-ink-3',
            )}
          >
            {mhz(c[0])}–{mhz(c[1])}
          </button>
        ))}
      </div>
      <div className="ml-auto flex gap-1.5">
        <Button size="sm" onClick={() => setSel(new Set(all ? [] : chans.map((_, i) => i)))}>{all ? 'None' : 'All'}</Button>
        <Button size="sm" variant="primary" disabled={!chosen.length} loading={busy} onClick={() => onApply(all ? undefined : chosen, true)}>
          Activate {all ? 'whole band' : `${sel.size} channel${sel.size === 1 ? '' : 's'}`}
        </Button>
        {p.active && <Button size="sm" loading={busy} onClick={() => onApply(undefined, false)}>Deactivate</Button>}
      </div>
    </div>
  );
}

interface Draft {
  name: string;
  kind: string;
  low: string;
  high: string;
  action: 'suspend' | 'terminate';
  area: 'band' | 'circle' | 'keep';
  latitude: string;
  longitude: string;
  radiusKm: string;
  active: boolean;
  notes: string;
}

function ProtectionEditor({ value, onClose, onSaved }: { value: Protection | 'new' | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [d, setD] = useState<Draft | null>(null);
  const [key, setKey] = useState<unknown>(null);
  const [tried, setTried] = useState(false);
  const { run, busy } = useAction();
  if (value && key !== value) {
    setKey(value);
    setTried(false);
    const p = value === 'new' ? null : value;
    setD({
      name: p?.name ?? '', kind: p?.kind ?? 'ADMIN', low: p ? mhz(p.low) : '3550', high: p ? mhz(p.high) : '3560',
      action: p?.action ?? 'suspend', area: p?.geometry ? 'keep' : p && p.latitude != null && p.radiusKm != null ? 'circle' : 'band',
      latitude: p?.latitude != null ? String(p.latitude) : '', longitude: p?.longitude != null ? String(p.longitude) : '',
      radiusKm: p?.radiusKm != null ? String(p.radiusKm) : '40', active: p?.active ?? true, notes: p?.notes ?? '',
    });
  }
  if (!value && key !== null) setKey(null);
  const existing = value && value !== 'new' ? value : null;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => (x ? { ...x, [k]: v } : x));

  const check = d ? {
    name: d.name.trim() ? null : 'Required',
    band: !(Number(d.low) < Number(d.high)) ? 'Low must be below high' : null,
    lat: d.area === 'circle' && !(Math.abs(Number(d.latitude)) <= 90 && d.latitude.trim() !== '') ? 'Latitude −90…90' : null,
    lon: d.area === 'circle' && !(Math.abs(Number(d.longitude)) <= 180 && d.longitude.trim() !== '') ? 'Longitude −180…180' : null,
    radius: d.area === 'circle' && !(Number(d.radiusKm) > 0) ? 'Radius in km' : null,
  } : {};
  const invalid = Object.values(check).some(Boolean);
  const err: Partial<typeof check> = tried ? check : {};

  const save = () => d && run('save', async () => {
    const body: Record<string, any> = {
      name: d.name.trim(), kind: d.kind, low: hz(d.low), high: hz(d.high), action: d.action, active: d.active, notes: d.notes || null,
      latitude: d.area === 'circle' ? Number(d.latitude) : null, longitude: d.area === 'circle' ? Number(d.longitude) : null,
      radiusKm: d.area === 'circle' ? Number(d.radiusKm) : existing?.radiusKm ?? null,
      geometry: d.area === 'keep' ? existing?.geometry ?? null : null,
      neighborhood: d.area === 'keep' ? existing?.neighborhood ?? null : null,
      channels: existing?.channels ?? null,
    };
    if (existing) await api.put(`/api/protections/${encodeURIComponent(existing.id)}`, body);
    else await api.post('/api/protections', body);
    await onSaved();
  }, existing ? 'Protection updated' : 'Protection created');

  return (
    <Drawer open={!!value && !!d} onClose={onClose} width={560} title={existing ? `Edit ${existing.name}` : 'New protection'}>
      {d && (
        <form className="space-y-4 p-4" noValidate onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (!invalid) void save();
        }}>
          <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
            <Field label="Name" error={err.name}>
              <Input value={d.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Ship radar east" aria-invalid={!!err.name} autoFocus />
            </Field>
            <Field label="Kind">
              <Select value={d.kind} onChange={(e) => set('kind', e.target.value)}>
                {[...new Set([...EDIT_KINDS, d.kind])].map((k) => <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>)}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Low (MHz)" error={err.band}>
              <Input inputMode="decimal" className="font-mono text-sm" value={d.low} onChange={(e) => set('low', e.target.value)} aria-invalid={!!err.band} />
            </Field>
            <Field label="High (MHz)">
              <Input inputMode="decimal" className="font-mono text-sm" value={d.high} onChange={(e) => set('high', e.target.value)} aria-invalid={!!err.band} />
            </Field>
          </div>
          <Field label="Action on affected grants" hint={d.action === 'suspend' ? 'Heartbeat → 501 SUSPENDED_GRANT while active; grants resume when it is deactivated.' : 'Heartbeat → 500 TERMINATED_GRANT; the grant ends.'}>
            <Segmented value={d.action} onChange={(v) => set('action', v)} options={[{ value: 'suspend', label: 'Suspend (501)' }, { value: 'terminate', label: 'Terminate (500)' }]} />
          </Field>
          <Field label="Area" hint={d.area === 'band' ? 'Band-wide: affects every CBSD regardless of location.' : d.area === 'keep' ? 'The polygon (and DPA neighbourhood distances) from the source data is kept.' : 'CBSDs within the radius of the centre are affected.'}>
            <Segmented
              value={d.area}
              onChange={(v) => set('area', v)}
              options={[
                { value: 'band', label: 'Band-wide' },
                { value: 'circle', label: 'Circle' },
                ...(existing?.geometry ? [{ value: 'keep' as const, label: 'Source polygon' }] : []),
              ]}
            />
          </Field>
          {d.area === 'circle' && (
            <div className="grid grid-cols-3 gap-3">
              <Field label="Latitude" error={err.lat}><Input inputMode="decimal" className="font-mono text-sm" value={d.latitude} onChange={(e) => set('latitude', e.target.value)} aria-invalid={!!err.lat} /></Field>
              <Field label="Longitude" error={err.lon}><Input inputMode="decimal" className="font-mono text-sm" value={d.longitude} onChange={(e) => set('longitude', e.target.value)} aria-invalid={!!err.lon} /></Field>
              <Field label="Radius (km)" error={err.radius}><Input inputMode="decimal" className="font-mono text-sm" value={d.radiusKm} onChange={(e) => set('radiusKm', e.target.value)} aria-invalid={!!err.radius} /></Field>
            </div>
          )}
          <Field label="Notes">
            <Textarea rows={2} className="font-sans text-base" value={d.notes} onChange={(e) => set('notes', e.target.value)} />
          </Field>
          <Switch checked={d.active} onChange={(v) => set('active', v)} label="Active" description="Inactive protections are kept but block nothing." />
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={tried && invalid} loading={busy === 'save'}>{existing ? 'Save' : 'Create'}</Button>
          </div>
        </form>
      )}
    </Drawer>
  );
}
