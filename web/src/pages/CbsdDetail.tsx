import { useEffect, useState } from 'react';
import { ArrowLeft, Check, Crosshair, Save, Send, Trash2, Unplug } from 'lucide-react';
import { api } from '../lib/api';
import { useNow, useResource } from '../lib/live';
import { useChangeMarks, useFollow } from '../lib/follow';
import { Link, navigate } from '../lib/router';
import { ago, clock, iso, range } from '../lib/format';
import type { Cbsd, EventRow, Grant } from '../lib/types';
import { GrantTable } from '../components/grants';
import { MessageDrawer, transportTag } from '../components/message';
import { Swatch, TxIndicator, groupGrants, useHeartbeatPulses } from '../components/rack';
import {
  Button, CodeTag, CopyButton, Empty, ErrorNote, Field, HttpTag, Input, JsonView, Led, Module, Readout, SkeletonRows, Tabs, Tag, Textarea,
  cx, useAction, useConfirm,
} from '../components/ui';
import { parseCodes } from '../lib/format';

interface Detail extends Cbsd {
  grants: any;
  events: EventRow[];
  messages: Array<{ id: number; ts: number; transport: string; method: string; http_status: number; codes: string | null; error: string | null }>;
  conditional: any;
  limits: { maxEirpPer10MHz: number; maxEirpDbmMhz: number };
  availability: Array<{ low: number; high: number; [k: string]: any }> | any;
  protections: Array<{ id: string; name: string; kind: string }>;
}

const MEAS = ['RECEIVED_POWER_WITHOUT_GRANT', 'RECEIVED_POWER_WITH_GRANT'];

export function CbsdDetailPage({ id }: { id: string }) {
  const r = useResource<Detail>(`/api/cbsds/${encodeURIComponent(id)}`, ['cbsds', 'grants', 'spectrum']);
  const { followed, setFollowed } = useFollow();
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const pulses = useHeartbeatPulses();
  const now = useNow();
  const [tab, setTab] = useState<'grants' | 'messages' | 'events' | 'raw'>('grants');
  const [openMsg, setOpenMsg] = useState<number | null>(null);
  const d = r.data;
  const grants: Grant[] = Array.isArray(d?.grants) ? d!.grants : [];
  const { marks, ack } = useChangeMarks(d ? grants : undefined, (g) => g.grantId, (g) => `${g.state}${g.suspended ? 'S' : ''}`);

  if (r.error) {
    return (
      <div className="space-y-3">
        <BackLink />
        <ErrorNote>{r.error === 'CBSD not found' ? `No CBSD with id ${id}. It may have been deleted or the SAS was reset.` : r.error}</ErrorNote>
      </div>
    );
  }
  if (!d) return <div><BackLink /><Module><SkeletonRows rows={8} cols={4} /></Module></div>;

  const isF = followed === d.cbsdId;
  const p = pulses[d.cbsdId];
  const ip = d.effective?.installationParam ?? {};
  const active = groupGrants(grants).get(d.cbsdId) ?? [];
  const enc = encodeURIComponent(d.cbsdId);

  return (
    <div className="space-y-4">
      <BackLink />
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <Swatch cbsdId={d.cbsdId} className="size-3" />
            <h1 className="truncate font-mono text-lg font-semibold">{d.fccId}<span className="text-ink-3"> / </span>{d.serial}</h1>
            <Tag tone={d.state === 'REGISTERED' ? 'ok' : d.state === 'PENDING' ? 'warn' : 'off'}>{d.state}</Tag>
            {d.category && <Tag>CAT {d.category}</Tag>}
            {d.pendingDeregister && <Tag tone="warn">DEREGISTER (105) PENDING</Tag>}
          </div>
          <div className="mt-1 flex items-center gap-1 font-mono text-xs text-ink-3">
            cbsdId {d.cbsdId}
            <CopyButton text={d.cbsdId} label="Copy cbsdId" />
          </div>
        </div>
        <div className="flex items-center gap-4 rounded border border-line bg-panel px-3 py-2">
          <span className="flex items-center gap-1.5 text-xs text-ink-3"><Led c={d.state === 'REGISTERED' ? 'ok' : d.state === 'PENDING' ? 'warn' : 'off'} /> REG</span>
          <span className="flex items-center gap-1.5 text-xs text-ink-3"><Led c={active.some((g) => g.state === 'AUTHORIZED' && !g.suspended) ? 'ok' : active.some((g) => g.suspended) ? 'warn' : active.length ? 'info' : 'off'} /> GNT</span>
          <span className="flex items-center gap-1.5 text-xs text-ink-3"><Led c={p ? (p.code === 0 ? 'ok' : 'bad') : d.lastHeartbeatOk ? 'ok' : 'off'} flash={p?.n} /> HB</span>
          <span className="flex items-center gap-1.5 text-xs text-ink-3">TX <TxIndicator grants={active} now={now} /></span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button icon={Crosshair} variant={isF ? 'primary' : 'secondary'} onClick={() => setFollowed(isF ? null : d.cbsdId)}>{isF ? 'Following' : 'Follow'}</Button>
          {d.state === 'PENDING' && (
            <Button icon={Check} variant="primary" loading={busy === 'approve'} onClick={() => run('approve', () => api.post(`/api/cbsds/${enc}/approve`), 'Approved: registration completes on the next request')}>Approve registration</Button>
          )}
          {d.state === 'REGISTERED' && !d.pendingDeregister && (
            <Button icon={Send} loading={busy === 'dereg'} onClick={async () => {
              if (await confirm({ title: 'Send DEREGISTER (105)?', body: 'The CBSD gets responseCode 105 on its next request of any kind, which tells it to deregister and re-register.', confirm: 'Queue 105' })) {
                await run('dereg', () => api.post(`/api/cbsds/${enc}/deregister`), '105 DEREGISTER queued for the next request');
              }
            }}>Send 105</Button>
          )}
          {d.state === 'REGISTERED' && (
            <Button icon={Unplug} variant="danger-ghost" loading={busy === 'force'} onClick={async () => {
              if (await confirm({ title: 'Deregister this CBSD now?', body: 'The SAS deregisters it silently and deletes its grants. Its next heartbeat gets 103; the radio has to register again.', confirm: 'Deregister now', danger: true })) {
                await run('force', () => api.post(`/api/cbsds/${enc}/force-deregister`), 'CBSD deregistered');
              }
            }}>Deregister now</Button>
          )}
          <Button icon={Trash2} variant="danger-ghost" onClick={async () => {
            if (await confirm({ title: 'Delete this CBSD record?', body: 'Removes the CBSD and all its grants from the database, as if it had never registered.', confirm: 'Delete', danger: true })) {
              const ok = await run('delete', () => api.del(`/api/cbsds/${enc}`), 'CBSD deleted');
              if (ok !== undefined) navigate('/cbsds');
            }
          }} aria-label="Delete CBSD" title="Delete record" />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        <Module title="Registration" meta={d.registeredAt ? `registered ${clock(d.registeredAt, true)}` : 'never registered successfully'}>
          <Readout
            cols={3}
            rows={[
              ['User ID', <span className="font-mono text-sm">{d.userId ?? '—'}</span>],
              ['Category', d.category ? `Category ${d.category}` : '—'],
              ['Air interface', d.radioTechnology ?? '—'],
              ['Call sign', d.callSign || '—'],
              ['Latitude, longitude', ip.latitude != null ? <span className="num font-mono text-sm">{ip.latitude}, {ip.longitude}</span> : '—'],
              ['Height', ip.height != null ? `${ip.height} m ${ip.heightType ?? ''}` : '—'],
              ['Deployment', ip.indoorDeployment === true ? 'Indoor' : ip.indoorDeployment === false ? 'Outdoor' : '—'],
              ['Antenna', ip.antennaGain != null ? `${ip.antennaGain} dBi · az ${ip.antennaAzimuth ?? '—'}° · tilt ${ip.antennaDowntilt ?? '—'}° · bw ${ip.antennaBeamwidth ?? '—'}°` : '—'],
              ['EIRP capability', ip.eirpCapability != null ? `${ip.eirpCapability} dBm/10MHz` : '—'],
              ['Measurement capability', d.measCapability?.length ? d.measCapability.join(', ') : 'none'],
              ['EIRP limit', <span className="num">{d.limits.maxEirpDbmMhz} dBm/MHz <span className="text-ink-3">({d.limits.maxEirpPer10MHz} dBm/10MHz)</span></span>],
              ['Preloaded data', d.conditional ? 'Yes (conditional registration)' : 'No'],
              ['Last link', <span className="flex items-center gap-2">{transportTag(d.transport)}<span className="font-mono text-xs">{d.remoteAddr ?? ''}</span></span>],
              ['Last seen', d.lastSeen ? `${ago(d.lastSeen, now)}` : 'never'],
              ['Last good heartbeat', d.lastHeartbeatOk ? ago(d.lastHeartbeatOk, now) : 'never'],
            ]}
          />
          {d.certInfo ? (
            <div className="mt-4 border-t border-line pt-3">
              <div className="silk mb-1.5">Client certificate at registration</div>
              <Readout
                cols={3}
                rows={[
                  ['Subject', <span className="break-all font-mono text-xs">{d.certInfo.subject}</span>],
                  ['Issuer', <span className="break-all font-mono text-xs">{d.certInfo.issuer}</span>],
                  ['WInnForum roles', d.certInfo.roles?.length ? d.certInfo.roles.join(', ') : 'none'],
                  d.certInfo.fccId ? ['FCC ID in cert', <span className="font-mono text-xs">{d.certInfo.fccId}</span>] : null,
                  d.certInfo.cbsdSerial ? ['Serial in cert', <span className="font-mono text-xs">{d.certInfo.cbsdSerial}</span>] : null,
                ]}
              />
            </div>
          ) : (
            <p className="mt-4 border-t border-line pt-3 text-sm text-ink-3">Registered without a client certificate (HTTP, console, or TLS without client auth).</p>
          )}
        </Module>

        <div className="space-y-4">
          <Module title="Spectrum this CBSD may use">
            <Availability d={d} />
          </Module>
          <Overrides d={d} />
        </div>
      </div>

      <div>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'grants', label: 'Grants', count: grants.length },
            { value: 'messages', label: 'Exchanges', count: d.messages.length },
            { value: 'events', label: 'Events', count: d.events.length },
            { value: 'raw', label: 'Raw registration' },
          ]}
        />
        <Module className="rounded-t-none border-t-0" bodyClass="">
          {tab === 'grants' && (grants.length ? <GrantTable grants={grants} showCbsd={false} marks={marks} onAck={ack} /> : (
            <Empty title="No grants">The CBSD has not requested a grant yet, or its grants were deleted by re-registration.</Empty>
          ))}
          {tab === 'messages' && (d.messages.length ? (
            <div className="max-h-[520px] overflow-y-auto">
              <table className="dtable">
                <thead><tr><th>Time</th><th>Transport</th><th>Method</th><th>HTTP</th><th>Response codes</th><th>Error</th></tr></thead>
                <tbody>
                  {d.messages.map((m) => (
                    <tr key={m.id} className="cursor-pointer" onClick={() => setOpenMsg(m.id)}>
                      <td className="num whitespace-nowrap font-mono text-xs" title={iso(m.ts)}>{clock(m.ts, true)}</td>
                      <td>{transportTag(m.transport)}</td>
                      <td className="font-mono text-xs">{m.method}</td>
                      <td><HttpTag status={m.http_status} /></td>
                      <td><span className="flex flex-wrap gap-1">{parseCodes(m.codes).map((c, i) => <CodeTag key={i} code={c} />)}</span></td>
                      <td className="max-w-[300px] truncate text-xs text-bad-ink">{m.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty title="No exchanges logged" />)}
          {tab === 'events' && (d.events.length ? (
            <ul className="max-h-[520px] divide-y divide-line overflow-y-auto">
              {d.events.map((e) => (
                <li key={e.id} className="flex items-start gap-3 px-3 py-2 text-sm">
                  <Led c={e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warn' : e.level === 'success' ? 'ok' : 'info'} className="mt-1.5" />
                  <span className="num w-[150px] flex-none font-mono text-xs text-ink-3">{clock(e.ts, true)}</span>
                  <span className="w-[80px] flex-none font-label text-xs font-semibold uppercase tracking-[0.06em] text-ink-3">{e.category}</span>
                  <span className="min-w-0 flex-1 break-words">{e.message}</span>
                </li>
              ))}
            </ul>
          ) : <Empty title="No events" />)}
          {tab === 'raw' && (
            <div className="grid gap-4 p-3 xl:grid-cols-2">
              <div className="min-w-0">
                <div className="silk mb-1.5">Last registration request</div>
                <JsonView value={d.registration} maxHeight={520} />
              </div>
              <div className="min-w-0">
                <div className="silk mb-1.5">Effective parameters (preload ← request ← CPI)</div>
                <JsonView value={d.effective} maxHeight={520} />
              </div>
              {d.lastMeasReport && (
                <div className="min-w-0 xl:col-span-2">
                  <div className="silk mb-1.5">Last measurement report</div>
                  <JsonView value={d.lastMeasReport} maxHeight={400} />
                </div>
              )}
            </div>
          )}
        </Module>
      </div>
      <MessageDrawer id={openMsg} onClose={() => setOpenMsg(null)} />
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/cbsds" className="mb-1 inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink">
      <ArrowLeft className="size-3.5" /> CBSDs
    </Link>
  );
}

function Availability({ d }: { d: Detail }) {
  const av: any[] = Array.isArray(d.availability) ? d.availability : Array.isArray(d.availability?.ranges) ? d.availability.ranges : [];
  return (
    <div className="space-y-3">
      {av.length ? (
        <ul className="space-y-1">
          {av.map((a, i) => (
            <li key={i} className="flex items-baseline justify-between gap-2 text-sm">
              <span className="num font-mono text-xs">{range(a.low, a.high)} MHz</span>
              <span className="text-xs text-ink-3">{a.channelType ?? a.type ?? ''}{a.maxEirp != null ? ` · ${a.maxEirp} dBm/MHz` : ''}{a.reason ? ` · ${a.reason}` : ''}</span>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-ink-3">{d.state === 'REGISTERED' ? 'No spectrum available at this location.' : 'Available once registered.'}</p>}
      {d.protections.length > 0 && (
        <div className="border-t border-line pt-2">
          <div className="silk mb-1">Protections affecting it</div>
          <div className="flex flex-wrap gap-1">
            {d.protections.map((p) => <Tag key={p.id} tone="warn" title={p.id}>{p.kind} · {p.name}</Tag>)}
          </div>
        </div>
      )}
    </div>
  );
}

function Overrides({ d }: { d: Detail }) {
  const { run, busy } = useAction();
  const [cap, setCap] = useState(d.eirpCapDbmMhz === null ? '' : String(d.eirpCapDbmMhz));
  const [reg, setReg] = useState<string[]>(d.regMeasConfig ?? []);
  const [hb, setHb] = useState<string[]>(d.hbMeasConfig ?? []);
  const [notes, setNotes] = useState(d.notes ?? '');
  useEffect(() => {
    setCap(d.eirpCapDbmMhz === null ? '' : String(d.eirpCapDbmMhz));
    setReg(d.regMeasConfig ?? []);
    setHb(d.hbMeasConfig ?? []);
    setNotes(d.notes ?? '');
  }, [d.cbsdId, d.eirpCapDbmMhz, JSON.stringify(d.regMeasConfig), JSON.stringify(d.hbMeasConfig), d.notes]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const save = () => run('ov', () => api.patch(`/api/cbsds/${encodeURIComponent(d.cbsdId)}`, { eirpCapDbmMhz: cap === '' ? null : Number(cap), regMeasConfig: reg, hbMeasConfig: hb, notes }), 'Overrides saved');
  return (
    <Module title="Operator overrides">
      <div className="space-y-4">
        <Field label="EIRP cap (dBm/MHz)" hint={`Lowers this CBSD's EIRP limit: grant requests above it get 400 INTERFERENCE. Effective limit now ${d.limits.maxEirpDbmMhz} dBm/MHz. Blank = no cap.`}>
          <Input type="number" step="0.1" value={cap} onChange={(e) => setCap(e.target.value)} className="w-32" placeholder="none" />
        </Field>
        <MeasPick label="measReportConfig in registration response" hint="Requested on the next successful registration." value={reg} caps={d.measCapability} onToggle={(v) => toggle(reg, setReg, v)} />
        <MeasPick label="measReportConfig in next heartbeat response" hint="Sent once with the next successful heartbeat." value={hb} caps={d.measCapability} onToggle={(v) => toggle(hb, setHb, v)} />
        <Field label="Notes">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className="font-sans text-base" placeholder="Bench position, firmware build…" />
        </Field>
        <div className="flex justify-end"><Button variant="primary" icon={Save} loading={busy === 'ov'} onClick={save}>Save overrides</Button></div>
      </div>
    </Module>
  );
}

function MeasPick({ label, hint, value, caps, onToggle }: { label: string; hint: string; value: string[]; caps: string[]; onToggle: (v: string) => void }) {
  return (
    <fieldset>
      <legend className="mb-1 text-sm font-medium text-ink-2">{label}</legend>
      <div className="space-y-1">
        {MEAS.map((m) => (
          <label key={m} className={cx('flex cursor-pointer items-center gap-2 text-sm', !caps.includes(m) && 'text-ink-3')}>
            <input type="checkbox" checked={value.includes(m)} onChange={() => onToggle(m)} className="accent-[rgb(var(--sel))]" />
            <span className="font-mono text-xs">{m}</span>
            {!caps.includes(m) && <span className="text-2xs">(not in measCapability, filtered out)</span>}
          </label>
        ))}
      </div>
      <p className="mt-1 text-xs text-ink-3">{hint}</p>
    </fieldset>
  );
}

