import { useMemo, useState, type ReactNode } from 'react';
import { Ban, BookUser, FileSignature, Fingerprint, MapPin, Plus, Trash2, UserCheck } from 'lucide-react';
import { api } from '../lib/api';
import { useResource } from '../lib/live';
import { Link, setQuery, useLocation } from '../lib/router';
import { clock } from '../lib/format';
import type { CertRecord } from '../lib/types';
import {
  Button, CopyButton, Drawer, Empty, ErrorNote, Field, Input, JsonView, Module, PageHeader, Segmented, Select, SkeletonRows,
  Switch, Tabs, Tag, Textarea, useAction, useConfirm,
} from '../components/ui';

// Registry: FCC IDs, user IDs, blacklist, REG-Conditional preloads, CPI users and a CPI signing tool.

interface FccRow { fcc_id: string; max_eirp: number | null; created_at: number }
interface UserRow { user_id: string; created_at: number }
interface BlRow { id: number; fcc_id: string; serial: string | null; reason: string | null; created_at: number }
interface CondRow { fcc_id: string; serial: string; data: any; source: string | null; created_at: number }
interface CpiRow { cpi_id: string; name: string | null; public_key: string; source: string; created_at: number }
interface RegistryData { fccIds: FccRow[]; userIds: UserRow[]; blacklist: BlRow[]; conditional: CondRow[]; cpiUsers: CpiRow[] }

type TabKey = 'fcc' | 'users' | 'blacklist' | 'conditional' | 'cpi' | 'sign';

const RADIO_TECH = ['E_UTRA', 'NR', 'CAMBIUM_NETWORKS', 'FOUR_G_BBW_SAA_1', 'REDLINE', 'TARANA_WIRELESS'];

export function RegistryPage() {
  const { query } = useLocation();
  const tab = ((query.get('tab') as TabKey) || 'fcc') as TabKey;
  const res = useResource<RegistryData>('/api/registry', ['registry']);
  const settings = useResource<{ settings: Record<string, any> }>('/api/settings', ['settings']);
  const s = settings.data?.settings;
  const d = res.data;

  return (
    <div>
      <PageHeader
        title="Registry"
        sub="What the SAS knows about devices and installers before they register. The WInnForum test harness fills these through /admin/injectdata/…; you can manage them here."
      />
      <Tabs
        className="mb-4"
        value={tab}
        onChange={(v) => setQuery('tab', v === 'fcc' ? null : v)}
        tabs={[
          { value: 'fcc', label: 'FCC IDs', count: d?.fccIds.length },
          { value: 'users', label: 'User IDs', count: d?.userIds.length },
          { value: 'blacklist', label: 'Blacklist', count: d?.blacklist.length },
          { value: 'conditional', label: 'Conditional registration', count: d?.conditional.length },
          { value: 'cpi', label: 'CPI users', count: d?.cpiUsers.length },
          { value: 'sign', label: 'Sign CPI data' },
        ]}
      />
      {res.error && !d && <ErrorNote>Could not load the registry: {res.error}</ErrorNote>}
      {tab === 'fcc' && <FccTab rows={d?.fccIds} enforced={s?.requireKnownFccId} defaultEirp={s?.defaultFccMaxEirp} />}
      {tab === 'users' && <UsersTab rows={d?.userIds} enforced={s?.requireKnownUserId} />}
      {tab === 'blacklist' && <BlacklistTab rows={d?.blacklist} />}
      {tab === 'conditional' && <ConditionalTab rows={d?.conditional} policy={s?.registrationPolicy} />}
      {tab === 'cpi' && <CpiTab rows={d?.cpiUsers} policy={s?.registrationPolicy} />}
      {tab === 'sign' && <SignTab />}
    </div>
  );
}

// ---------------------------------------------------------------- shared bits

function TwoUp({ form, list }: { form: ReactNode; list: ReactNode }) {
  return <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">{form}{list}</div>;
}

function Enforcement({ on, label }: { on: boolean | undefined; label: string }) {
  if (on === undefined) return null;
  return (
    <Link to="/settings" title={`Settings → ${label}`}>
      <Tag tone={on ? 'ok' : 'off'}>{on ? 'Enforced' : 'Not enforced'}</Tag>
    </Link>
  );
}

function DeleteBtn({ label, onClick, busy }: { label: string; onClick: () => void; busy?: boolean }) {
  return <Button size="sm" variant="danger-ghost" icon={Trash2} onClick={onClick} loading={busy} aria-label={label} title={label} />;
}

function useRemove() {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const remove = async (key: string, title: string, body: ReactNode, path: string) => {
    if (!(await confirm({ title, body, confirm: 'Remove', danger: true }))) return;
    await run(key, () => api.del(path), 'Removed');
  };
  return { remove, busy };
}

const num = (v: string) => (v.trim() === '' ? undefined : Number(v));

// ---------------------------------------------------------------- FCC IDs

function FccTab({ rows, enforced, defaultEirp }: { rows?: FccRow[]; enforced?: boolean; defaultEirp?: number }) {
  const { run, busy } = useAction();
  const { remove, busy: rmBusy } = useRemove();
  const [fccId, setFccId] = useState('');
  const [maxEirp, setMaxEirp] = useState('47');
  const [err, setErr] = useState<string | null>(null);

  const add = async () => {
    const v = fccId.trim();
    if (!v) return setErr('FCC ID is required');
    if (v.length > 19) return setErr('FCC IDs are at most 19 characters');
    setErr(null);
    const r = await run('add', () => api.post('/api/registry/fcc-ids', { fccId: v, maxEirp }), `FCC ID ${v} added`);
    if (r) setFccId('');
  };

  return (
    <TwoUp
      form={
        <Module title="Add FCC ID">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <Field label="FCC ID" error={err}>
              <Input value={fccId} onChange={(e) => setFccId(e.target.value)} className="font-mono" placeholder="e.g. 2AG32MBS3500" aria-invalid={!!err} />
            </Field>
            <Field label="Certified max EIRP (dBm/10 MHz)" hint="Upper bound for grants to devices with this FCC ID">
              <Input type="number" step="0.1" value={maxEirp} onChange={(e) => setMaxEirp(e.target.value)} className="num" />
            </Field>
            <Button type="submit" variant="primary" icon={Plus} loading={busy === 'add'}>Add</Button>
          </form>
        </Module>
      }
      list={
        <Module title="FCC IDs" meta={<Enforcement on={enforced} label="Require known FCC ID" />} bodyClass="p-0">
          {!rows ? <SkeletonRows rows={4} cols={3} /> : !rows.length ? (
            <Empty icon={BookUser} title="No FCC IDs injected">
              FCC IDs only matter when “Require known FCC ID” is on (the WInnForum profile turns it on); then unknown FCC IDs get responseCode 103.
              Otherwise any FCC ID registers with the default max EIRP of {defaultEirp ?? 47} dBm/10 MHz.
            </Empty>
          ) : (
            <table className="dtable">
              <thead><tr><th>FCC ID</th><th className="text-right">Max EIRP</th><th>Added</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.fcc_id}>
                    <td className="font-mono text-xs">{r.fcc_id}</td>
                    <td className="num text-right">{r.max_eirp ?? '—'} <span className="text-xs text-ink-3">dBm/10 MHz</span></td>
                    <td className="num whitespace-nowrap text-ink-2">{clock(r.created_at, true)}</td>
                    <td className="w-10 text-right">
                      <DeleteBtn label={`Remove ${r.fcc_id}`} busy={rmBusy === r.fcc_id}
                        onClick={() => remove(r.fcc_id, `Remove FCC ID ${r.fcc_id}?`, enforced ? 'New registrations with this FCC ID will be rejected (103). Registered CBSDs keep their grants.' : 'Registrations fall back to the default max EIRP.', `/api/registry/fcc-ids/${encodeURIComponent(r.fcc_id)}`)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Module>
      }
    />
  );
}

// ---------------------------------------------------------------- user IDs

function UsersTab({ rows, enforced }: { rows?: UserRow[]; enforced?: boolean }) {
  const { run, busy } = useAction();
  const { remove, busy: rmBusy } = useRemove();
  const [userId, setUserId] = useState('');
  const add = async () => {
    const v = userId.trim();
    if (!v) return;
    const r = await run('add', () => api.post('/api/registry/user-ids', { userId: v }), `User ID ${v} added`);
    if (r) setUserId('');
  };
  return (
    <TwoUp
      form={
        <Module title="Add user ID">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <Field label="User ID" hint="The userId a radio or domain proxy sends in its registration request">
              <Input value={userId} onChange={(e) => setUserId(e.target.value)} className="font-mono" />
            </Field>
            <Button type="submit" variant="primary" icon={Plus} loading={busy === 'add'} disabled={!userId.trim()}>Add</Button>
          </form>
        </Module>
      }
      list={
        <Module title="User IDs" meta={<Enforcement on={enforced} label="Require known user ID" />} bodyClass="p-0">
          {!rows ? <SkeletonRows rows={4} cols={2} /> : !rows.length ? (
            <Empty icon={UserCheck} title="No user IDs injected">
              User IDs only matter when “Require known user ID” is on (the WInnForum profile turns it on); then unknown user IDs get responseCode 103.
            </Empty>
          ) : (
            <table className="dtable">
              <thead><tr><th>User ID</th><th>Added</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.user_id}>
                    <td className="font-mono text-xs">{r.user_id}</td>
                    <td className="num whitespace-nowrap text-ink-2">{clock(r.created_at, true)}</td>
                    <td className="w-10 text-right">
                      <DeleteBtn label={`Remove ${r.user_id}`} busy={rmBusy === r.user_id}
                        onClick={() => remove(r.user_id, `Remove user ID ${r.user_id}?`, null, `/api/registry/user-ids/${encodeURIComponent(r.user_id)}`)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Module>
      }
    />
  );
}

// ---------------------------------------------------------------- blacklist

function BlacklistTab({ rows }: { rows?: BlRow[] }) {
  const { run, busy } = useAction();
  const { remove, busy: rmBusy } = useRemove();
  const confirm = useConfirm();
  const [f, setF] = useState({ fccId: '', serial: '', reason: '' });
  const add = async () => {
    if (!f.fccId.trim()) return;
    const ok = await confirm({
      title: f.serial.trim() ? `Blacklist ${f.fccId.trim()} / ${f.serial.trim()}?` : `Blacklist every device with FCC ID ${f.fccId.trim()}?`,
      body: 'Matching CBSDs get responseCode 101 (BLACKLISTED) and their grants are terminated on their next request.',
      confirm: 'Blacklist', danger: true,
    });
    if (!ok) return;
    const r = await run('add', () => api.post('/api/registry/blacklist', { fccId: f.fccId.trim(), serial: f.serial.trim() || undefined, reason: f.reason.trim() || undefined }), 'Blacklist entry added');
    if (r) setF({ fccId: '', serial: '', reason: '' });
  };
  return (
    <TwoUp
      form={
        <Module title="Blacklist a device">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <Field label="FCC ID"><Input value={f.fccId} onChange={(e) => setF({ ...f, fccId: e.target.value })} className="font-mono" /></Field>
            <Field label="Serial number (optional)" hint="Blank blacklists every serial of this FCC ID">
              <Input value={f.serial} onChange={(e) => setF({ ...f, serial: e.target.value })} className="font-mono" />
            </Field>
            <Field label="Reason (optional)"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
            <Button type="submit" variant="danger" icon={Ban} loading={busy === 'add'} disabled={!f.fccId.trim()}>Blacklist</Button>
          </form>
        </Module>
      }
      list={
        <Module title="Blacklist" bodyClass="p-0">
          {!rows ? <SkeletonRows rows={3} cols={4} /> : !rows.length ? (
            <Empty icon={Ban} title="Nothing blacklisted">Blacklisted devices get responseCode 101 (BLACKLISTED) on every request, and their grants are terminated.</Empty>
          ) : (
            <table className="dtable">
              <thead><tr><th>FCC ID</th><th>Serial</th><th>Reason</th><th>Added</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="font-mono text-xs">{r.fcc_id}</td>
                    <td className="font-mono text-xs">{r.serial ?? <Tag>all serials</Tag>}</td>
                    <td className="max-w-[280px] truncate text-ink-2">{r.reason ?? '—'}</td>
                    <td className="num whitespace-nowrap text-ink-2">{clock(r.created_at, true)}</td>
                    <td className="w-10 text-right">
                      <DeleteBtn label="Remove from blacklist" busy={rmBusy === String(r.id)}
                        onClick={() => remove(String(r.id), 'Remove blacklist entry?', 'The device can register again.', `/api/registry/blacklist/${r.id}`)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Module>
      }
    />
  );
}

// ---------------------------------------------------------------- conditional registration

const EMPTY_COND = {
  fccId: '', serial: '', cbsdCategory: 'B', radioTechnology: 'E_UTRA', latitude: '', longitude: '', height: '', heightType: 'AGL',
  indoorDeployment: false, antennaAzimuth: '', antennaDowntilt: '', antennaGain: '', antennaBeamwidth: '', eirpCapability: '',
  measWithout: false, measWith: false,
};

function ConditionalTab({ rows, policy }: { rows?: CondRow[]; policy?: string }) {
  const { run, busy } = useAction();
  const { remove, busy: rmBusy } = useRemove();
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [f, setF] = useState(EMPTY_COND);
  const [json, setJson] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<CondRow | null>(null);
  const set = (k: keyof typeof EMPTY_COND, v: any) => setF((x) => ({ ...x, [k]: v }));

  const record = () => {
    const ip: Record<string, any> = {};
    const put = (k: string, v: string) => {
      const n = num(v);
      if (n !== undefined) ip[k] = n;
    };
    put('latitude', f.latitude); put('longitude', f.longitude); put('height', f.height);
    if (f.height.trim()) ip.heightType = f.heightType;
    ip.indoorDeployment = f.indoorDeployment;
    put('antennaAzimuth', f.antennaAzimuth); put('antennaDowntilt', f.antennaDowntilt); put('antennaGain', f.antennaGain);
    put('antennaBeamwidth', f.antennaBeamwidth); put('eirpCapability', f.eirpCapability);
    const meas = [f.measWithout && 'RECEIVED_POWER_WITHOUT_GRANT', f.measWith && 'RECEIVED_POWER_WITH_GRANT'].filter(Boolean);
    return {
      fccId: f.fccId.trim(), cbsdSerialNumber: f.serial.trim(), cbsdCategory: f.cbsdCategory,
      airInterface: { radioTechnology: f.radioTechnology }, installationParam: ip, measCapability: meas,
    };
  };

  const submit = async () => {
    let data: any[];
    if (mode === 'form') {
      if (!f.fccId.trim() || !f.serial.trim()) return setErr('FCC ID and serial number are required');
      data = [record()];
    } else {
      try {
        const parsed = JSON.parse(json);
        data = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.registrationData) ? parsed.registrationData : [parsed];
      } catch (e: any) {
        return setErr(`Invalid JSON: ${e.message}`);
      }
    }
    setErr(null);
    const r = await run('add', () => api.post('/api/registry/conditional', { registrationData: data }), `Preloaded ${data.length} record${data.length > 1 ? 's' : ''}`);
    if (r) {
      setF(EMPTY_COND);
      setJson('');
    }
  };

  const numField = (k: keyof typeof EMPTY_COND, label: string, hint?: string, step = 'any') => (
    <Field label={label} hint={hint}>
      <Input type="number" step={step} value={f[k] as string} onChange={(e) => set(k, e.target.value)} className="num" />
    </Field>
  );

  return (
    <TwoUp
      form={
        <Module
          title="Preload registration data"
          actions={<Segmented size="sm" label="Input mode" value={mode} onChange={(v) => { setMode(v); setErr(null); if (v === 'json' && !json) setJson(JSON.stringify([record()], null, 2)); }} options={[{ value: 'form', label: 'Form' }, { value: 'json', label: 'JSON' }]} />}
        >
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            {mode === 'json' ? (
              <Field label="registrationData" error={err} hint="One record or an array; each needs fccId and cbsdSerialNumber (same format as /admin/injectdata/conditional_registration)">
                <Textarea rows={16} value={json} onChange={(e) => setJson(e.target.value)} aria-invalid={!!err} />
              </Field>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="FCC ID"><Input value={f.fccId} onChange={(e) => set('fccId', e.target.value)} className="font-mono" /></Field>
                  <Field label="Serial number"><Input value={f.serial} onChange={(e) => set('serial', e.target.value)} className="font-mono" /></Field>
                  <Field label="Category">
                    <Select value={f.cbsdCategory} onChange={(e) => set('cbsdCategory', e.target.value)}>
                      <option value="A">A</option><option value="B">B</option>
                    </Select>
                  </Field>
                  <Field label="Radio technology">
                    <Select value={f.radioTechnology} onChange={(e) => set('radioTechnology', e.target.value)}>
                      {RADIO_TECH.map((t) => <option key={t} value={t}>{t}</option>)}
                    </Select>
                  </Field>
                </div>
                <div className="silk pt-1">Installation parameters</div>
                <div className="grid grid-cols-2 gap-3">
                  {numField('latitude', 'Latitude', '−90 … 90')}
                  {numField('longitude', 'Longitude', '−180 … 180')}
                  {numField('height', 'Antenna height (m)')}
                  <Field label="Height type">
                    <Select value={f.heightType} onChange={(e) => set('heightType', e.target.value)}>
                      <option value="AGL">AGL</option><option value="AMSL">AMSL</option>
                    </Select>
                  </Field>
                  {numField('antennaAzimuth', 'Azimuth (°)', '0 … 359')}
                  {numField('antennaDowntilt', 'Downtilt (°)', '−90 … 90')}
                  {numField('antennaGain', 'Antenna gain (dBi)', '−127 … 128')}
                  {numField('antennaBeamwidth', 'Beamwidth (°)', '0 … 360')}
                  {numField('eirpCapability', 'EIRP capability', 'dBm/10 MHz')}
                </div>
                <Switch checked={f.indoorDeployment} onChange={(v) => set('indoorDeployment', v)} label="Indoor deployment" />
                <fieldset>
                  <legend className="mb-1 text-sm font-medium text-ink-2">Measurement capability</legend>
                  {(['measWithout', 'measWith'] as const).map((k) => (
                    <label key={k} className="flex items-center gap-2 py-0.5 text-base">
                      <input type="checkbox" className="size-3.5 accent-[rgb(var(--sel))]" checked={f[k]} onChange={(e) => set(k, e.target.checked)} />
                      <span className="font-mono text-xs">{k === 'measWithout' ? 'RECEIVED_POWER_WITHOUT_GRANT' : 'RECEIVED_POWER_WITH_GRANT'}</span>
                    </label>
                  ))}
                </fieldset>
                {err && <p className="text-xs text-bad-ink">{err}</p>}
              </>
            )}
            <Button type="submit" variant="primary" icon={Plus} loading={busy === 'add'}>Preload</Button>
          </form>
        </Module>
      }
      list={
        <Module title="Preloaded devices" meta={policy ? <span>Registration policy: <span className="font-medium text-ink-2">{policy}</span></span> : undefined} bodyClass="p-0">
          {!rows ? <SkeletonRows rows={4} cols={5} /> : !rows.length ? (
            <Empty icon={MapPin} title="No preloaded registrations">
              REG-Conditional parameters stored here are merged into a CBSD's registration. Use it for Category B radios that cannot send installation parameters
              themselves; under the strict policy a Category B registration needs either preloaded data or CPI-signed data.
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="dtable">
                <thead><tr><th>FCC ID</th><th>Serial</th><th>Cat.</th><th>Radio</th><th>Location</th><th>Source</th><th>Added</th><th /></tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const ip = r.data?.installationParam ?? {};
                    const key = `${r.fcc_id}/${r.serial}`;
                    return (
                      <tr key={key} className="cursor-pointer" tabIndex={0} onClick={() => setOpen(r)} onKeyDown={(e) => e.key === 'Enter' && setOpen(r)}>
                        <td className="font-mono text-xs">{r.fcc_id}</td>
                        <td className="font-mono text-xs">{r.serial}</td>
                        <td>{r.data?.cbsdCategory ?? '—'}</td>
                        <td className="text-ink-2">{r.data?.airInterface?.radioTechnology ?? '—'}</td>
                        <td className="num whitespace-nowrap text-ink-2">
                          {ip.latitude !== undefined ? `${ip.latitude}, ${ip.longitude}` : '—'}
                          {ip.height !== undefined && <span className="text-ink-3"> · {ip.height} m {ip.heightType ?? ''}</span>}
                        </td>
                        <td><Tag>{r.source ?? '—'}</Tag></td>
                        <td className="num whitespace-nowrap text-ink-2">{clock(r.created_at, true)}</td>
                        <td className="w-10 text-right" onClick={(e) => e.stopPropagation()}>
                          <DeleteBtn label={`Remove ${key}`} busy={rmBusy === key}
                            onClick={() => remove(key, `Remove preloaded data for ${key}?`, 'Registered CBSDs keep their current parameters until they re-register.', `/api/registry/conditional/${encodeURIComponent(r.fcc_id)}/${encodeURIComponent(r.serial)}`)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Drawer open={!!open} onClose={() => setOpen(null)} title={open ? `${open.fcc_id} / ${open.serial}` : ''} actions={open ? <CopyButton text={JSON.stringify(open.data, null, 2)} label="Copy JSON" size="md" /> : null}>
            {open && <div className="p-4"><JsonView value={open.data} /></div>}
          </Drawer>
        </Module>
      }
    />
  );
}

// ---------------------------------------------------------------- CPI users

function CpiTab({ rows, policy }: { rows?: CpiRow[]; policy?: string }) {
  const certs = useResource<{ certs: CertRecord[] }>('/api/certs', ['certs']);
  const installers = useMemo(() => (certs.data?.certs ?? []).filter((c) => c.kind === 'installer' || c.details.cpiId), [certs.data]);
  const { run, busy } = useAction();
  const { remove, busy: rmBusy } = useRemove();
  const [src, setSrc] = useState<'cert' | 'pem'>('cert');
  const [f, setF] = useState({ cpiId: '', name: '', certId: '', publicKey: '' });
  const [err, setErr] = useState<string | null>(null);

  const pickCert = (id: string) => {
    const c = installers.find((x) => x.id === id);
    setF((x) => ({ ...x, certId: id, cpiId: x.cpiId || c?.meta.cpiId || c?.details.cpiId || '', name: x.name || c?.meta.cpiName || c?.details.commonName || '' }));
  };

  const add = async () => {
    if (!f.cpiId.trim()) return setErr('CPI ID is required');
    if (src === 'cert' && !f.certId) return setErr('Choose an installer certificate');
    if (src === 'pem' && !f.publicKey.includes('BEGIN')) return setErr('Paste a public key or certificate in PEM format');
    setErr(null);
    const body = src === 'cert' ? { cpiId: f.cpiId.trim(), name: f.name, certId: f.certId } : { cpiId: f.cpiId.trim(), name: f.name, publicKey: f.publicKey };
    const r = await run('add', () => api.post('/api/registry/cpi-users', body), `CPI ${f.cpiId.trim()} added`);
    if (r) setF({ cpiId: '', name: '', certId: '', publicKey: '' });
  };

  return (
    <TwoUp
      form={
        <Module title="Add CPI user">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <Field label="Public key from">
              <Segmented value={src} onChange={setSrc} options={[{ value: 'cert', label: 'Installer certificate' }, { value: 'pem', label: 'Paste PEM' }]} />
            </Field>
            {src === 'cert' ? (
              <Field label="Installer certificate" hint={installers.length ? undefined : <>No installer certificates yet — issue one on <Link to="/certificates" className="text-sel-ink underline">Certificates</Link> (it registers its CPI automatically).</>}>
                <Select value={f.certId} onChange={(e) => pickCert(e.target.value)}>
                  <option value="">Choose…</option>
                  {installers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.details.cpiId ? ` · ${c.details.cpiId}` : ''}</option>)}
                </Select>
              </Field>
            ) : (
              <Field label="Public key or certificate (PEM)">
                <Textarea rows={6} value={f.publicKey} onChange={(e) => setF({ ...f, publicKey: e.target.value })} placeholder="-----BEGIN PUBLIC KEY-----" />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="CPI ID"><Input value={f.cpiId} onChange={(e) => setF({ ...f, cpiId: e.target.value })} className="font-mono" /></Field>
              <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            </div>
            {err && <p className="text-xs text-bad-ink">{err}</p>}
            <Button type="submit" variant="primary" icon={Plus} loading={busy === 'add'}>Add</Button>
          </form>
        </Module>
      }
      list={
        <Module title="Certified professional installers" meta={policy ? <span>Registration policy: <span className="font-medium text-ink-2">{policy}</span></span> : undefined} bodyClass="p-0">
          {!rows ? <SkeletonRows rows={3} cols={4} /> : !rows.length ? (
            <Empty icon={Fingerprint} title="No CPIs registered">
              The SAS verifies cpiSignatureData with the public key of the CPI named in it. Under the strict policy, signatures from unknown CPIs or with bad signatures get
              responseCode 103; under lenient they are logged as warnings.
            </Empty>
          ) : (
            <table className="dtable">
              <thead><tr><th>CPI ID</th><th>Name</th><th>Source</th><th>Key</th><th>Added</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.cpi_id}>
                    <td className="font-mono text-xs">{r.cpi_id}</td>
                    <td>{r.name || '—'}</td>
                    <td><Tag>{r.source}</Tag></td>
                    <td><span className="inline-flex items-center gap-1 text-xs text-ink-3">SPKI PEM <CopyButton text={r.public_key} label={`Copy public key of ${r.cpi_id}`} /></span></td>
                    <td className="num whitespace-nowrap text-ink-2">{clock(r.created_at, true)}</td>
                    <td className="w-10 text-right">
                      <DeleteBtn label={`Remove ${r.cpi_id}`} busy={rmBusy === r.cpi_id}
                        onClick={() => remove(r.cpi_id, `Remove CPI ${r.cpi_id}?`, 'Registrations signed by this CPI can no longer be verified.', `/api/registry/cpi-users/${encodeURIComponent(r.cpi_id)}`)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Module>
      }
    />
  );
}

// ---------------------------------------------------------------- CPI signing tool

const IP_TEMPLATE = JSON.stringify({
  latitude: 40.0150, longitude: -105.2705, height: 6, heightType: 'AGL', indoorDeployment: false, antennaAzimuth: 90,
  antennaDowntilt: 5, antennaGain: 16, antennaBeamwidth: 65, eirpCapability: 37,
}, null, 2);

interface SignResult { cpiSignatureData: { protectedHeader: string; encodedCpiSignedData: string; digitalSignature: string }; signedData: any }

function SignTab() {
  const certs = useResource<{ certs: CertRecord[] }>('/api/certs', ['certs']);
  const signers = useMemo(() => (certs.data?.certs ?? []).filter((c) => (c.kind === 'installer' || c.details.cpiId) && c.hasKey && !c.revokedAt), [certs.data]);
  const { run, busy } = useAction();
  const [src, setSrc] = useState<'cert' | 'key'>('cert');
  const [f, setF] = useState({ installerCertId: '', privateKeyPem: '', cpiId: '', cpiName: '', fccId: '', serial: '', ip: IP_TEMPLATE });
  const [err, setErr] = useState<string | null>(null);
  const [out, setOut] = useState<SignResult | null>(null);
  const certId = f.installerCertId || signers[0]?.id || '';

  const sign = async () => {
    let installationParam: any;
    try {
      installationParam = JSON.parse(f.ip);
    } catch (e: any) {
      return setErr(`installationParam is not valid JSON: ${e.message}`);
    }
    if (!f.fccId.trim() || !f.serial.trim()) return setErr('FCC ID and serial number are required');
    if (src === 'cert' && !certId) return setErr('Choose an installer certificate, or paste a private key');
    if (src === 'key' && (!f.privateKeyPem.includes('BEGIN') || !f.cpiId.trim() || !f.cpiName.trim())) return setErr('Paste the private key and give the CPI ID and name');
    setErr(null);
    const body = {
      ...(src === 'cert' ? { installerCertId: certId } : { privateKeyPem: f.privateKeyPem }),
      cpiId: f.cpiId.trim() || undefined, cpiName: f.cpiName.trim() || undefined,
      fccId: f.fccId.trim(), cbsdSerialNumber: f.serial.trim(), installationParam,
    };
    const r = await run('sign', () => api.post<SignResult>('/api/cpi/sign', body), 'Signed');
    if (r) setOut(r);
  };

  const snippet = out && {
    registrationRequest: [{
      userId: 'your-user-id', fccId: out.signedData.fccId, cbsdSerialNumber: out.signedData.cbsdSerialNumber, cbsdCategory: 'B',
      airInterface: { radioTechnology: 'E_UTRA' }, measCapability: [], cpiSignatureData: out.cpiSignatureData,
    }],
  };

  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <Module title="Sign installation data as a CPI">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void sign(); }}>
          <p className="text-sm text-ink-3">
            Produces the <span className="font-mono text-xs">cpiSignatureData</span> object (JWS, RS256 or ES256) that a Category B radio or domain proxy sends in its registration request instead of plaintext installation parameters.
          </p>
          <Field label="Sign with">
            <Segmented value={src} onChange={setSrc} options={[{ value: 'cert', label: 'Installer certificate' }, { value: 'key', label: 'Paste private key' }]} />
          </Field>
          {src === 'cert' ? (
            <Field label="Installer certificate" hint={signers.length ? 'CPI ID and name default to the certificate’s' : undefined}>
              {signers.length ? (
                <Select value={certId} onChange={(e) => setF({ ...f, installerCertId: e.target.value })}>
                  {signers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.details.cpiId ? ` · ${c.details.cpiId}` : ''}</option>)}
                </Select>
              ) : (
                <p className="rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ink-3">
                  No installer certificate with a private key. Issue one on <Link to="/certificates" className="text-sel-ink underline">Certificates → Installer (CPI)</Link>.
                </p>
              )}
            </Field>
          ) : (
            <Field label="CPI private key (PEM)">
              <Textarea rows={5} value={f.privateKeyPem} onChange={(e) => setF({ ...f, privateKeyPem: e.target.value })} placeholder="-----BEGIN PRIVATE KEY-----" />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label={src === 'cert' ? 'CPI ID (override)' : 'CPI ID'}><Input value={f.cpiId} onChange={(e) => setF({ ...f, cpiId: e.target.value })} className="font-mono" /></Field>
            <Field label={src === 'cert' ? 'CPI name (override)' : 'CPI name'}><Input value={f.cpiName} onChange={(e) => setF({ ...f, cpiName: e.target.value })} /></Field>
            <Field label="FCC ID"><Input value={f.fccId} onChange={(e) => setF({ ...f, fccId: e.target.value })} className="font-mono" /></Field>
            <Field label="Serial number"><Input value={f.serial} onChange={(e) => setF({ ...f, serial: e.target.value })} className="font-mono" /></Field>
          </div>
          <Field label="installationParam (JSON)" hint="Signed exactly as written; installCertificationTime is set to now">
            <Textarea rows={12} value={f.ip} onChange={(e) => setF({ ...f, ip: e.target.value })} />
          </Field>
          {err && <p className="text-xs text-bad-ink">{err}</p>}
          <Button type="submit" variant="primary" icon={FileSignature} loading={busy === 'sign'}>Sign</Button>
        </form>
      </Module>

      <Module
        title="Result"
        actions={out ? <CopyButton text={JSON.stringify(out.cpiSignatureData, null, 2)} label="Copy cpiSignatureData" size="md" /> : null}
      >
        {!out ? (
          <Empty icon={FileSignature} title="Nothing signed yet">
            Put the result in the registration request as <span className="font-mono text-xs">cpiSignatureData</span> and leave out the plaintext
            <span className="font-mono text-xs"> installationParam</span>: under the strict policy, sending both gets responseCode 103.
          </Empty>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="silk mb-1.5">cpiSignatureData</div>
              <JsonView value={out.cpiSignatureData} maxHeight={220} />
            </div>
            <div>
              <div className="silk mb-1.5">Signed payload (decoded)</div>
              <JsonView value={out.signedData} maxHeight={240} />
            </div>
            <div>
              <div className="mb-1.5 flex items-center">
                <span className="silk mr-auto">Example registration request</span>
                <CopyButton text={JSON.stringify(snippet, null, 2)} label="Copy request" />
              </div>
              <JsonView value={snippet} maxHeight={260} />
              <p className="mt-1.5 text-xs text-ink-3">Replace userId, category and air interface with the radio's values. The SAS must know this CPI (CPI users tab) to verify the signature.</p>
            </div>
          </div>
        )}
      </Module>
    </div>
  );
}
