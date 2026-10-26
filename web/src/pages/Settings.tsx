import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Plus, RefreshCw, RotateCcw, Save, Trash2, Upload, X } from 'lucide-react';
import { api, download } from '../lib/api';
import { useResource } from '../lib/live';
import { useStatus } from '../lib/status';
import { clock, mhz } from '../lib/format';
import type { Preset } from '../lib/types';
import { Choice, Grid, Mhz, Num, Text, Toggle, type FProps, type S } from './settings/fields';
import { MapSettings } from './settings/MapSettings';
import { Button, Field, Input, Module, Note, PageHeader, Select, Switch, Tag, cx, useAction, useConfirm, useToast } from '../components/ui';

interface SettingsResp { settings: S; defaults: S; presets: Record<string, Preset>; profile: string | null }

const SECTIONS = [
  ['profiles', 'Profiles'],
  ['listeners', 'Listeners & TLS'],
  ['protocol', 'Protocol'],
  ['registration', 'Registration policy'],
  ['spectrum', 'Spectrum policy'],
  ['harness', 'Test harness'],
  ['map', 'Map'],
  ['ui', 'UI & logs'],
  ['maintenance', 'Maintenance'],
] as const;

const LISTENER_KEYS = ['sasHttpEnabled', 'sasHttpPort', 'sasHttpsEnabled', 'sasHttpsPort', 'tlsClientAuth', 'tlsMinVersion', 'tlsMaxVersion', 'tlsCipherPolicy', 'tlsCheckCrl'];

export function SettingsPage() {
  const r = useResource<SettingsResp>('/api/settings', ['settings']);
  const { run, busy } = useAction();
  const toast = useToast();
  const [draft, setDraft] = useState<S>({});
  const server = r.data?.settings;
  const cur: S = useMemo(() => ({ ...(server ?? {}), ...draft }), [server, draft]);
  const dirty = useMemo(() => Object.keys(draft).filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(server?.[k])), [draft, server]);
  const set = (k: string, v: any) => setDraft((d) => ({ ...d, [k]: v }));

  // Deep links such as /settings#map: sections exist only once the settings have loaded.
  const loaded = !!r.data;
  useEffect(() => {
    if (loaded && window.location.hash) document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
  }, [loaded]);

  const save = () => run('save', async () => {
    const patch: S = {};
    for (const k of dirty) patch[k] = draft[k];
    const res = await api.put<{ changed: string[] }>('/api/settings', patch);
    setDraft({});
    await r.reload();
    const restart = res.changed.some((k) => LISTENER_KEYS.includes(k));
    toast.ok(res.changed.length ? `Saved ${res.changed.length} setting${res.changed.length > 1 ? 's' : ''}${restart ? '; SAS listeners restarted' : ''}` : 'No changes');
  });

  if (!r.data || !server) return <div><PageHeader title="Settings" /><Module><div className="skeleton h-40" /></Module></div>;

  const field = { cur, set, defaults: r.data.defaults, draft };

  return (
    <div className="pb-20">
      <PageHeader title="Settings" sub="Changes apply live. Listener and TLS settings restart the SAS listeners (open connections drop); everything else takes effect on the next request." />
      <div className="grid gap-6 lg:grid-cols-[180px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="hidden lg:block">
          <ul className="sticky top-0 space-y-0.5">
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} className="block rounded px-2.5 py-1.5 text-base text-ink-2 hover:bg-panel-3 hover:text-ink">{label}</a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 space-y-4">
          <Profiles data={r.data} onApplied={() => { setDraft({}); void r.reload(); }} />

          <Module id="listeners" title="Listeners & TLS">
            <Grid>
              <Toggle {...field} k="sasHttpsEnabled" label="HTTPS listener" desc="TLS endpoint for real radios (WINNF-TS-0065)." />
              <Num {...field} k="sasHttpsPort" label="HTTPS port" min={1} max={65535} />
              <Toggle {...field} k="sasHttpEnabled" label="HTTP listener" desc="Plain HTTP for simulators and radios in test mode." />
              <Num {...field} k="sasHttpPort" label="HTTP port" min={1} max={65535} />
              <Choice {...field} k="tlsClientAuth" label="Client certificates" options={[['require', 'Require (mutual TLS, WInnForum)'], ['optional', 'Request, but optional'], ['none', 'Do not request']]} hint="Require rejects the TLS handshake without a certificate from a trusted CA." />
              <Toggle {...field} k="rejectUnverifiedClientCert" label="Reject unverified client certificates" desc="With optional client auth: HTTP 403 when a presented certificate does not chain to a trusted CA." />
              <Choice {...field} k="tlsMinVersion" label="Minimum TLS version" options={[['TLSv1.2', 'TLS 1.2'], ['TLSv1.3', 'TLS 1.3']]} />
              <Choice {...field} k="tlsMaxVersion" label="Maximum TLS version" options={[['TLSv1.2', 'TLS 1.2 (WInnForum)'], ['TLSv1.3', 'TLS 1.3']]} />
              <Choice {...field} k="tlsCipherPolicy" label="Cipher suites" options={[['winnforum', 'WInnForum list (TS-0065)'], ['extended', 'WInnForum + extra ECDHE suites'], ['nodejs-default', 'Node.js defaults']]} hint="The WInnForum list: AES128-GCM-SHA256, AES256-GCM-SHA384, ECDHE-ECDSA-AES128/256-GCM, ECDHE-RSA-AES128-GCM-SHA256." />
              <Toggle {...field} k="tlsCheckCrl" label="Check CRLs" desc="Every certificate in the client chain is checked against local revocations and imported CRLs (HTTP 403 if revoked)." />
              <Choice {...field} k="certRoleCheck" label="Certificate role check" options={[['lenient', 'Lenient: reject non-CBSD WInnForum roles'], ['strict', 'Strict: require ROLE_CBSD or ROLE_OPERATOR'], ['off', 'Off']]} hint="Failing requests get responseCode 104 CERT_ERROR on every object." />
            </Grid>
            <p className="mt-3 text-xs text-ink-3">Server certificates and trusted client CAs are chosen on the Certificates page.</p>
          </Module>

          <Module id="protocol" title="Protocol">
            <Grid>
              <Text {...field} k="supportedVersions" label="Supported versions" hint='Comma separated, e.g. v1.2. The first one is advertised in URLs.' list />
              <Toggle {...field} k="acceptVersionlessPaths" label="Accept paths without a version" desc="e.g. /registration is treated as the first supported version." />
              <Toggle {...field} k="versionErrorAsResponseCode" label="Unknown version → responseCode 100" desc="Off: HTTP 404 (what the WInnForum tests expect)." />
              <Num {...field} k="heartbeatIntervalSec" label="Heartbeat interval (s)" min={1} />
              <Num {...field} k="transmitExpireSec" label="Transmit window (s)" min={1} max={240} hint="transmitExpireTime = heartbeat time + this (WINNF-TS-0016 maximum 240 s)." />
              <Num {...field} k="grantExpireSec" label="Grant lifetime (s)" min={60} hint={`${(cur.grantExpireSec / 3600).toFixed(cur.grantExpireSec < 36000 ? 2 : 0)} h. Grants renew on heartbeat with grantRenew.`} />
              <Num {...field} k="connectivityLostSec" label="Connectivity lost after (s)" min={60} hint="Grants are terminated when no successful heartbeat arrives for this long (spec: 7 days)." />
              <Choice {...field} k="siqChannelization" label="Spectrum inquiry channels" options={[['none', 'Maximal contiguous ranges'], ['5MHz', '5 MHz channels'], ['10MHz', '10 MHz channels']]} />
              <Toggle {...field} k="siqIncludeDpa" label="Spectrum inquiry removes active DPA spectrum" desc="Off matches the WInnForum tests, which expect DPAs to be ignored in inquiry results." />
              <Toggle {...field} k="strictOperationState" label="Strict operationState" desc="502 whenever a CBSD reports AUTHORIZED for a grant the SAS holds as GRANTED." />
              <Toggle {...field} k="includeResponseMessage" label="Include responseMessage" desc="Human-readable reason next to every non-zero responseCode." />
              <Num {...field} k="responseDelayMs" label="Response delay (ms)" min={0} hint="Added to every SAS response. Useful for timeout testing." />
            </Grid>
          </Module>

          <Module id="registration" title="Registration policy">
            <Grid>
              <Choice {...field} k="registrationPolicy" label="Policy" options={[['lenient', 'Lenient: accept and log warnings'], ['strict', 'Strict: WInnForum rules']]} hint="Strict: Category B needs CPI-signed or preloaded installation data, CPI keys must verify, measCapability is required." />
              <Choice {...field} k="certIdentityCheck" label="Certificate identity check" options={[['warn', 'Warn on mismatch'], ['enforce', 'Enforce (104 on mismatch)'], ['off', 'Off']]} hint="Compares the FCC ID and serial in the client certificate with the registration request." />
              <Toggle {...field} k="requireKnownFccId" label="Require known FCC ID" desc="Unknown FCC IDs get 103. Add them on the Registry page." />
              <Toggle {...field} k="requireKnownUserId" label="Require known user ID" desc="Unknown user IDs get 103." />
              <Toggle {...field} k="manualApproval" label="Manual approval" desc="New registrations get 200 REG_PENDING until approved on the CBSD page." />
              <Num {...field} k="defaultFccMaxEirp" label="Default certified max EIRP (dBm/10MHz)" hint="Used when an FCC ID has no registered value." />
              <Toggle {...field} k="haatCheck" label="HAAT check for outdoor Category A" desc="Rejects HAAT above 6 m. Needs terrain tiles; skipped without them." />
              <Toggle {...field} k="rejectIndoorCatB" label="Reject indoor Category B" desc="FCC Part 96.45: Category B must be outdoor." />
            </Grid>
          </Module>

          <Module id="spectrum" title="Spectrum policy">
            <Grid>
              <Mhz {...field} k="bandLowHz" label="Band low (MHz)" />
              <Mhz {...field} k="bandHighHz" label="Band high (MHz)" />
              <Num {...field} k="maxEirpCatA" label="Max EIRP Category A (dBm/MHz)" step={0.1} />
              <Num {...field} k="maxEirpCatB" label="Max EIRP Category B (dBm/MHz)" step={0.1} />
              <Mhz {...field} k="maxGrantBandwidthHz" label="Max grant bandwidth (MHz)" />
              <Num {...field} k="maxGrantsPerCbsd" label="Max grants per CBSD" min={1} />
              <Mhz {...field} k="grantFrequencyStepHz" label="Grant edge step (MHz)" hint="0 = any frequency. 5 = edges must sit on a 5 MHz raster." />
              <Toggle {...field} k="suggestOperationParam" label="Suggest operation parameters" desc="Include an alternative operationParam with 400 INTERFERENCE responses." />
            </Grid>
            <GaaRanges value={cur.gaaRanges} onChange={(v) => set('gaaRanges', v)} />
          </Module>

          <Harness field={field} />

          <MapSettings field={field} />

          <Module id="ui" title="UI & logs">
            <Grid>
              <Password {...field} />
              <Num {...field} k="msgLogLimit" label="Wire log size (exchanges)" min={100} />
              <Num {...field} k="eventLogLimit" label="Event log size" min={100} />
            </Grid>
          </Module>

          <Maintenance onDone={() => { setDraft({}); void r.reload(); }} />
        </div>
      </div>

      {dirty.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-panel/95 shadow-pop backdrop-blur-[2px] md:left-14 lg:left-[216px]">
          <div className="mx-auto flex max-w-[1680px] items-center gap-3 px-4 py-2.5 lg:px-6">
            <span className="text-base"><span className="num font-semibold">{dirty.length}</span> unsaved change{dirty.length > 1 ? 's' : ''}</span>
            <span className="hidden truncate font-mono text-xs text-ink-3 md:inline">{dirty.join(', ')}</span>
            {dirty.some((k) => LISTENER_KEYS.includes(k)) && <Tag tone="warn">restarts listeners</Tag>}
            <div className="ml-auto flex gap-2">
              <Button onClick={() => setDraft({})}>Discard</Button>
              <Button variant="primary" icon={Save} loading={busy === 'save'} onClick={save}>Save changes</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Password(p: FProps) {
  const isSet = !!p.cur.uiPassword;
  const [val, setVal] = useState('');
  return (
    <Field label="UI password" hint={isSet ? 'Set. Browsers ask for it via HTTP Basic auth (any user name). Clear the field and save to remove it.' : 'Optional. Protects this UI and its API with HTTP Basic auth. The SAS ports are not affected.'}>
      <div className="flex gap-2">
        <Input
          type="password"
          autoComplete="new-password"
          value={val}
          placeholder={isSet ? '•••••••• (unchanged)' : 'No password'}
          onChange={(e) => {
            setVal(e.target.value);
            p.set('uiPassword', e.target.value || (isSet ? '********' : ''));
          }}
          className="w-56"
        />
        {isSet && <Button variant="ghost" icon={X} onClick={() => { setVal(''); p.set('uiPassword', ''); }}>Remove</Button>}
      </div>
    </Field>
  );
}

function GaaRanges({ value, onChange }: { value: Array<{ low: number; high: number }>; onChange: (v: Array<{ low: number; high: number }>) => void }) {
  const rows = value ?? [];
  const upd = (i: number, k: 'low' | 'high', v: string) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: Math.round(Number(v) * 1e6) } : r)));
  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="mb-2 flex items-center gap-3">
        <span className="text-sm font-medium text-ink-2">GAA availability blocks</span>
        <span className="text-xs text-ink-3">Spectrum outside these is never offered or granted as GAA.</span>
        <Button size="sm" icon={Plus} className="ml-auto" onClick={() => onChange([...rows, { low: 3550e6, high: 3700e6 }])}>Add block</Button>
      </div>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input type="number" step="0.1" aria-label="Low MHz" value={mhz(r.low)} onChange={(e) => upd(i, 'low', e.target.value)} className="w-32" />
            <span className="text-ink-3">–</span>
            <Input type="number" step="0.1" aria-label="High MHz" value={mhz(r.high)} onChange={(e) => upd(i, 'high', e.target.value)} className="w-32" />
            <span className="text-sm text-ink-3">MHz</span>
            {!(r.low < r.high) && <span className="text-xs text-bad-ink">low must be below high</span>}
            <Button size="sm" variant="ghost" icon={Trash2} aria-label="Remove block" onClick={() => onChange(rows.filter((_, j) => j !== i))} />
          </div>
        ))}
        {rows.length === 0 && <Note tone="warn">No GAA blocks: only PAL spectrum can be granted.</Note>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- sections

function Profiles({ data, onApplied }: { data: SettingsResp; onApplied: () => void }) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const diff = (p: Preset) => Object.entries(p.patch).filter(([k, v]) => JSON.stringify(data.settings[k]) !== JSON.stringify(v)).map(([k]) => k);
  return (
    <Module id="profiles" title="Profiles" meta={data.profile ? `Active: ${data.presets[data.profile]?.label}` : 'Active: custom (matches no profile)'} bodyClass="">
      <ul className="divide-y divide-line">
        {Object.entries(data.presets).map(([key, p]) => {
          const d = diff(p);
          const active = data.profile === key;
          return (
            <li key={key} className={cx('flex flex-wrap items-start gap-x-6 gap-y-2 px-3 py-3', active && 'bg-sel-soft/60')}>
              <div className="min-w-0 flex-1 basis-[420px]">
                <div className="flex items-center gap-2">
                  <span className="text-md font-semibold">{p.label}</span>
                  {active && <Tag tone="sel">ACTIVE</Tag>}
                </div>
                <p className="mt-0.5 max-w-[90ch] text-sm text-ink-2">{p.description}</p>
                {!active && d.length > 0 && <p className="mt-1 font-mono text-2xs text-ink-3">Changes {d.length}: {d.join(', ')}</p>}
              </div>
              <Button
                variant={active ? 'secondary' : 'primary'}
                disabled={active}
                loading={busy === key}
                onClick={async () => {
                  if (await confirm({ title: `Apply "${p.label}"?`, body: `Changes ${d.length} setting${d.length === 1 ? '' : 's'}. Listener settings among them restart the SAS listeners.`, confirm: 'Apply profile' })) {
                    await run(key, () => api.post(`/api/settings/preset/${key}`), `Profile "${p.label}" applied`);
                    onApplied();
                  }
                }}
              >
                {active ? 'Applied' : 'Apply'}
              </Button>
            </li>
          );
        })}
      </ul>
    </Module>
  );
}

function Harness({ field }: { field: FProps }) {
  const { data: s, reload } = useStatus();
  const { run, busy } = useAction();
  const hosts = useMemo(() => [...new Set((s?.urls ?? []).map((u) => new URL(u).hostname))], [s?.urls]);
  const [host, setHost] = useState('');
  const daily = s?.daily;
  return (
    <Module id="harness" title="Test harness">
      <Grid>
        <Toggle {...field} k="harnessAdminEnabled" label="Harness admin API" desc="POST <SAS URL>/admin/... on the SAS ports (reset, injectdata, trigger). Turn off outside harness runs." />
        <div>
          <span className="mb-1 block text-sm font-medium text-ink-2">Measurement report triggers</span>
          <div className="space-y-2">
            <Switch
              checked={!!s?.triggers.measInRegistration}
              onChange={(v) => run('t1', async () => { await api.post('/api/triggers', { measInRegistration: v }); await reload(); })}
              label="Request reports in registration"
              description="RECEIVED_POWER_WITHOUT_GRANT until a full-band report arrives."
            />
            <Switch
              checked={!!s?.triggers.measInHeartbeat}
              onChange={(v) => run('t2', async () => { await api.post('/api/triggers', { measInHeartbeat: v }); await reload(); })}
              label="Request reports in heartbeat"
              description="RECEIVED_POWER_WITH_GRANT for capable CBSDs."
            />
          </div>
        </div>
        <div>
          <span className="mb-1 block text-sm font-medium text-ink-2">Daily activities (CPAS)</span>
          <p className="mb-2 text-xs text-ink-3">
            {daily?.running ? 'Running now…' : daily?.lastCompleted ? `Last completed ${clock(daily.lastCompleted, true)}.` : 'Not run since start.'} Pulls peer SAS FAD dumps, rebuilds protections and PPAs, purges grants that now conflict.
          </p>
          <Button icon={RefreshCw} loading={busy === 'daily' || daily?.running} onClick={() => run('daily', () => api.post('/api/daily-activities'), 'Daily activities completed')}>Run daily activities now</Button>
          {Array.isArray(daily?.log) && daily.log.length > 0 && (
            <pre className="json mt-2 max-h-40 overflow-auto rounded border border-line bg-panel-2 p-2">{daily.log.join('\n')}</pre>
          )}
        </div>
        <div>
          <span className="mb-1 block text-sm font-medium text-ink-2">Harness sas.cfg</span>
          <p className="mb-2 text-xs text-ink-3">Base URLs for the WInnForum harness config, using the HTTPS port and this host name.</p>
          <div className="flex gap-2">
            <Select value={host} onChange={(e) => setHost(e.target.value)} className="w-56">
              <option value="">{hosts[0] ?? 'localhost'}</option>
              {hosts.slice(1).map((h) => <option key={h} value={h}>{h}</option>)}
            </Select>
            <Button icon={Download} onClick={() => download(`/api/harness/sas.cfg${host ? `?host=${encodeURIComponent(host)}` : ''}`)}>sas.cfg</Button>
          </div>
        </div>
      </Grid>
    </Module>
  );
}

function Maintenance({ onDone }: { onDone: () => void }) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);
  const [clearLogs, setClearLogs] = useState(false);
  return (
    <Module id="maintenance" title="Maintenance">
      <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
        <div>
          <span className="mb-1 block text-sm font-medium text-ink-2">Configuration backup</span>
          <p className="mb-2 text-xs text-ink-3">Settings, FCC/user IDs, blacklist, preloads, CPI users, your protections and PPAs, fault rules. Certificates are not included.</p>
          <div className="flex flex-wrap gap-2">
            <Button icon={Download} onClick={() => download('/api/export')}>Export JSON</Button>
            <Button icon={Upload} loading={busy === 'import'} onClick={() => fileRef.current?.click()}>Import JSON</Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                if (!(await confirm({ title: `Import ${f.name}?`, body: 'Settings and records in the file overwrite current ones with the same keys.', confirm: 'Import' }))) return;
                await run('import', async () => api.post('/api/import', JSON.parse(await f.text())), 'Configuration imported');
                onDone();
              }}
            />
          </div>
        </div>
        <div>
          <span className="mb-1 block text-sm font-medium text-ink-2">Listeners</span>
          <p className="mb-2 text-xs text-ink-3">Re-bind the HTTP and HTTPS ports and reload TLS material.</p>
          <Button icon={RefreshCw} loading={busy === 'restart'} onClick={() => run('restart', () => api.post('/api/listeners/restart'), 'Listeners restarted')}>Restart listeners</Button>
        </div>
        <div>
          <span className="mb-1 block text-sm font-medium text-ink-2">Restore default settings</span>
          <p className="mb-2 text-xs text-ink-3">Keeps ports, server certificates, trusted CAs and the UI password.</p>
          <Button icon={RotateCcw} loading={busy === 'defaults'} onClick={async () => {
            if (await confirm({ title: 'Restore default settings?', body: 'All other settings return to their defaults.', confirm: 'Restore defaults', danger: true })) {
              await run('defaults', () => api.post('/api/settings/defaults'), 'Defaults restored');
              onDone();
            }
          }}>Restore defaults</Button>
        </div>
        <div>
          <span className="mb-1 block text-sm font-medium text-bad-ink">Reset SAS state</span>
          <p className="mb-2 text-xs text-ink-3">Deletes every CBSD, grant, FCC/user ID, blacklist entry, preload, CPI user, PPA and protection, like the harness <span className="font-mono">/admin/reset</span>. Certificates and settings stay.</p>
          <label className="mb-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={clearLogs} onChange={(e) => setClearLogs(e.target.checked)} className="accent-[rgb(var(--bad))]" />
            Also clear the wire log and events
          </label>
          <Button variant="danger" icon={Trash2} loading={busy === 'reset'} onClick={async () => {
            if (await confirm({ title: 'Reset all SAS state?', body: 'Radios will have to register again. This cannot be undone.', confirm: 'Reset SAS', danger: true, typeToConfirm: 'RESET' })) {
              await run('reset', () => api.post('/api/reset', { confirm: 'RESET', logs: clearLogs }), 'SAS state reset');
              onDone();
            }
          }}>Reset SAS state</Button>
        </div>
      </div>
      <p className="mt-5 border-t border-line pt-3 text-xs text-ink-3">
        This software includes open-source components and public-domain map data:{' '}
        <a className="text-sel-ink underline" href="/third-party-notices.txt" target="_blank" rel="noreferrer">third-party notices</a>.
      </p>
    </Module>
  );
}
