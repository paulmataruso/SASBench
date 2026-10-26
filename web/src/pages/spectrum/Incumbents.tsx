import { useState, type ReactNode } from 'react';
import { Braces, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { range } from '../../lib/format';
import { Button, Empty, Field, Input, Module, Segmented, Tabs, Tag, Textarea, useAction, useConfirm } from '../../components/ui';
import { circlePolygon, hz, rfc3339, type IncumbentRow, type SpectrumData } from './shared';

// Incumbent and harness data (the same records the WInnForum harness injects through /admin).
// Injected records are turned into protections / PPAs by the server immediately.

type TabKey = 'fss' | 'wisp' | 'pal' | 'exclusion' | 'other';

export function IncumbentsModule({ data, reload }: { data: SpectrumData; reload: () => Promise<void> }) {
  const [tab, setTab] = useState<TabKey>('fss');
  const exclusions = data.protections.filter((p) => p.kind === 'EXCLUSION_ZONE' && p.source === 'harness');
  return (
    <Module title="Incumbents & harness data" bodyClass="p-0">
      <Tabs
        className="px-2"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'fss', label: 'FSS earth stations', count: data.incumbents.fss.length },
          { value: 'wisp', label: 'GWBL / GWPZ', count: data.incumbents.wisp.length },
          { value: 'pal', label: 'PAL records', count: data.incumbents.pal.length },
          { value: 'exclusion', label: 'Exclusion zones', count: exclusions.length },
          { value: 'other', label: 'ESC sensors & peer SAS', count: data.incumbents.escSensors.length + data.incumbents.peerSas.length },
        ]}
      />
      {tab === 'fss' && <FssTab data={data} reload={reload} />}
      {tab === 'wisp' && <WispTab data={data} reload={reload} />}
      {tab === 'pal' && <PalTab data={data} reload={reload} />}
      {tab === 'exclusion' && <ExclusionTab data={data} reload={reload} />}
      {tab === 'other' && <OtherTab data={data} reload={reload} />}
    </Module>
  );
}

function useDelete(reload: () => Promise<void>) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const del = async (kind: string, id: string, label: string) => {
    if (!(await confirm({ title: `Delete ${label}?`, body: 'Protections derived from it are rebuilt immediately.', confirm: 'Delete', danger: true }))) return;
    await run(`del:${kind}:${id}`, async () => {
      await api.del(`/api/incumbents/${kind}/${encodeURIComponent(id)}`);
      await reload();
    }, `${label} deleted`);
  };
  return { del, busy };
}

function Split({ list, form, help }: { list: ReactNode; form: ReactNode; help: ReactNode }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 border-b border-line lg:border-b-0 lg:border-r">
        <p className="border-b border-line px-3 py-2 text-sm text-ink-2">{help}</p>
        {list}
      </div>
      <div className="p-3">{form}</div>
    </div>
  );
}

/** Form with a "raw JSON" escape hatch: the body built from the fields can be edited before injecting. */
function InjectForm({ title, kind, build, children, reload, submit = 'Inject' }: {
  title: string; kind: string; build: () => unknown | string; children: ReactNode; reload: () => Promise<void>; submit?: string;
}) {
  const { run, busy } = useAction();
  const [raw, setRaw] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    let body: unknown;
    if (raw !== null) {
      try {
        body = JSON.parse(raw);
      } catch (e: any) {
        setErr(`Invalid JSON: ${e.message}`);
        return;
      }
    } else {
      body = build();
      if (typeof body === 'string') {
        setErr(body);
        return;
      }
    }
    setErr(null);
    await run('inject', async () => {
      await api.post(`/api/incumbents/${kind}`, body);
      await reload();
    }, `${title} injected`);
  };
  const toggleRaw = () => {
    if (raw !== null) return setRaw(null);
    const b = build();
    setErr(typeof b === 'string' ? b : null);
    setRaw(typeof b === 'string' ? '{}' : JSON.stringify(b, null, 2));
  };
  return (
    <form className="space-y-3" onSubmit={(e) => {
      e.preventDefault();
      void go();
    }}>
      <div className="flex items-center">
        <h3 className="text-base font-semibold">{title}</h3>
        <Button size="sm" variant="ghost" icon={Braces} className="ml-auto" onClick={toggleRaw} aria-pressed={raw !== null}>{raw !== null ? 'Form' : 'Raw JSON'}</Button>
      </div>
      {raw !== null ? (
        <Textarea rows={16} value={raw} onChange={(e) => setRaw(e.target.value)} aria-label="Request body (JSON)" />
      ) : children}
      {err && <p className="text-xs text-bad-ink">{err}</p>}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={busy === 'inject'}>{submit}</Button>
      </div>
    </form>
  );
}

const num = (s: string) => (s.trim() === '' ? NaN : Number(s));
const coordErr = (lat: string, lon: string) =>
  !(Math.abs(num(lat)) <= 90) ? 'Latitude must be −90…90' : !(Math.abs(num(lon)) <= 180) ? 'Longitude must be −180…180' : null;

function Mini({ label, children }: { label: string; children: ReactNode }) {
  return <Field label={label}>{children}</Field>;
}

function TxtIn({ value, onChange, mono = true, ...rest }: { value: string; onChange: (v: string) => void; mono?: boolean; placeholder?: string }) {
  return <Input className={mono ? 'font-mono text-sm' : undefined} value={value} onChange={(e) => onChange(e.target.value)} {...rest} />;
}

function ListTable({ head, rows, empty }: { head: string[]; rows: ReactNode[]; empty: ReactNode }) {
  if (!rows.length) return <Empty title={empty} className="py-8" />;
  return (
    <div className="max-h-[340px] overflow-auto">
      <table className="dtable">
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}<th className="w-[1%]"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}

const loc = (ip: any) => (ip && typeof ip.latitude === 'number' ? `${ip.latitude.toFixed(4)}, ${ip.longitude.toFixed(4)}` : '—');
const frOf = (r: IncumbentRow, path: 'record' | null = 'record') => {
  const dp = (path ? r.data?.record : r.data)?.deploymentParam?.[0];
  return { ip: dp?.installationParam, fr: dp?.operationParam?.operationFrequencyRange };
};

// ---------------------------------------------------------------- FSS

function FssTab({ data, reload }: { data: SpectrumData; reload: () => Promise<void> }) {
  const { del, busy } = useDelete(reload);
  const [f, setF] = useState({ id: '', lat: '', lon: '', height: '10', low: '3600', high: '4200', azimuth: '180', gain: '45', ttc: false });
  const s = (k: keyof typeof f) => (v: any) => setF((x) => ({ ...x, [k]: v }));
  const derived = new Set(data.protections.filter((p) => p.kind === 'FSS_GWBL').map((p) => p.id.replace(/^fss_gwbl:/, '')));
  return (
    <Split
      help={<>An FSS below 3700 MHz with a GWBL (WISP without zone) within 150 km creates a 3650–3700 MHz exclusion (terminate) for CBSDs within 150 km of the earth station.</>}
      list={
        <ListTable
          head={['FSS id', 'Location', 'Band MHz', 'Effect']}
          empty="No FSS earth stations"
          rows={data.incumbents.fss.map((r) => {
            const { ip, fr } = frOf(r);
            return (
              <tr key={r.id}>
                <td className="font-mono text-xs">{r.id}{r.data?.ttc ? <Tag className="ml-2">TT&amp;C</Tag> : null}</td>
                <td className="num font-mono text-xs">{loc(ip)}</td>
                <td className="num font-mono text-xs">{fr ? range(fr.lowFrequency, fr.highFrequency) : '—'}</td>
                <td className="text-xs">{derived.has(r.id) ? <Tag tone="bad">3650–3700 excluded</Tag> : <span className="text-ink-3">none (no GWBL in 150 km)</span>}</td>
                <td><Button size="sm" variant="danger-ghost" icon={Trash2} aria-label="Delete" onClick={() => void del('fss', r.id, `FSS ${r.id}`)} loading={busy === `del:fss:${r.id}`} /></td>
              </tr>
            );
          })}
        />
      }
      form={
        <InjectForm title="Inject FSS" kind="fss" reload={reload} build={() => {
          if (!f.id.trim()) return 'An id is required';
          const e = coordErr(f.lat, f.lon);
          if (e) return e;
          if (!(num(f.low) < num(f.high))) return 'Low must be below high';
          return {
            record: {
              id: f.id.trim(),
              deploymentParam: [{
                installationParam: { latitude: num(f.lat), longitude: num(f.lon), height: num(f.height) || 0, heightType: 'AGL', antennaAzimuth: num(f.azimuth) || 0, antennaGain: num(f.gain) || 0 },
                operationParam: { operationFrequencyRange: { lowFrequency: hz(f.low), highFrequency: hz(f.high) } },
              }],
            },
            ttc: f.ttc,
          };
        }}>
          <Mini label="Record id"><TxtIn value={f.id} onChange={s('id')} placeholder="fss/lab/1" /></Mini>
          <div className="grid grid-cols-2 gap-3">
            <Mini label="Latitude"><TxtIn value={f.lat} onChange={s('lat')} /></Mini>
            <Mini label="Longitude"><TxtIn value={f.lon} onChange={s('lon')} /></Mini>
            <Mini label="Low MHz"><TxtIn value={f.low} onChange={s('low')} /></Mini>
            <Mini label="High MHz"><TxtIn value={f.high} onChange={s('high')} /></Mini>
            <Mini label="Height AGL (m)"><TxtIn value={f.height} onChange={s('height')} /></Mini>
            <Mini label="Azimuth (°)"><TxtIn value={f.azimuth} onChange={s('azimuth')} /></Mini>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" className="accent-[rgb(var(--sel))]" checked={f.ttc} onChange={(e) => s('ttc')(e.target.checked)} />
            TT&amp;C earth station
          </label>
        </InjectForm>
      }
    />
  );
}

// ---------------------------------------------------------------- WISP (GWBL point / GWPZ zone)

function WispTab({ data, reload }: { data: SpectrumData; reload: () => Promise<void> }) {
  const { del, busy } = useDelete(reload);
  const [f, setF] = useState({ id: '', lat: '', lon: '', low: '3650', high: '3700', type: 'gwbl' as 'gwbl' | 'gwpz', radius: '5' });
  const s = (k: keyof typeof f) => (v: any) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Split
      help={<>A WISP record without a zone is a GWBL point (it only matters near an FSS). With a zone it is a GWPZ: CBSDs inside lose its band (terminate).</>}
      list={
        <ListTable
          head={['WISP id', 'Type', 'Location', 'Band MHz']}
          empty="No GWBL / GWPZ records"
          rows={data.incumbents.wisp.map((r) => {
            const { ip, fr } = frOf(r);
            return (
              <tr key={r.id}>
                <td className="font-mono text-xs">{r.id}</td>
                <td>{r.data?.zone ? <Tag tone="bad">GWPZ zone</Tag> : <Tag>GWBL point</Tag>}</td>
                <td className="num font-mono text-xs">{loc(ip)}</td>
                <td className="num font-mono text-xs">{fr ? range(fr.lowFrequency, fr.highFrequency) : '—'}</td>
                <td><Button size="sm" variant="danger-ghost" icon={Trash2} aria-label="Delete" onClick={() => void del('wisp', r.id, `WISP ${r.id}`)} loading={busy === `del:wisp:${r.id}`} /></td>
              </tr>
            );
          })}
        />
      }
      form={
        <InjectForm title="Inject GWBL / GWPZ" kind="wisp" reload={reload} build={() => {
          if (!f.id.trim()) return 'An id is required';
          const e = coordErr(f.lat, f.lon);
          if (e) return e;
          if (!(num(f.low) < num(f.high))) return 'Low must be below high';
          if (f.type === 'gwpz' && !(num(f.radius) > 0)) return 'Zone radius must be positive';
          return {
            record: {
              id: f.id.trim(),
              deploymentParam: [{
                installationParam: { latitude: num(f.lat), longitude: num(f.lon) },
                operationParam: { operationFrequencyRange: { lowFrequency: hz(f.low), highFrequency: hz(f.high) } },
              }],
            },
            ...(f.type === 'gwpz' ? {
              zone: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: circlePolygon(num(f.lat), num(f.lon), num(f.radius)) }] },
            } : {}),
          };
        }}>
          <Segmented value={f.type} onChange={s('type')} options={[{ value: 'gwbl', label: 'GWBL point' }, { value: 'gwpz', label: 'GWPZ zone' }]} />
          <Mini label="Record id"><TxtIn value={f.id} onChange={s('id')} placeholder="wisp/lab/1" /></Mini>
          <div className="grid grid-cols-2 gap-3">
            <Mini label="Latitude"><TxtIn value={f.lat} onChange={s('lat')} /></Mini>
            <Mini label="Longitude"><TxtIn value={f.lon} onChange={s('lon')} /></Mini>
            <Mini label="Low MHz"><TxtIn value={f.low} onChange={s('low')} /></Mini>
            <Mini label="High MHz"><TxtIn value={f.high} onChange={s('high')} /></Mini>
            {f.type === 'gwpz' && <Mini label="Zone radius (km)"><TxtIn value={f.radius} onChange={s('radius')} /></Mini>}
          </div>
        </InjectForm>
      }
    />
  );
}

// ---------------------------------------------------------------- PAL records

function PalTab({ data, reload }: { data: SpectrumData; reload: () => Promise<void> }) {
  const { del, busy } = useDelete(reload);
  const nextYear = new Date(Date.now() + 365 * 86400e3).toISOString().slice(0, 10);
  const [f, setF] = useState({ palId: '', userId: '', low: '3550', high: '3560', expiration: nextYear });
  const s = (k: keyof typeof f) => (v: any) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Split
      help={<>PAL records feed harness-style PPA zone records that reference them by palId. For a quick lab PPA, create it directly in the PPAs panel instead.</>}
      list={
        <ListTable
          head={['PAL id', 'User id', 'Channel MHz', 'Expires', 'Status']}
          empty="No PAL records"
          rows={data.incumbents.pal.map((r) => {
            const pa = r.data?.channelAssignment?.primaryAssignment;
            return (
              <tr key={r.id}>
                <td className="font-mono text-xs">{r.id}</td>
                <td className="font-mono text-xs">{r.data?.userId ?? '—'}</td>
                <td className="num font-mono text-xs">{pa ? range(pa.lowFrequency, pa.highFrequency) : '—'}</td>
                <td className="text-xs">{r.data?.license?.licenseExpiration ?? '—'}</td>
                <td><Tag tone={(r.data?.licenseStatus ?? 'VALID') === 'VALID' ? 'ok' : 'off'}>{r.data?.licenseStatus ?? 'VALID'}</Tag></td>
                <td><Button size="sm" variant="danger-ghost" icon={Trash2} aria-label="Delete" onClick={() => void del('pal', r.id, `PAL ${r.id}`)} loading={busy === `del:pal:${r.id}`} /></td>
              </tr>
            );
          })}
        />
      }
      form={
        <InjectForm title="Inject PAL record" kind="pal" reload={reload} build={() => {
          if (!f.palId.trim()) return 'A palId is required';
          if (!(num(f.low) < num(f.high))) return 'Low must be below high';
          return {
            palId: f.palId.trim(),
            userId: f.userId.trim() || undefined,
            licenseStatus: 'VALID',
            channelAssignment: { primaryAssignment: { lowFrequency: hz(f.low), highFrequency: hz(f.high) } },
            license: { licenseExpiration: f.expiration ? rfc3339(Date.parse(`${f.expiration}T23:59:59Z`)) : undefined },
          };
        }}>
          <div className="grid grid-cols-2 gap-3">
            <Mini label="PAL id"><TxtIn value={f.palId} onChange={s('palId')} placeholder="pal/lab/1" /></Mini>
            <Mini label="Licensee userId"><TxtIn value={f.userId} onChange={s('userId')} /></Mini>
            <Mini label="Low MHz"><TxtIn value={f.low} onChange={s('low')} /></Mini>
            <Mini label="High MHz"><TxtIn value={f.high} onChange={s('high')} /></Mini>
          </div>
          <Mini label="License expiration"><Input type="date" value={f.expiration} onChange={(e) => s('expiration')(e.target.value)} className="w-48" /></Mini>
        </InjectForm>
      }
    />
  );
}

// ---------------------------------------------------------------- exclusion zones

function ExclusionTab({ data, reload }: { data: SpectrumData; reload: () => Promise<void> }) {
  const { del, busy } = useDelete(reload);
  const [f, setF] = useState({ lat: '', lon: '', radius: '20', low: '3550', high: '3700' });
  const s = (k: keyof typeof f) => (v: any) => setF((x) => ({ ...x, [k]: v }));
  const zones = data.protections.filter((p) => p.kind === 'EXCLUSION_ZONE' && p.source === 'harness');
  return (
    <Split
      help={<>CBSDs inside an exclusion zone cannot use its frequency ranges; existing grants there are terminated (heartbeat 500).</>}
      list={
        <ListTable
          head={['Zone', 'Ranges MHz', 'Active']}
          empty="No exclusion zones"
          rows={zones.map((p) => (
            <tr key={p.id}>
              <td className="font-mono text-xs">{p.id}</td>
              <td className="num font-mono text-xs">{(p.channels ?? [[p.low, p.high]]).map((c) => range(c[0], c[1])).join(', ')}</td>
              <td><Tag tone={p.active ? 'bad' : 'off'}>{p.active ? 'active' : 'inactive'}</Tag></td>
              <td><Button size="sm" variant="danger-ghost" icon={Trash2} aria-label="Delete" onClick={() => void del('exclusion_zone', p.id, 'Exclusion zone')} loading={busy === `del:exclusion_zone:${p.id}`} /></td>
            </tr>
          ))}
        />
      }
      form={
        <InjectForm title="Inject exclusion zone" kind="exclusion_zone" reload={reload} build={() => {
          const e = coordErr(f.lat, f.lon);
          if (e) return e;
          if (!(num(f.radius) > 0)) return 'Radius must be positive';
          if (!(num(f.low) < num(f.high))) return 'Low must be below high';
          return {
            zone: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: circlePolygon(num(f.lat), num(f.lon), num(f.radius)) }] },
            frequencyRanges: [{ lowFrequency: hz(f.low), highFrequency: hz(f.high) }],
          };
        }}>
          <div className="grid grid-cols-3 gap-3">
            <Mini label="Latitude"><TxtIn value={f.lat} onChange={s('lat')} /></Mini>
            <Mini label="Longitude"><TxtIn value={f.lon} onChange={s('lon')} /></Mini>
            <Mini label="Radius (km)"><TxtIn value={f.radius} onChange={s('radius')} /></Mini>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Mini label="Low MHz"><TxtIn value={f.low} onChange={s('low')} /></Mini>
            <Mini label="High MHz"><TxtIn value={f.high} onChange={s('high')} /></Mini>
          </div>
          <p className="text-xs text-ink-3">The circle is stored as a 64-point polygon. Use Raw JSON for arbitrary polygons or several ranges.</p>
        </InjectForm>
      }
    />
  );
}

// ---------------------------------------------------------------- ESC sensors / peer SAS

function OtherTab({ data, reload }: { data: SpectrumData; reload: () => Promise<void> }) {
  const { del, busy } = useDelete(reload);
  const [url, setUrl] = useState('');
  return (
    <Split
      help={<>ESC sensor records arrive from the test harness (read-only here). Peer SAS entries are polled for full activity dumps during the daily activities.</>}
      list={
        <ListTable
          head={['Kind', 'Id', 'Details']}
          empty="No ESC sensors or peer SAS"
          rows={[
            ...data.incumbents.escSensors.map((r) => (
              <tr key={`esc${r.id}`}>
                <td><Tag>ESC sensor</Tag></td>
                <td className="font-mono text-xs">{r.id}</td>
                <td className="num font-mono text-xs">{loc(r.data?.record?.installationParam ?? r.data?.installationParam)}</td>
                <td><Button size="sm" variant="danger-ghost" icon={Trash2} aria-label="Delete" onClick={() => void del('esc_sensor', r.id, `ESC sensor ${r.id}`)} loading={busy === `del:esc_sensor:${r.id}`} /></td>
              </tr>
            )),
            ...data.incumbents.peerSas.map((r) => (
              <tr key={`peer${r.id}`}>
                <td><Tag tone="sel">Peer SAS</Tag></td>
                <td className="max-w-[280px] truncate font-mono text-xs" title={r.id}>{r.id}</td>
                <td className="text-xs text-ink-3">{r.data?.name ?? ''}</td>
                <td><Button size="sm" variant="danger-ghost" icon={Trash2} aria-label="Delete" onClick={() => void del('peer_sas', r.id, 'Peer SAS')} loading={busy === `del:peer_sas:${r.id}`} /></td>
              </tr>
            )),
          ]}
        />
      }
      form={
        <InjectForm title="Add peer SAS" kind="peer_sas" reload={reload} submit="Add" build={() => {
          if (!/^https?:\/\//.test(url.trim())) return 'Enter the peer SAS base URL (https://…)';
          return { url: url.trim() };
        }}>
          <Mini label="Base URL"><TxtIn value={url} onChange={setUrl} placeholder="https://peer-sas.example:9000/v1.3" /></Mini>
          <p className="text-xs text-ink-3">Its full activity dump is fetched over HTTPS each time the daily activities run.</p>
        </InjectForm>
      }
    />
  );
}
