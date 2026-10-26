import { useState } from 'react';
import { Crosshair } from 'lucide-react';
import { useLiveMessages, useNow } from '../lib/live';
import { useFollow } from '../lib/follow';
import { Link, navigate } from '../lib/router';
import { ago, dur, mhz, parseCodes, patchColor, range } from '../lib/format';
import type { Cbsd, Grant } from '../lib/types';
import { Led, Tag, cx, type Tone } from './ui';

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

function regTone(c: Cbsd): Tone {
  if (c.state === 'REGISTERED') return c.pendingDeregister ? 'warn' : 'ok';
  if (c.state === 'PENDING') return 'warn';
  return 'off';
}

function grantLed(gs: Grant[]): Tone {
  if (!gs.length) return 'off';
  if (gs.some((g) => g.state === 'AUTHORIZED' && !g.suspended)) return 'ok';
  if (gs.some((g) => g.suspended)) return 'warn';
  return 'info';
}

function hbTone(p: Pulse | undefined, c: Cbsd, gs: Grant[], now: number): Tone {
  if (p && (!c.lastHeartbeatOk || p.ts >= c.lastHeartbeatOk)) {
    if (p.code === 0) return now - p.ts < 10 * 60e3 ? 'ok' : 'off';
    return p.code === 501 || p.code === 105 ? 'warn' : 'bad';
  }
  // No live heartbeat seen yet: a suspended grant means the last heartbeats were answered 501.
  if (gs.some((g) => g.suspended && g.lastHeartbeat && now - g.lastHeartbeat < 10 * 60e3)) return 'warn';
  return c.lastHeartbeatOk && now - c.lastHeartbeatOk < 10 * 60e3 ? 'ok' : 'off';
}

/** TX LED with a bar draining towards transmitExpireTime. */
export function TxIndicator({ grants, now }: { grants: Grant[]; now: number }) {
  const tx = grants.filter((g) => g.state === 'AUTHORIZED' && !g.suspended && g.transmitExpireTime && g.transmitExpireTime > now);
  const exp = tx.length ? Math.min(...tx.map((g) => g.transmitExpireTime!)) : null;
  const span = tx.length ? Math.max(...tx.map((g) => Math.max(1, (g.transmitExpireTime! - (g.lastHeartbeat ?? g.createdAt)) / 1000))) : 1;
  const left = exp ? (exp - now) / 1000 : 0;
  const frac = exp ? Math.max(0, Math.min(1, left / span)) : 0;
  const tone: Tone = !exp ? 'off' : left < 15 ? 'warn' : 'ok';
  return (
    <span className="inline-flex items-center gap-1.5" title={exp ? `Transmit window closes in ${dur(left)}` : 'Not authorized to transmit'}>
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

function RackLeds({ c, gs, p, now }: { c: Cbsd; gs: Grant[]; p: Pulse | undefined; now: number }) {
  return (
    <span className="inline-flex items-center gap-[19px]">
      <Led c={regTone(c)} title={c.pendingDeregister ? 'DEREGISTER (105) pending' : c.state} />
      <Led c={grantLed(gs)} title={gs.length ? gs.map((g) => `${g.state}${g.suspended ? ' (suspended)' : ''}`).join(', ') : 'No active grant'} />
      <Led c={hbTone(p, c, gs, now)} flash={p?.n} title={p ? `Last heartbeat ${ago(p.ts, now)}, code ${p.code}` : c.lastHeartbeatOk ? `Last good heartbeat ${ago(c.lastHeartbeatOk, now)}` : 'No heartbeat'} />
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

function subLine(c: Cbsd, now: number) {
  return [c.radioTechnology, c.indoor === true ? 'indoor' : c.indoor === false ? 'outdoor' : null,
    c.remoteAddr && `${(c.transport ?? '').toUpperCase()} ${c.remoteAddr}`, `seen ${ago(c.lastSeen, now)}`].filter(Boolean).join(' · ');
}

function Held({ gs, stacked }: { gs: Grant[]; stacked?: boolean }) {
  if (!gs.length) return <span className="text-xs text-ink-3">no grant</span>;
  return (
    <div className={cx('flex flex-col gap-0.5', stacked && 'items-end')}>
      {gs.map((g) => (
        <div key={g.grantId} className="num whitespace-nowrap font-mono text-xs leading-4" title={`${g.state}${g.suspended ? ' (suspended)' : ''} · ${g.channelType}`}>
          <span className={cx(g.suspended ? 'text-warn-ink' : g.state === 'AUTHORIZED' ? 'text-ink' : 'text-ink-2')}>{range(g.low, g.high)}</span>
          <span className="block text-2xs text-ink-3">{g.maxEirp} dBm/MHz{g.channelType === 'PAL' ? ' · PAL' : ''}</span>
        </div>
      ))}
    </div>
  );
}

export function CbsdRack({ cbsds, grants, pulses, marks, onAck }: {
  cbsds: Cbsd[]; grants: Map<string, Grant[]>; pulses: Record<string, Pulse>; marks?: Record<string, string>; onAck?: (id: string) => void;
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
            <li key={c.cbsdId} aria-selected={followed === c.cbsdId} className={cx('cursor-pointer px-3 py-2', followed === c.cbsdId && 'bg-sel-soft')} onClick={() => open(c.cbsdId)} onTouchStart={() => mark && onAck?.(c.cbsdId)}>
              <div className="flex items-center gap-3">
                <Swatch cbsdId={c.cbsdId} />
                <RackLeds c={c} gs={gs} p={pulses[c.cbsdId]} now={now} />
                <TxIndicator grants={gs} now={now} />
                {mark && <span className="changed-mark ml-auto" title={`Changed: ${mark}`} />}
              </div>
              <div className="mt-1.5 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="break-all font-mono text-xs font-medium">{c.fccId}<span className="text-ink-3"> / </span>{c.serial}</span>
                    <RackTags c={c} />
                  </div>
                  <div className="mt-0.5 text-2xs text-ink-3">{subLine(c, now)}</div>
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
          </tr>
        </thead>
        <tbody>
          {cbsds.map((c) => {
            const gs = grants.get(c.cbsdId) ?? [];
            const isFollowed = followed === c.cbsdId;
            const mark = marks?.[c.cbsdId];
            return (
              <tr key={c.cbsdId} aria-selected={isFollowed} className="cursor-pointer" onMouseEnter={() => mark && onAck?.(c.cbsdId)} onClick={() => open(c.cbsdId)}>
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
                    <Link to={`/cbsds/${encodeURIComponent(c.cbsdId)}`} onClick={(e) => e.stopPropagation()} className="truncate font-mono text-xs font-medium text-ink hover:underline">
                      {c.fccId}<span className="text-ink-3"> / </span>{c.serial}
                    </Link>
                    {isFollowed && <Crosshair className="size-3.5 flex-none text-sel" aria-label="Followed" />}
                    <RackTags c={c} />
                  </div>
                  <div className="truncate text-xs text-ink-3">{subLine(c, now)}</div>
                </td>
                <td className="py-1.5 text-right"><Held gs={gs} stacked /></td>
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
                title={`${g.cbsdId}\n${range(g.low, g.high)} MHz · ${g.maxEirp} dBm/MHz · ${g.state}${g.suspended ? ' (suspended)' : ''}`}
                className={cx('absolute inset-y-0 flex items-center overflow-hidden rounded-sm px-1 text-2xs font-medium text-white transition-[filter] hover:brightness-110', g.state !== 'AUTHORIZED' && 'opacity-60')}
                style={{
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
