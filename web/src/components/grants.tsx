import { useState } from 'react';
import { Ban, Pause, Pencil, Play } from 'lucide-react';
import { api } from '../lib/api';
import { useNow } from '../lib/live';
import { useFollow } from '../lib/follow';
import { ago, clock, iso, mhz, range, until } from '../lib/format';
import type { Grant } from '../lib/types';
import { CbsdName } from './rack';
import { Button, Drawer, Field, GrantStateTag, Input, Readout, cx, useAction, useConfirm } from './ui';

// Grant table with operator actions (suspend / resume / terminate / edit), shared by the
// Grants page and the CBSD detail page.

const ACTIVE = (g: Grant) => g.state === 'GRANTED' || g.state === 'AUTHORIZED';

export function GrantTable({ grants, showCbsd = true, marks, onAck }: {
  grants: Grant[]; showCbsd?: boolean; marks?: Record<string, string>; onAck?: (id: string) => void;
}) {
  const now = useNow();
  const { followed } = useFollow();
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [edit, setEdit] = useState<Grant | null>(null);

  const suspend = (g: Grant, v: boolean) => run(`s:${g.grantId}`, () => api.post(`/api/grants/${encodeURIComponent(g.grantId)}/suspend`, { suspended: v }),
    v ? 'Grant suspended: the next heartbeat gets 501 SUSPENDED_GRANT' : 'Grant resumed: the next heartbeat gets 0');
  const terminate = async (g: Grant) => {
    const ok = await confirm({
      title: 'Terminate this grant?',
      body: <>The grant ends now. The CBSD receives <span className="font-mono">500 TERMINATED_GRANT</span> on its next heartbeat and must stop transmitting on {range(g.low, g.high)} MHz.</>,
      confirm: 'Terminate grant',
      danger: true,
    });
    if (ok) await run(`t:${g.grantId}`, () => api.post(`/api/grants/${encodeURIComponent(g.grantId)}/terminate`, { reason: 'terminated by administrator' }), 'Grant terminated');
  };

  const actions = (g: Grant, labelled?: boolean) => (
    <div className={cx('flex gap-0.5', labelled ? 'flex-wrap gap-1.5' : 'justify-end')}>
      <Button size="sm" variant={labelled ? 'secondary' : 'ghost'} icon={g.suspended ? Play : Pause} loading={busy === `s:${g.grantId}`} onClick={() => suspend(g, !g.suspended)} title={g.suspended ? 'Resume (heartbeat → 0)' : 'Suspend (heartbeat → 501)'} aria-label={labelled ? undefined : g.suspended ? 'Resume grant' : 'Suspend grant'}>
        {labelled ? (g.suspended ? 'Resume' : 'Suspend') : null}
      </Button>
      <Button size="sm" variant={labelled ? 'secondary' : 'ghost'} icon={Pencil} onClick={() => setEdit(g)} title="Edit heartbeat interval, expiry, suggestion" aria-label={labelled ? undefined : 'Edit grant'}>
        {labelled ? 'Edit' : null}
      </Button>
      <Button size="sm" variant="danger-ghost" icon={Ban} loading={busy === `t:${g.grantId}`} onClick={() => terminate(g)} title="Terminate (heartbeat → 500)" aria-label={labelled ? undefined : 'Terminate grant'}>
        {labelled ? 'Terminate' : null}
      </Button>
    </div>
  );
  // The actions column stays pinned to the right edge while the table scrolls sideways.
  const pin = 'sticky right-0 bg-panel shadow-[-1px_0_0_rgb(var(--line))] [tr:hover>&]:bg-panel-3 [tr[aria-selected=true]>&]:bg-sel-soft';

  return (
    <>
      {/* Phones: one stacked card per grant with labelled actions. */}
      <ul className="divide-y divide-line md:hidden">
        {grants.map((g) => {
          const active = ACTIVE(g);
          const mark = marks?.[g.grantId];
          return (
            <li key={g.grantId} aria-selected={followed === g.cbsdId} className={cx('space-y-1.5 px-3 py-2.5', followed === g.cbsdId && 'bg-sel-soft')} onTouchStart={() => mark && onAck?.(g.grantId)}>
              <div className="flex items-center gap-2">
                {showCbsd ? <CbsdName cbsdId={g.cbsdId} fccId={g.fccId ?? undefined} serial={g.serial ?? undefined} /> : <span className="truncate font-mono text-xs text-ink-2">{g.grantId}</span>}
                <span className="ml-auto flex flex-none items-center gap-1.5">
                  {mark && <span className="changed-mark" title={`Changed: ${mark}`} />}
                  <GrantStateTag state={g.state} suspended={g.suspended} />
                </span>
              </div>
              <div className="num flex flex-wrap gap-x-3 font-mono text-xs text-ink">
                <span>{range(g.low, g.high)} MHz</span>
                <span>{g.maxEirp} <span className="text-ink-3">dBm/MHz</span></span>
                <span className="text-ink-3">{g.channelType}</span>
                {active && g.transmitExpireTime ? <span className="text-ink-2">TX {until(g.transmitExpireTime, now)}</span> : null}
              </div>
              {!active && g.endReason && <p className="text-xs text-ink-3">{g.endReason}</p>}
              {active && actions(g, true)}
            </li>
          );
        })}
      </ul>

      <div className="hidden overflow-x-auto md:block">
        <table className="dtable">
          <thead>
            <tr>
              <th className="w-[1%]" aria-label="Changed" />
              {showCbsd && <th>CBSD</th>}
              <th>Grant ID</th>
              <th>State</th>
              <th className="text-right">Channel (MHz)</th>
              <th className="text-right">Max EIRP</th>
              <th className="text-right">Heartbeats</th>
              <th>Transmit expires</th>
              <th>Grant expires</th>
              <th className={cx('w-[1%] !z-[2]', pin)} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {grants.map((g) => {
              const active = ACTIVE(g);
              const txLeft = g.transmitExpireTime ? g.transmitExpireTime - now : null;
              const mark = marks?.[g.grantId];
              return (
                <tr key={g.grantId} aria-selected={followed === g.cbsdId} onMouseEnter={() => mark && onAck?.(g.grantId)} onFocus={() => mark && onAck?.(g.grantId)} className={cx(!active && 'text-ink-2')}>
                  <td className="pr-0">{mark ? <span className="changed-mark" title={`Changed: ${mark}`} /> : null}</td>
                  {showCbsd && (
                    <td className="max-w-[260px]">
                      <CbsdName cbsdId={g.cbsdId} fccId={g.fccId ?? undefined} serial={g.serial ?? undefined} />
                    </td>
                  )}
                  <td className="max-w-[170px] truncate font-mono text-xs text-ink-2" title={g.grantId}>{g.grantId}</td>
                  <td>
                    <div className="flex flex-col items-start gap-0.5">
                      <GrantStateTag state={g.state} suspended={g.suspended} />
                      {!active && g.endReason && <span className="max-w-[220px] truncate text-xs text-ink-3" title={g.endReason}>{g.endReason}</span>}
                    </div>
                  </td>
                  <td className="num whitespace-nowrap text-right font-mono text-xs">
                    {range(g.low, g.high)}<span className="text-ink-3"> · {mhz(g.high - g.low)}</span>
                    <div className="text-xs text-ink-3" title={g.channelType === 'PAL' ? 'Priority Access (PAL) channel' : 'General Authorized Access'}>{g.channelType}</div>
                  </td>
                  <td className="num whitespace-nowrap text-right font-mono text-xs">{g.maxEirp}<span className="text-ink-3"> dBm/MHz</span></td>
                  <td className="num whitespace-nowrap text-right text-xs">
                    <span className="font-mono">{g.heartbeatCount}</span>
                    <span className="text-ink-3"> · every </span>
                    <span className="font-mono">{g.heartbeatInterval}s</span>
                    {g.pendingHeartbeatInterval ? <span className="font-mono text-warn-ink" title="Sent with the next heartbeat response"> → {g.pendingHeartbeatInterval}s</span> : null}
                    <div className="text-xs text-ink-3">{g.lastHeartbeat ? ago(g.lastHeartbeat, now) : 'none yet'}</div>
                  </td>
                  <td className="num whitespace-nowrap font-mono text-xs">
                    {active && txLeft !== null ? (
                      <span className={cx(txLeft <= 0 ? 'text-ink-3' : txLeft < 15e3 ? 'text-warn-ink' : 'text-ink')} title={iso(g.transmitExpireTime)}>{until(g.transmitExpireTime, now)}</span>
                    ) : <span className="text-ink-3">—</span>}
                  </td>
                  <td className="num whitespace-nowrap font-mono text-xs" title={iso(g.grantExpireTime)}>
                    {active ? until(g.grantExpireTime, now) : g.endedAt ? <span className="text-ink-3">ended {clock(g.endedAt, true)}</span> : '—'}
                  </td>
                  <td className={pin}>{active && actions(g)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <GrantEditor grant={edit} onClose={() => setEdit(null)} />
    </>
  );
}

function toLocalInput(ts: number) {
  const d = new Date(ts);
  const off = d.getTimezoneOffset() * 60e3;
  return new Date(ts - off).toISOString().slice(0, 19);
}

function GrantEditor({ grant, onClose }: { grant: Grant | null; onClose: () => void }) {
  const { run, busy } = useAction();
  const [hb, setHb] = useState('');
  const [exp, setExp] = useState('');
  const [sugOn, setSugOn] = useState(false);
  const [sug, setSug] = useState({ low: '', high: '', eirp: '' });
  const [key, setKey] = useState<string | null>(null);
  if (grant && key !== grant.grantId) {
    setKey(grant.grantId);
    setHb(String(grant.pendingHeartbeatInterval ?? grant.heartbeatInterval));
    setExp(toLocalInput(grant.grantExpireTime));
    const s = grant.suggestedOperationParam;
    setSugOn(!!s);
    setSug(s ? { low: mhz(s.operationFrequencyRange.lowFrequency), high: mhz(s.operationFrequencyRange.highFrequency), eirp: String(s.maxEirp) } : { low: mhz(grant.low), high: mhz(grant.high), eirp: String(grant.maxEirp) });
  }
  if (!grant && key !== null) setKey(null);

  const save = () => grant && run('save', async () => {
    const body: any = {};
    if (Number(hb) !== grant.heartbeatInterval || grant.pendingHeartbeatInterval) body.heartbeatInterval = Number(hb) === grant.heartbeatInterval ? null : Number(hb);
    const t = new Date(exp).getTime();
    if (Number.isFinite(t) && Math.abs(t - grant.grantExpireTime) >= 1000) body.grantExpireTime = new Date(t).toISOString();
    body.suggestedOperationParam = sugOn ? {
      maxEirp: Number(sug.eirp),
      operationFrequencyRange: { lowFrequency: Math.round(Number(sug.low) * 1e6), highFrequency: Math.round(Number(sug.high) * 1e6) },
    } : null;
    await api.patch(`/api/grants/${encodeURIComponent(grant.grantId)}`, body);
    onClose();
  }, 'Grant updated');

  return (
    <Drawer open={!!grant} onClose={onClose} title="Edit grant" width={520}>
      {grant && (
        <div className="space-y-5 p-4">
          <Readout rows={[
            ['Grant ID', <span className="break-all font-mono text-xs">{grant.grantId}</span>],
            ['Channel', <span className="font-mono text-sm">{range(grant.low, grant.high)} MHz · {grant.maxEirp} dBm/MHz</span>],
          ]} />
          <Field label="Heartbeat interval (s)" hint="Sent to the CBSD in the next heartbeat response (heartbeatInterval), then used for the grant.">
            <Input type="number" min={1} value={hb} onChange={(e) => setHb(e.target.value)} className="w-40" />
          </Field>
          <Field label="Grant expire time (local time)" hint="Shorten it to watch the CBSD request a renewal, or let the grant lapse to EXPIRED.">
            <Input type="datetime-local" step={1} value={exp} onChange={(e) => setExp(e.target.value)} className="w-64" />
          </Field>
          <fieldset className="rounded border border-line p-3">
            <legend className="px-1 text-sm font-medium text-ink-2">
              <label className="inline-flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={sugOn} onChange={(e) => setSugOn(e.target.checked)} className="accent-[rgb(var(--sel))]" />
                Suggest different operation parameters
              </label>
            </legend>
            <p className="mb-3 text-xs text-ink-3">Sent as operationParam in every successful heartbeat response for this grant, telling the CBSD which parameters the SAS would rather it used.</p>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Low (MHz)"><Input disabled={!sugOn} value={sug.low} onChange={(e) => setSug({ ...sug, low: e.target.value })} /></Field>
              <Field label="High (MHz)"><Input disabled={!sugOn} value={sug.high} onChange={(e) => setSug({ ...sug, high: e.target.value })} /></Field>
              <Field label="Max EIRP (dBm/MHz)"><Input disabled={!sugOn} value={sug.eirp} onChange={(e) => setSug({ ...sug, eirp: e.target.value })} /></Field>
            </div>
          </fieldset>
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy === 'save'} onClick={save}>Save changes</Button>
          </div>
        </div>
      )}
    </Drawer>
  );
}
