import { useState } from 'react';
import { Crosshair, Map as MapIcon, Pencil, Plus, Trash2, X } from 'lucide-react';
import { api } from '../../lib/api';
import { cbsdLabel, clock, mhz, patchColor, range } from '../../lib/format';
import type { Ppa } from '../../lib/types';
import { Button, Drawer, Empty, Field, Input, Module, Segmented, Tag, useAction, useConfirm } from '../../components/ui';
import { circlePolygon, hz, type SpectrumData } from './shared';

// Priority Access Licence protection areas: members get the PAL channels, non-members inside lose them.

export function PpasModule({ data, reload }: { data: SpectrumData; reload: () => Promise<void> }) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Ppa | 'new' | null>(null);

  const remove = async (p: Ppa) => {
    if (!(await confirm({ title: `Delete PPA ${p.name}?`, body: 'Its PAL channels become GAA spectrum again for every CBSD.', confirm: 'Delete', danger: true }))) return;
    await run(`del:${p.id}`, async () => {
      await api.del(`/api/ppas/${encodeURIComponent(p.id)}`);
      await reload();
    }, 'PPA deleted');
  };

  return (
    <Module title="PPAs" meta={data.ppas.length ? `${data.ppas.length}` : undefined} bodyClass="p-0"
      actions={<Button size="sm" icon={Plus} onClick={() => setEditing('new')}>New PPA</Button>}>
      <p className="border-b border-line px-3 py-2 text-sm text-ink-2">
        Member CBSDs see the PAL channels in spectrum inquiry and can be granted them as PAL. Non-members inside the area lose those channels
        (grant → <span className="font-mono text-xs">400 INTERFERENCE</span>).
      </p>
      {!data.ppas.length ? (
        <Empty icon={MapIcon} title="No PPAs">Create a PPA to give one or more registered CBSDs protected PAL channels.</Empty>
      ) : (
        <div className="max-h-[360px] overflow-auto">
          <table className="dtable">
            <thead>
              <tr>
                <th>Name</th>
                <th>PAL channels</th>
                <th>Members</th>
                <th>Area</th>
                <th className="w-[1%]"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {data.ppas.map((p) => (
                <tr key={p.id}>
                  <td className="max-w-[200px]">
                    <div className="truncate font-medium" title={p.name}>{p.name}</div>
                    <div className="truncate font-mono text-2xs text-ink-3">{p.source}{p.expiration ? ` · until ${clock(p.expiration, true).slice(0, 10)}` : ''}</div>
                  </td>
                  <td className="font-mono text-xs">
                    {p.channels.map((c, i) => <div key={i} className="whitespace-nowrap">{range(c.low, c.high)}{c.palId ? <span className="text-ink-3"> · {c.palId}</span> : null}</div>)}
                  </td>
                  <td>
                    <div className="flex flex-wrap items-center gap-1">
                      {p.members.slice(0, 6).map((m) => (
                        <span key={m} className="inline-block size-2.5 rounded-[2px]" style={{ background: patchColor(m) }} title={m} />
                      ))}
                      <span className="num text-xs text-ink-2">{p.members.length}</span>
                    </div>
                  </td>
                  <td className="text-xs text-ink-2">{p.geometry ? 'polygon' : 'members anywhere'}</td>
                  <td>
                    <div className="flex justify-end gap-0.5">
                      <Button size="sm" variant="ghost" icon={Pencil} aria-label="Edit" title={p.source === 'harness' ? 'Created by the test harness; edit the zone record there' : 'Edit'}
                        disabled={p.source === 'harness'} onClick={() => setEditing(p)} />
                      <Button size="sm" variant="danger-ghost" icon={Trash2} aria-label="Delete" title="Delete" onClick={() => void remove(p)} loading={busy === `del:${p.id}`} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <PpaEditor value={editing} data={data} onClose={() => setEditing(null)} onSaved={async () => {
        setEditing(null);
        await reload();
      }} />
    </Module>
  );
}

interface Chan { low: string; high: string; palId: string }
interface Draft {
  name: string;
  channels: Chan[];
  members: string[];
  area: 'anywhere' | 'circle' | 'keep';
  lat: string;
  lon: string;
  radiusKm: string;
  expiration: string;
}

function PpaEditor({ value, data, onClose, onSaved }: { value: Ppa | 'new' | null; data: SpectrumData; onClose: () => void; onSaved: () => Promise<void> }) {
  const [d, setD] = useState<Draft | null>(null);
  const [key, setKey] = useState<unknown>(null);
  const [tried, setTried] = useState(false);
  const { run, busy } = useAction();
  if (value && key !== value) {
    setKey(value);
    setTried(false);
    const p = value === 'new' ? null : value;
    setD({
      name: p?.name ?? '',
      channels: p?.channels.map((c) => ({ low: mhz(c.low), high: mhz(c.high), palId: c.palId ?? '' })) ?? [{ low: '3550', high: '3560', palId: '' }],
      members: p?.members ?? [],
      area: p?.geometry ? 'keep' : p ? 'anywhere' : 'circle',
      lat: '', lon: '', radiusKm: '10',
      expiration: p?.expiration ? new Date(p.expiration).toISOString().slice(0, 10) : '',
    });
  }
  if (!value && key !== null) setKey(null);
  const existing = value && value !== 'new' ? value : null;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => (x ? { ...x, [k]: v } : x));
  const setChan = (i: number, k: keyof Chan, v: string) => setD((x) => (x ? { ...x, channels: x.channels.map((c, j) => (j === i ? { ...c, [k]: v } : c)) } : x));

  const centerOnMembers = () => {
    if (!d) return;
    const pts = data.cbsds.filter((c) => d.members.includes(c.cbsdId) && c.lat != null && c.lon != null);
    if (!pts.length) return;
    set('lat', (pts.reduce((a, c) => a + c.lat!, 0) / pts.length).toFixed(5));
    set('lon', (pts.reduce((a, c) => a + c.lon!, 0) / pts.length).toFixed(5));
  };

  const check = d ? {
    name: d.name.trim() ? null : 'Required',
    channels: d.channels.length && d.channels.every((c) => Number(c.low) < Number(c.high)) ? null : 'Each channel needs low < high (MHz)',
    circle: d.area === 'circle' && !(d.lat.trim() && d.lon.trim() && Math.abs(Number(d.lat)) <= 90 && Math.abs(Number(d.lon)) <= 180 && Number(d.radiusKm) > 0)
      ? 'Centre latitude/longitude and a radius are required' : null,
  } : {};
  const invalid = Object.values(check).some(Boolean);
  const err: Partial<typeof check> = tried ? check : {};

  const save = () => d && run('save', async () => {
    const body = {
      name: d.name.trim(),
      channels: d.channels.map((c) => ({ low: hz(c.low), high: hz(c.high), palId: c.palId.trim() || null })),
      members: d.members,
      geometry: d.area === 'circle' ? circlePolygon(Number(d.lat), Number(d.lon), Number(d.radiusKm)) : d.area === 'keep' ? existing?.geometry ?? null : null,
      expiration: d.expiration ? Date.parse(`${d.expiration}T23:59:59Z`) : null,
    };
    if (existing) await api.put(`/api/ppas/${encodeURIComponent(existing.id)}`, body);
    else await api.post('/api/ppas', body);
    await onSaved();
  }, existing ? 'PPA updated' : 'PPA created');

  return (
    <Drawer open={!!value && !!d} onClose={onClose} width={580} title={existing ? `Edit PPA ${existing.name}` : 'New PPA'}>
      {d && (
        <form className="space-y-4 p-4" noValidate onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (!invalid) void save();
        }}>
          <Field label="Name" error={err.name}>
            <Input value={d.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Lab PPA 1" aria-invalid={!!err.name} autoFocus />
          </Field>
          <div>
            <div className="mb-1 flex items-center">
              <span className="text-sm font-medium text-ink-2">PAL channels</span>
              <Button size="sm" variant="ghost" icon={Plus} className="ml-auto" onClick={() => set('channels', [...d.channels, { low: '', high: '', palId: '' }])}>Add channel</Button>
            </div>
            <div className="space-y-2">
              {d.channels.map((c, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_1.3fr_auto] gap-2">
                  <Input aria-label="Low MHz" placeholder="Low MHz" inputMode="decimal" className="font-mono text-sm" value={c.low} onChange={(e) => setChan(i, 'low', e.target.value)} />
                  <Input aria-label="High MHz" placeholder="High MHz" inputMode="decimal" className="font-mono text-sm" value={c.high} onChange={(e) => setChan(i, 'high', e.target.value)} />
                  <Input aria-label="PAL ID" placeholder="PAL ID (optional)" className="font-mono text-sm" value={c.palId} onChange={(e) => setChan(i, 'palId', e.target.value)} />
                  <Button variant="ghost" icon={X} aria-label="Remove channel" disabled={d.channels.length === 1}
                    onClick={() => set('channels', d.channels.filter((_, j) => j !== i))} />
                </div>
              ))}
            </div>
            {err.channels ? <p className="mt-1 text-xs text-bad-ink">{err.channels}</p> : <p className="mt-1 text-xs text-ink-3">PAL channels are 10 MHz wide in 3550–3650 MHz.</p>}
          </div>
          <div>
            <div className="mb-1 text-sm font-medium text-ink-2">Members (cluster list)</div>
            {!data.cbsds.length ? (
              <p className="rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ink-3">No registered CBSDs yet. Members can be added once radios register.</p>
            ) : (
              <div className="max-h-48 overflow-y-auto rounded border border-line">
                {data.cbsds.map((c) => (
                  <label key={c.cbsdId} className="flex cursor-pointer items-center gap-2 border-b border-line px-2.5 py-1.5 text-sm last:border-b-0 hover:bg-panel-3/60">
                    <input type="checkbox" className="accent-[rgb(var(--sel))]" checked={d.members.includes(c.cbsdId)}
                      onChange={(e) => set('members', e.target.checked ? [...d.members, c.cbsdId] : d.members.filter((m) => m !== c.cbsdId))} />
                    <span className="inline-block size-2.5 flex-none rounded-[2px]" style={{ background: patchColor(c.cbsdId) }} />
                    <span className="font-mono text-xs">{cbsdLabel(c.cbsdId)}</span>
                    <span className="truncate text-xs text-ink-3">{c.serial} · Cat {c.category ?? '?'}{c.lat == null ? ' · no location' : ''}</span>
                  </label>
                ))}
              </div>
            )}
            {d.members.filter((m) => !data.cbsds.some((c) => c.cbsdId === m)).map((m) => (
              <div key={m} className="mt-1 flex items-center gap-2 text-xs text-ink-3">
                <Tag>not registered</Tag><span className="font-mono">{m}</span>
                <button type="button" className="text-bad-ink hover:underline" onClick={() => set('members', d.members.filter((x) => x !== m))}>remove</button>
              </div>
            ))}
          </div>
          <Field label="Area" hint={d.area === 'anywhere' ? 'No polygon: members get the PAL channels wherever they are; no CBSD is excluded.' : d.area === 'keep' ? 'The existing polygon is kept.' : 'A 64-point polygon approximating the circle is stored as the PPA contour.'}>
            <Segmented value={d.area} onChange={(v) => set('area', v)} options={[
              { value: 'circle', label: 'Circle' },
              { value: 'anywhere', label: 'Members anywhere' },
              ...(existing?.geometry ? [{ value: 'keep' as const, label: 'Existing polygon' }] : []),
            ]} />
          </Field>
          {d.area === 'circle' && (
            <div>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Centre latitude"><Input inputMode="decimal" className="font-mono text-sm" value={d.lat} onChange={(e) => set('lat', e.target.value)} /></Field>
                <Field label="Centre longitude"><Input inputMode="decimal" className="font-mono text-sm" value={d.lon} onChange={(e) => set('lon', e.target.value)} /></Field>
                <Field label="Radius (km)"><Input inputMode="decimal" className="font-mono text-sm" value={d.radiusKm} onChange={(e) => set('radiusKm', e.target.value)} /></Field>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <Button size="sm" variant="ghost" icon={Crosshair} onClick={centerOnMembers} disabled={!d.members.length}>Centre on members</Button>
                {err.circle && <span className="text-xs text-bad-ink">{err.circle}</span>}
              </div>
            </div>
          )}
          <Field label="Expiration" hint="Optional. After this date the PPA stops applying; PAL grants expire no later than this.">
            <Input type="date" value={d.expiration} onChange={(e) => set('expiration', e.target.value)} className="w-48" />
          </Field>
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={tried && invalid} loading={busy === 'save'}>{existing ? 'Save' : 'Create PPA'}</Button>
          </div>
        </form>
      )}
    </Drawer>
  );
}
