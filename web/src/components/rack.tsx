import { useState, type ReactNode } from 'react';
import { Crosshair } from 'lucide-react';
import { useLiveMessages, useNow } from '../lib/live';
import { useFollow } from '../lib/follow';
import { Link, navigate } from '../lib/router';
import { ago, cbsdLabel, cbsdParts, dur, mhz, parseCodes, patchColor, patchFg, range } from '../lib/format';
import type { Cbsd, Grant } from '../lib/types';
import { Button, Led, Switch, Tag, cx, type Tone } from './ui';

// The CBSD "rack": each radio is a 1U row with front-panel LEDs driven by wire events.

export interface Pulse {
  n: number;
  code: number;
  ts: number;
}

/** Counts heartbeats per CBSD as they arrive over SSE so the HB LED can flash on each one. */
export function useHeartbeatPulses() {
  const [pulses, setPulses] = useState<Record<string, Pulse>>({});
  useLiveMessages((m) => {
    if (m.method !== 'heartbeat') return;
    const ids = m.cbsdIds ?? [];
    if (!ids.length) return;
    const codes = parseCodes(m.codes as any);
    const worst = codes.find((c) => c !== 0) ?? (m.httpStatus && m.httpStatus >= 400 ? -1 : 0);
    setPulses((p) => {
      const next = { ...p };
      for (const id of ids) next[id] = { n: (p[id]?.n ?? 0) + 1, code: worst, ts: m.ts };
      return next;
    });
  });
  return pulses;
}

export function groupGrants(grants: Grant[] | undefined): Map<string, Grant[]> {
  const m = new Map<string, Grant[]>();
  for (const g of grants ?? []) {
    if (g.state !== 'GRANTED' && g.state !== 'AUTHORIZED') continue;
    const a = m.get(g.cbsdId) ?? [];
    a.push(g);
    m.set(g.cbsdId, a);
  }
  return m;
}

// One set of LED rules for every view of a radio (rack, CBSD page header).

export interface LedState { c: Tone; title: string }

function regLed(c: Cbsd): LedState {
  if (c.state === 'REGISTERED') return c.pendingDeregister ? { c: 'warn', title: 'Registered · DEREGISTER (105) pending' } : { c: 'ok', title: 'Registered' };
  if (c.state === 'PENDING') return { c: 'warn', title: 'Registration pending approval' };
  return { c: 'off', title: c.state === 'UNREGISTERED' ? 'Not registered' : c.state };
}

function grantLed(gs: Grant[]): LedState {
  const title = gs.length ? gs.map((g) => `${range(g.low, g.high)} ${g.state}${g.suspended ? ' (suspended)' : ''}`).join(', ') : 'No active grant';
  if (!gs.length) return { c: 'off', title };
  if (gs.some((g) => g.state === 'AUTHORIZED' && !g.suspended)) return { c: 'ok', title };
  if (gs.some((g) => g.suspended)) return { c: 'warn', title };
  return { c: 'info', title };
}

/**
 * Heartbeat LED, timed against the heartbeat interval the SAS gave the radio: green while
 * heartbeats arrive on time (1.5× the interval), amber when they are late or answered 501/105,
 * red when answered with an error, off once the radio has gone quiet (3× the interval).
 */
function hbLed(p: Pulse | undefined, c: Cbsd, gs: Grant[], now: number): LedState {
  const interval = gs.length ? Math.min(...gs.map((g) => g.pendingHeartbeatInterval ?? g.heartbeatInterval ?? 60)) : 60;
  const age = (ts: number) => (now - ts) / 1000;
  const onTime = (ts: number) => age(ts) <= interval * 1.5 + 5;
  const alive = (ts: number) => age(ts) <= interval * 3 + 5;
  const every = `interval ${dur(interval)}`;
  if (p && (!c.lastHeartbeatOk || p.ts >= c.lastHeartbeatOk)) {
    const when = `last heartbeat ${ago(p.ts, now)}, ${every}`;
    if (!alive(p.ts)) return { c: 'off', title: `Quiet: ${when}` };
    if (p.code === 0) return onTime(p.ts) ? { c: 'ok', title: `Heartbeating: ${when}` } : { c: 'warn', title: `Late: ${when}` };
    if (p.code === 501 || p.code === 105) return { c: 'warn', title: `Answered ${p.code}: ${when}` };
    return { c: 'bad', title: `Answered ${p.code < 0 ? 'with an HTTP error' : p.code}: ${when}` };
  }
  // No live heartbeat seen since the page loaded: a suspended grant means the last ones got 501.
  if (gs.some((g) => g.suspended && g.lastHeartbeat && alive(g.lastHeartbeat))) return { c: 'warn', title: 'Suspended: heartbeats answered 501' };
  const last = c.lastHeartbeatOk;
  if (!last) return { c: 'off', title: 'No heartbeat yet' };
  const when = `last good heartbeat ${ago(last, now)}, ${every}`;
  return !alive(last) ? { c: 'off', title: `Quiet: ${when}` } : onTime(last) ? { c: 'ok', title: `Heartbeating: ${when}` } : { c: 'warn', title: `Late: ${when}` };
}

export function cbsdLeds(c: Cbsd, gs: Grant[], p: Pulse | undefined, now: number) {
  return { reg: regLed(c), gnt: grantLed(gs), hb: hbLed(p, c, gs, now) };
}

/** TX LED with a bar draining towards transmitExpireTime. */
export function TxIndicator({ grants, now }: { grants: Grant[]; now: number }) {
  const tx = grants.filter((g) => g.state === 'AUTHORIZED' && !g.suspended && g.transmitExpireTime && g.transmitExpireTime > now);
  const exp = tx.length ? Math.min(...tx.map((g) => g.transmitExpireTime!)) : null;
  const span = tx.length ? Math.max(...tx.map((g) => Math.max(1, (g.transmitExpireTime! - (g.lastHeartbeat ?? g.createdAt)) / 1000))) : 1;
  const left = exp ? (exp - now) / 1000 : 0;
  const frac = exp ? Math.max(0, Math.min(1, left / span)) : 0;
  const tone: Tone = !exp ? 'off' : left < 15 ? 'warn' : 'ok';
  const title = exp ? `Transmit window closes in ${dur(left)}` : 'Not authorized to transmit';
  return (
    <span className="inline-flex items-center gap-1.5" title={title} role="img" aria-label={title}>
      <Led c={tone} />
      <span className="relative h-[3px] w-10 overflow-hidden rounded-full bg-line" aria-hidden>
        <span
          className={cx('absolute inset-y-0 left-0 rounded-full transition-[width] duration-1000 ease-linear', tone === 'warn' ? 'bg-warn' : 'bg-ok')}
          style={{ width: `${frac * 100}%` }}
        />
      </span>
      <span className="num w-[46px] font-mono text-2xs text-ink-3">{exp ? dur(left) : '—'}</span>
    </span>
  );
}

export function Swatch({ cbsdId, className }: { cbsdId: string; className?: string }) {
  return <span aria-hidden className={cx('inline-block size-2.5 flex-none rounded-[2px]', className)} style={{ background: patchColor(cbsdId) }} />;
}

/**
 * A radio's name as the radio itself reports it: patch swatch, FCC ID and serial. The FCC ID
 * truncates first so the serial (what tells two bench units apart) stays readable; the full
 * cbsdId is in the tooltip.
 */
export function CbsdName({ cbsdId, fccId, serial, link = true, swatch = true, className }: {
  cbsdId: string; fccId?: string; serial?: string; link?: boolean; swatch?: boolean; className?: string;
}) {
  const p = fccId !== undefined && serial !== undefined ? { fccId, serial } : cbsdParts(cbsdId);
  const body = (
    <>
      {swatch && <Swatch cbsdId={cbsdId} />}
      <span className="flex min-w-0 items-baseline">
        <span className="truncate">{p.fccId}</span>
        {p.serial && <><span className="flex-none whitespace-pre text-ink-3"> / </span><span className="flex-none">{p.serial}</span></>}
      </span>
    </>
  );
  const cls = cx('inline-flex min-w-0 max-w-full items-center gap-1.5 font-mono text-xs', className);
  return link
    ? <Link to={`/cbsds/${encodeURIComponent(cbsdId)}`} title={cbsdId} onClick={(e) => e.stopPropagation()} className={cx(cls, 'hover:underline')}>{body}</Link>
    : <span title={cbsdId} className={cls}>{body}</span>;
}

/** "Followed CBSD only" filter switch; renders nothing while no CBSD is followed. */
export function FollowedOnly({ checked, onChange, className }: { checked: boolean; onChange: (v: boolean) => void; className?: string }) {
  const { followed } = useFollow();
  if (!followed) return null;
  return (
    <Switch
      checked={checked}
      onChange={onChange}
      className={className}
      label={<span className="inline-flex items-center gap-1.5" title={cbsdLabel(followed)}><Crosshair className="size-3.5 text-sel" aria-hidden />Followed CBSD only</span>}
    />
  );
}

export function RackLeds({ c, gs, p, now, labels }: { c: Cbsd; gs: Grant[]; p: Pulse | undefined; now: number; labels?: boolean }) {
  const l = cbsdLeds(c, gs, p, now);
  if (labels) {
    return (
      <span className="inline-flex items-center gap-4">
        {([['REG', l.reg], ['GNT', l.gnt], ['HB', l.hb]] as const).map(([k, v]) => (
          <span key={k} className="inline-flex items-center gap-1.5"><Led c={v.c} title={v.title} flash={k === 'HB' ? p?.n : undefined} /><span className="silk">{k}</span></span>
        ))}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-[19px]">
      <Led c={l.reg.c} title={`REG: ${l.reg.title}`} />
      <Led c={l.gnt.c} title={`GNT: ${l.gnt.title}`} />
      <Led c={l.hb.c} flash={p?.n} title={`HB: ${l.hb.title}`} />
    </span>
  );
}

function RackTags({ c }: { c: Cbsd }) {
  return (
    <>
      {c.category && <Tag>CAT {c.category}</Tag>}
      {c.state === 'PENDING' && <Tag tone="warn">PENDING APPROVAL</Tag>}
      {c.state === 'UNREGISTERED' && <Tag>UNREGISTERED</Tag>}
      {c.pendingDeregister && <Tag tone="warn">105 PENDING</Tag>}
    </>
  );
}

/** Second line of a rack row. The detailed rack (CBSDs page) adds user and location, and keeps link and last-seen in their own column. */
function subLine(c: Cbsd, now: number, detail?: boolean) {
  const where = c.latitude != null && c.longitude != null
    ? `${c.latitude.toFixed(4)}, ${c.longitude.toFixed(4)}${c.height != null ? ` · ${c.height} m ${c.heightType ?? ''}`.trimEnd() : ''}`
    : 'no location';
  const tech = <span className="font-mono">{c.radioTechnology ?? 'no air interface'}</span>;
  const parts: ReactNode[] = detail
    ? [tech, c.indoor === true ? 'indoor' : c.indoor === false ? 'outdoor' : null, c.userId && <span className="font-mono">{c.userId}</span>, <span className="num font-mono">{where}</span>]
    : [tech, c.indoor === true ? 'indoor' : c.indoor === false ? 'outdoor' : null, c.remoteAddr && <span className="font-mono">{`${(c.transport ?? '').toUpperCase()} ${c.remoteAddr}`}</span>, `seen ${ago(c.lastSeen, now)}`];
  return parts.filter(Boolean).map((x, i) => <span key={i}>{i > 0 && <span aria-hidden> · </span>}{x}</span>);
}

function Held({ gs, stacked }: { gs: Grant[]; stacked?: boolean }) {
  if (!gs.length) return <span className="text-xs text-ink-3">no grant</span>;
  return (
    <div className={cx('flex flex-col gap-0.5', stacked && 'items-end')}>
      {gs.map((g) => (
        <div key={g.grantId} className="num whitespace-nowrap font-mono text-xs leading-4" title={`${g.state}${g.suspended ? ' (suspended)' : ''} · ${g.channelType}`}>
          <span className={cx(g.suspended ? 'text-warn-ink' : g.state === 'AUTHORIZED' ? 'text-ink' : 'text-ink-2')}>{range(g.low, g.high)}</span>
          <span className="block text-xs text-ink-3">{g.maxEirp} dBm/MHz{g.channelType === 'PAL' ? ' · PAL' : ''}{g.suspended ? ' · suspended' : ''}</span>
        </div>
      ))}
    </div>
  );
}

function FollowButton({ cbsdId }: { cbsdId: string }) {
  const { followed, setFollowed } = useFollow();
  const isF = followed === cbsdId;
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={Crosshair}
      className={cx(isF && 'text-sel')}
      title={isF ? 'Stop following' : 'Follow this CBSD across pages'}
      aria-label={isF ? `Stop following ${cbsdLabel(cbsdId)}` : `Follow ${cbsdLabel(cbsdId)}`}
      aria-pressed={isF}
      onClick={(e) => {
        e.stopPropagation();
        setFollowed(isF ? null : cbsdId);
      }}
    />
  );
}

/**
 * The CBSD rack: one 1U row per radio. `detail` (CBSDs page) adds user and location to the second
 * line, a last-seen column and a follow button; the overview keeps the compact form.
 */
export function CbsdRack({ cbsds, grants, pulses, marks, onAck, detail }: {
  cbsds: Cbsd[]; grants: Map<string, Grant[]>; pulses: Record<string, Pulse>; marks?: Record<string, string>; onAck?: (id: string) => void; detail?: boolean;
}) {
  const now = useNow();
  const { followed } = useFollow();
  const open = (id: string) => navigate(`/cbsds/${encodeURIComponent(id)}`);
  return (
    <>
      {/* Phones: one stacked 2-line row per radio, no sideways scrolling. */}
      <ul className="divide-y divide-line md:hidden">
        {cbsds.map((c) => {
          const gs = grants.get(c.cbsdId) ?? [];
          const mark = marks?.[c.cbsdId];
          return (
            <li key={c.cbsdId} aria-selected={followed === c.cbsdId} className={cx('cursor-pointer px-3 py-2', followed === c.cbsdId && 'bg-sel-soft')} onClick={() => open(c.cbsdId)} onTouchStart={() => mark && onAck?.(c.cbsdId)} onFocus={() => mark && onAck?.(c.cbsdId)}>
              <div className="flex items-center gap-3">
                <Swatch cbsdId={c.cbsdId} />
                <RackLeds c={c} gs={gs} p={pulses[c.cbsdId]} now={now} labels />
                <TxIndicator grants={gs} now={now} />
                {mark && <span className="changed-mark ml-auto" title={`Changed: ${mark}`} />}
              </div>
              <div className="mt-1.5 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link to={`/cbsds/${encodeURIComponent(c.cbsdId)}`} onClick={(e) => e.stopPropagation()} className="break-all font-mono text-xs font-medium text-ink">
                      {c.fccId}<span className="text-ink-3"> / </span>{c.serial}
                    </Link>
                    <RackTags c={c} />
                  </div>
                  <div className="mt-0.5 text-xs text-ink-3">{subLine(c, now, detail)}</div>
                  {detail && <div className="mt-0.5 text-xs text-ink-3">seen {ago(c.lastSeen, now)}{c.remoteAddr && <span className="font-mono"> · {(c.transport ?? '').toUpperCase()} {c.remoteAddr}</span>}</div>}
                </div>
                <Held gs={gs} stacked />
              </div>
            </li>
          );
        })}
      </ul>

      <table className="dtable hidden md:table">
        <thead>
          <tr>
            <th className="w-[1%]" aria-label="Identity" />
            <th className="w-[1%]">
              <span className="inline-flex gap-[11px]"><span title="Registered">REG</span><span title="Grant">GNT</span><span title="Heartbeat">HB</span></span>
            </th>
            <th className="w-[1%]">TX window</th>
            <th>CBSD</th>
            <th className="w-[1%] text-right">Spectrum held (MHz)</th>
            {detail && <th className="w-[1%] text-right">Last seen</th>}
            {detail && <th className="w-[1%]"><span className="sr-only">Follow</span></th>}
          </tr>
        </thead>
        <tbody>
          {cbsds.map((c) => {
            const gs = grants.get(c.cbsdId) ?? [];
            const isFollowed = followed === c.cbsdId;
            const mark = marks?.[c.cbsdId];
            return (
              <tr key={c.cbsdId} aria-selected={isFollowed} className="cursor-pointer" onMouseEnter={() => mark && onAck?.(c.cbsdId)} onFocus={() => mark && onAck?.(c.cbsdId)} onClick={() => open(c.cbsdId)}>
                <td className="pr-0">
                  <span className="flex items-center gap-1.5">
                    <Swatch cbsdId={c.cbsdId} />
                    {mark ? <span className="changed-mark" title={`Changed: ${mark}`} /> : <span className="w-[7px]" />}
                  </span>
                </td>
                <td><span className="pl-1"><RackLeds c={c} gs={gs} p={pulses[c.cbsdId]} now={now} /></span></td>
                <td><TxIndicator grants={gs} now={now} /></td>
                <td className="max-w-0 py-1.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <CbsdName cbsdId={c.cbsdId} fccId={c.fccId} serial={c.serial} swatch={false} className="font-medium text-ink" />
                    {isFollowed && <Crosshair className="size-3.5 flex-none text-sel" aria-label="Followed" />}
                    <RackTags c={c} />
                  </div>
                  <div className="truncate text-xs text-ink-3">{subLine(c, now, detail)}</div>
                </td>
                <td className="py-1.5 text-right"><Held gs={gs} stacked /></td>
                {detail && (
                  <td className="num whitespace-nowrap py-1.5 text-right text-xs text-ink-2">
                    {ago(c.lastSeen, now)}
                    <div className="font-mono text-xs text-ink-3">{c.transport ? c.transport.toUpperCase() : ''} {c.remoteAddr ?? ''}</div>
                  </td>
                )}
                {detail && <td className="pl-0"><FollowButton cbsdId={c.cbsdId} /></td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/** Compact occupancy strip of active grants across the band. */
export function BandStrip({ grants, low, high, gaa }: { grants: Grant[]; low: number; high: number; gaa?: Array<{ low: number; high: number }> }) {
  const w = high - low;
  const pct = (f: number) => `${((Math.min(high, Math.max(low, f)) - low) / w) * 100}%`;
  const lanes: Grant[][] = [];
  for (const g of [...grants].sort((a, b) => a.low - b.low)) {
    const lane = lanes.find((l) => l[l.length - 1].high <= g.low);
    if (lane) lane.push(g);
    else lanes.push([g]);
  }
  const ticks: number[] = [];
  for (let f = Math.ceil(low / 10e6) * 10e6; f <= high; f += 10e6) ticks.push(f);
  return (
    <div>
      <div className="relative h-2 rounded-sm bg-panel-3" title="GAA availability">
        {(gaa ?? []).map((r, i) => (
          <span key={i} className="absolute inset-y-0 rounded-sm bg-line-strong/70" style={{ left: pct(r.low), width: `calc(${pct(r.high)} - ${pct(r.low)})` }} />
        ))}
      </div>
      <div className="relative mt-1.5 space-y-1" style={{ minHeight: 22 }}>
        {lanes.length === 0 && <div className="flex h-[22px] items-center justify-center rounded-sm border border-dashed border-line text-xs text-ink-3">No active grants</div>}
        {lanes.map((lane, i) => (
          <div key={i} className="relative h-[18px]">
            {lane.map((g) => (
              <Link
                key={g.grantId}
                to={`/cbsds/${encodeURIComponent(g.cbsdId)}`}
                title={`${cbsdLabel(g.cbsdId)}\n${range(g.low, g.high)} MHz · ${g.maxEirp} dBm/MHz · ${g.state}${g.suspended ? ' (suspended)' : ''}`}
                aria-label={`${cbsdLabel(g.cbsdId)}: ${range(g.low, g.high)} MHz, ${g.state}${g.suspended ? ', suspended' : ''}`}
                className={cx('absolute inset-y-0 flex items-center overflow-hidden rounded-sm px-1 text-2xs font-medium transition-[filter] hover:brightness-110', g.state !== 'AUTHORIZED' && 'opacity-60')}
                style={{
                  color: patchFg(g.cbsdId),
                  left: pct(g.low),
                  width: `calc(${pct(g.high)} - ${pct(g.low)} - 1px)`,
                  background: g.suspended
                    ? `repeating-linear-gradient(135deg, ${patchColor(g.cbsdId)} 0 4px, ${patchColor(g.cbsdId, 0.45)} 4px 8px)`
                    : patchColor(g.cbsdId),
                }}
              >
                <span className="num truncate font-mono">{mhz(g.high - g.low)}</span>
              </Link>
            ))}
          </div>
        ))}
      </div>
      <div className="relative mt-1 h-4">
        {ticks.map((f, i) => (
          <span
            key={f}
            className={cx('num absolute font-mono text-2xs text-ink-3', i === 0 ? '' : i === ticks.length - 1 ? '-translate-x-full' : '-translate-x-1/2')}
            style={{ left: pct(f) }}
          >
            {mhz(f)}
          </span>
        ))}
      </div>
    </div>
  );
}
