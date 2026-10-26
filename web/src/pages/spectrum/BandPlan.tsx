import { useId, useMemo, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { cbsdLabel, cbsdParts, mhz, patchFg, patchIndex, range } from '../../lib/format';
import type { Ppa } from '../../lib/types';
import { KIND_LABEL, activeRanges, kindRank, packLanes, useWidth, type SpectrumData, type SpectrumGrant } from './shared';

// Band plan: the CBRS band as a frequency axis with GAA availability, PAL channels, protections
// (one row per kind) and every live grant packed into lanes in its CBSD's patch colour.

interface ProtGroup {
  low: number;
  high: number;
  active: boolean;
  action: 'suspend' | 'terminate';
  names: string[];
}

interface PalItem {
  low: number;
  high: number;
  ppa: Ppa;
  palId: string | null;
}

type Hover =
  | { t: 'grant'; g: SpectrumGrant }
  | { t: 'prot'; kind: string; p: ProtGroup }
  | { t: 'pal'; p: PalItem }
  | null;

const AXIS = 24;
const ROW = 18;
const GAP = 5;
const SECTION = 12;
// Opaque, so the "not available" hatch on the track beneath does not show through available ranges.
const GAA_FILL = 'color-mix(in srgb, rgb(var(--line-strong)) 50%, rgb(var(--panel)))';

export function BandPlan({ data, followed, onOpen }: { data: SpectrumData; followed: string | null; onOpen: (cbsdId: string) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hoverF, setHoverF] = useState<number | null>(null);
  const [hover, setHover] = useState<Hover>(null);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const { low: bLow, high: bHigh } = data.band;

  const gutter = width < 560 ? 70 : 104;
  const plotW = Math.max(10, width - gutter - 10);
  const x = (f: number) => gutter + ((Math.min(Math.max(f, bLow), bHigh) - bLow) / (bHigh - bLow)) * plotW;

  const model = useMemo(() => {
    const clip = <T extends { low: number; high: number }>(r: T): T | null => {
      const low = Math.max(r.low, bLow);
      const high = Math.min(r.high, bHigh);
      return high > low ? { ...r, low, high } : null;
    };
    const pal: PalItem[] = data.ppas.flatMap((p) => p.channels.map((c) => clip({ low: c.low, high: c.high, ppa: p, palId: c.palId }))).filter(Boolean) as PalItem[];
    const kinds = [...new Set(data.protections.map((p) => p.kind))].sort((a, b) => kindRank(a) - kindRank(b) || a.localeCompare(b));
    const prot = kinds.map((kind) => {
      const list = data.protections.filter((p) => p.kind === kind);
      const groups = new Map<string, ProtGroup>();
      for (const p of list) {
        const ranges = p.active ? activeRanges(p) : [[p.low, p.high] as [number, number]];
        for (const [l, h] of ranges) {
          const c = clip({ low: l, high: h });
          if (!c) continue;
          const k = `${c.low}-${c.high}-${p.action}-${p.active}`;
          const g = groups.get(k) ?? { low: c.low, high: c.high, active: p.active, action: p.action, names: [] };
          g.names.push(p.name);
          groups.set(k, g);
        }
      }
      const sorted = [...groups.values()].sort((a, b) => Number(a.active) - Number(b.active));
      return { kind, total: list.length, active: list.filter((p) => p.active).length, groups: sorted };
    });
    const grants = data.grants.map((g) => clip(g)).filter(Boolean) as SpectrumGrant[];
    return { pal, palLanes: packLanes(pal), prot, grantLanes: packLanes(grants), grants };
  }, [data, bLow, bHigh]);

  // Vertical layout
  let y = AXIS + 6;
  const rowY = () => {
    const v = y;
    y += ROW + GAP;
    return v;
  };
  const gaaY = rowY();
  y += SECTION - GAP;
  const palYs = (model.palLanes.length ? model.palLanes : [[]]).map(() => rowY());
  y += SECTION - GAP;
  const protYs = (model.prot.length ? model.prot : [null]).map(() => rowY());
  y += SECTION - GAP;
  const grantYs = (model.grantLanes.length ? model.grantLanes : [[]]).map(() => rowY());
  const height = y - GAP + 6;

  // Axis ticks
  const spanMHz = (bHigh - bLow) / 1e6;
  const pxPer10 = plotW / (spanMHz / 10);
  const labelStep = pxPer10 >= 46 ? 10 : pxPer10 >= 23 ? 20 : 50;
  const ticks: Array<{ f: number; major: boolean }> = [];
  for (let m = Math.ceil(bLow / 5e6) * 5; m * 1e6 <= bHigh; m += 5) ticks.push({ f: m * 1e6, major: m % labelStep === 0 });

  const dim = (cbsdId: string) => !!followed && cbsdId !== followed && model.grants.some((g) => g.cbsdId === followed);

  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px < gutter || px > gutter + plotW) return setHoverF(null);
    const f = bLow + ((px - gutter) / plotW) * (bHigh - bLow);
    setHoverF(Math.round(f / 1e5) * 1e5);
  };

  const label = (text: string, yy: number, count?: string) => (
    <g>
      <text x={0} y={yy + ROW / 2} dominantBaseline="central" className="fill-ink-3 font-label text-2xs font-semibold uppercase tracking-[0.09em]">{text}</text>
      {count && gutter > 80 ? (
        <text x={gutter - 8} y={yy + ROW / 2} dominantBaseline="central" textAnchor="end" className="fill-ink-3 font-mono text-2xs">{count}</text>
      ) : null}
    </g>
  );
  const track = (yy: number, fill = 'rgb(var(--panel-2))') => (
    <rect x={gutter} y={yy} width={plotW} height={ROW} rx={2} style={{ fill, stroke: 'rgb(var(--line))', strokeWidth: 1 }} />
  );
  const fits = (w: number, text: string) => w > text.length * 6.4 + 10;

  return (
    <div>
      <div ref={ref} className="w-full">
        {width > 0 && (
          <svg
            width={width}
            height={height}
            className="block select-none"
            onMouseMove={onMove}
            onMouseLeave={() => {
              setHoverF(null);
              setHover(null);
            }}
            role="group"
            aria-label={`Band plan ${mhz(bLow)}–${mhz(bHigh)} MHz`}
          >
            <defs>
              <pattern id={`${uid}-nogaa`} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                <rect width="6" height="6" style={{ fill: 'rgb(var(--panel-2))' }} />
                <line x1="0" y1="0" x2="0" y2="6" style={{ stroke: 'rgb(var(--line-strong))', strokeWidth: 1.5 }} />
              </pattern>
              <pattern id={`${uid}-susp`} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="6" style={{ stroke: 'rgb(var(--warn))', strokeWidth: 2.5 }} />
              </pattern>
            </defs>

            {/* axis + grid */}
            {ticks.map((t) => (
              <g key={t.f}>
                {t.major && <line x1={x(t.f)} x2={x(t.f)} y1={AXIS} y2={height} style={{ stroke: 'rgb(var(--line))', strokeWidth: 1 }} />}
                <line x1={x(t.f)} x2={x(t.f)} y1={AXIS - (t.major ? 6 : 3)} y2={AXIS} style={{ stroke: 'rgb(var(--ink-3))', strokeWidth: 1 }} />
                {t.major && (
                  <text x={x(t.f)} y={AXIS - 10} textAnchor={t.f === bLow ? 'start' : t.f === bHigh ? 'end' : 'middle'} className="fill-ink-3 font-mono text-2xs">
                    {mhz(t.f)}
                  </text>
                )}
              </g>
            ))}
            <line x1={gutter} x2={gutter + plotW} y1={AXIS} y2={AXIS} style={{ stroke: 'rgb(var(--line-strong))', strokeWidth: 1 }} />
            <text x={0} y={AXIS - 10} className="fill-ink-3 font-label text-2xs font-semibold uppercase tracking-[0.09em]">MHz</text>

            {/* GAA availability */}
            {label('GAA', gaaY)}
            {track(gaaY, `url(#${uid}-nogaa)`)}
            {data.gaaRanges.map((r, i) => (
              <rect key={i} x={x(r.low)} y={gaaY} width={Math.max(1, x(r.high) - x(r.low))} height={ROW} rx={2}
                style={{ fill: GAA_FILL, stroke: 'rgb(var(--line-strong))', strokeWidth: 1 }} />
            ))}

            {/* PAL channels (PPAs) */}
            {palYs.map((yy, i) => (
              <g key={`pal${i}`}>
                {i === 0 && label('PAL', yy, model.pal.length ? String(data.ppas.length) : undefined)}
                {track(yy)}
              </g>
            ))}
            {!model.pal.length && <text x={gutter + 8} y={palYs[0] + ROW / 2} dominantBaseline="central" className="fill-ink-3 text-xs">No PPAs</text>}
            {model.palLanes.map((lane, i) => lane.map((p, j) => {
              const w = Math.max(2, x(p.high) - x(p.low));
              const txt = p.palId ?? p.ppa.name;
              return (
                <g key={`${i}-${j}`} onMouseEnter={() => setHover({ t: 'pal', p })} onMouseLeave={() => setHover(null)}>
                  <rect x={x(p.low)} y={palYs[i]} width={w} height={ROW} rx={2} style={{ fill: 'rgb(var(--sel) / 0.2)', stroke: 'rgb(var(--sel))', strokeWidth: 1 }} />
                  {fits(w, txt) && <text x={x(p.low) + 5} y={palYs[i] + ROW / 2} dominantBaseline="central" className="pointer-events-none fill-sel-ink font-mono text-2xs">{txt}</text>}
                </g>
              );
            }))}

            {/* protections, one row per kind */}
            {!model.prot.length && (
              <g>
                {label('Protect', protYs[0])}
                {track(protYs[0])}
                <text x={gutter + 8} y={protYs[0] + ROW / 2} dominantBaseline="central" className="fill-ink-3 text-xs">No protections</text>
              </g>
            )}
            {model.prot.map((row, i) => (
              <g key={row.kind}>
                {label(KIND_LABEL[row.kind] ?? row.kind, protYs[i], `${row.active}/${row.total}`)}
                {track(protYs[i])}
                {row.groups.map((g, j) => {
                  const tone = g.action === 'terminate' ? 'bad' : 'warn';
                  const w = Math.max(2, x(g.high) - x(g.low));
                  return (
                    <rect
                      key={j}
                      x={x(g.low) + 0.5}
                      y={protYs[i] + 0.5}
                      width={w - 1}
                      height={ROW - 1}
                      rx={2}
                      onMouseEnter={() => setHover({ t: 'prot', kind: row.kind, p: g })}
                      onMouseLeave={() => setHover(null)}
                      style={g.active
                        ? { fill: `rgb(var(--${tone}) / 0.3)`, stroke: `rgb(var(--${tone}))`, strokeWidth: 1.25 }
                        : { fill: 'transparent', stroke: 'rgb(var(--line-strong))', strokeWidth: 1, strokeDasharray: '3 2' }}
                    />
                  );
                })}
              </g>
            ))}

            {/* grants */}
            {grantYs.map((yy, i) => (
              <g key={`gl${i}`}>
                {i === 0 && label('Grants', yy, model.grants.length ? String(model.grants.length) : undefined)}
                {track(yy)}
              </g>
            ))}
            {!model.grants.length && <text x={gutter + 8} y={grantYs[0] + ROW / 2} dominantBaseline="central" className="fill-ink-3 text-xs">No active grants</text>}
            {model.grantLanes.map((lane, i) => lane.map((g) => {
              const w = Math.max(3, x(g.high) - x(g.low));
              const auth = g.state === 'AUTHORIZED' && !g.suspended;
              const isF = followed === g.cbsdId;
              const name = cbsdParts(g.cbsdId);
              const txt = `${name.known ? name.serial : name.fccId} · ${g.maxEirp} dBm`;
              const p = `var(--p${patchIndex(g.cbsdId)})`;
              return (
                <g
                  key={g.grantId}
                  role="button"
                  tabIndex={0}
                  aria-label={`${cbsdLabel(g.cbsdId)}: grant ${range(g.low, g.high)} MHz, ${g.maxEirp} dBm/MHz, ${g.state}${g.suspended ? ', suspended' : ''}`}
                  className="cursor-pointer outline-none [&:focus-visible>rect:first-child]:![stroke-width:2.5px] [&:focus-visible>rect:first-child]:![stroke:rgb(var(--sel))]"
                  style={{ opacity: dim(g.cbsdId) ? 0.4 : 1 }}
                  onMouseEnter={() => setHover({ t: 'grant', g })}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover({ t: 'grant', g })}
                  onBlur={() => setHover(null)}
                  onClick={() => onOpen(g.cbsdId)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(g.cbsdId))}
                >
                  <rect
                    x={x(g.low) + 0.5}
                    y={grantYs[i] + 0.5}
                    width={w - 1}
                    height={ROW - 1}
                    rx={2}
                    style={{
                      fill: auth ? `rgb(${p})` : `rgb(${p} / 0.22)`,
                      stroke: g.suspended ? 'rgb(var(--warn))' : isF ? 'rgb(var(--ink))' : `rgb(${p})`,
                      strokeWidth: g.suspended || isF ? 2 : 1.25,
                    }}
                  />
                  {g.suspended && <rect x={x(g.low) + 1} y={grantYs[i] + 1} width={Math.max(0, w - 2)} height={ROW - 2} rx={2} style={{ fill: `url(#${uid}-susp)`, opacity: 0.55 }} />}
                  {fits(w, txt) && (
                    <text x={x(g.low) + 5} y={grantYs[i] + ROW / 2} dominantBaseline="central"
                      className="pointer-events-none fill-ink font-mono text-2xs" style={auth ? { fill: patchFg(g.cbsdId) } : undefined}>
                      {txt}
                    </text>
                  )}
                </g>
              );
            }))}

            {hoverF !== null && (
              <line x1={x(hoverF)} x2={x(hoverF)} y1={AXIS} y2={height} className="pointer-events-none" style={{ stroke: 'rgb(var(--sel))', strokeWidth: 1 }} />
            )}
          </svg>
        )}
      </div>
      <div className="mt-2 flex min-h-[38px] items-center rounded border border-line bg-panel-2 px-3 py-1.5 text-sm text-ink-2" aria-live="polite">
        <Readout data={data} hover={hover} f={hoverF} />
      </div>
      <Legend />
    </div>
  );
}

function Swatch({ style }: { style: CSSProperties }) {
  return <span className="inline-block h-2.5 w-4 flex-none rounded-sm" style={style} aria-hidden />;
}

function Readout({ data, hover, f }: { data: SpectrumData; hover: Hover; f: number | null }) {
  let body: ReactNode;
  if (hover?.t === 'grant') {
    const g = hover.g;
    body = (
      <>
        <Swatch style={{ background: `rgb(var(--p${patchIndex(g.cbsdId)}))` }} />
        <span className="font-mono text-xs text-ink" title={g.cbsdId}>{cbsdLabel(g.cbsdId)}</span>
        <Sep />
        <span className="num">{range(g.low, g.high)} MHz</span>
        <Sep />
        <span className="num">{g.maxEirp} dBm/MHz</span>
        <Sep />
        <span>{g.state}{g.suspended ? ' · suspended' : ''} · {g.channelType}</span>
        <span className="ml-auto hidden text-xs text-ink-3 md:inline">Click to open the CBSD</span>
      </>
    );
  } else if (hover?.t === 'prot') {
    const p = hover.p;
    const shown = p.names.slice(0, 4).join(', ');
    body = (
      <>
        <span className="font-medium text-ink">{KIND_LABEL[hover.kind] ?? hover.kind}</span>
        <Sep />
        <span className="num">{range(p.low, p.high)} MHz</span>
        <Sep />
        <span>{p.active ? `active, ${p.action} → heartbeat ${p.action === 'terminate' ? '500' : '501'}` : 'inactive'}</span>
        <Sep />
        <span className="min-w-0 truncate">{shown}{p.names.length > 4 ? ` +${p.names.length - 4} more` : ''}</span>
      </>
    );
  } else if (hover?.t === 'pal') {
    const p = hover.p;
    body = (
      <>
        <span className="font-medium text-ink">{p.ppa.name}</span>
        <Sep />
        <span>PAL {p.palId ?? '—'}</span>
        <Sep />
        <span className="num">{range(p.low, p.high)} MHz</span>
        <Sep />
        <span>{p.ppa.members.length} member CBSD{p.ppa.members.length === 1 ? '' : 's'}</span>
      </>
    );
  } else if (f !== null) {
    const gaa = data.gaaRanges.some((r) => f >= r.low && f < r.high);
    const grants = data.grants.filter((g) => f >= g.low && f < g.high);
    const prots = data.protections.filter((p) => activeRanges(p).some(([l, h]) => f >= l && f < h));
    body = (
      <>
        <span className="num font-mono text-xs font-medium text-ink">{mhz(f, 1)} MHz</span>
        <Sep />
        <span>{gaa ? 'GAA available' : 'not GAA'}</span>
        <Sep />
        <span>{grants.length} grant{grants.length === 1 ? '' : 's'}</span>
        <Sep />
        <span className="min-w-0 truncate">
          {prots.length ? `${prots.length} active protection${prots.length === 1 ? '' : 's'}: ${prots.slice(0, 3).map((p) => p.name).join(', ')}${prots.length > 3 ? '…' : ''}` : 'no active protection'}
        </span>
      </>
    );
  } else {
    body = <span className="text-ink-3">Hover the chart to read frequencies and occupants; click a grant to open its CBSD.</span>;
  }
  return <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">{body}</div>;
}

function Sep() {
  return <span className="text-line-strong" aria-hidden>·</span>;
}

function Legend() {
  const hatch = (c: string) => `repeating-linear-gradient(45deg, ${c} 0 2px, transparent 2px 5px)`;
  const items: Array<[CSSProperties, string]> = [
    [{ background: GAA_FILL, boxShadow: 'inset 0 0 0 1px rgb(var(--line-strong))' }, 'GAA available'],
    [{ background: hatch('rgb(var(--line-strong))') }, 'Not available for GAA'],
    [{ background: 'rgb(var(--sel) / 0.2)', boxShadow: 'inset 0 0 0 1px rgb(var(--sel))' }, 'PAL channel'],
    [{ background: 'rgb(var(--warn) / 0.3)', boxShadow: 'inset 0 0 0 1px rgb(var(--warn))' }, 'Protection active · suspend'],
    [{ background: 'rgb(var(--bad) / 0.3)', boxShadow: 'inset 0 0 0 1px rgb(var(--bad))' }, 'Protection active · terminate'],
    [{ boxShadow: 'inset 0 0 0 1px rgb(var(--line-strong))', borderStyle: 'dashed' }, 'Protection inactive'],
    [{ background: 'rgb(var(--ink-2))' }, 'Grant authorized (CBSD colour)'],
    [{ background: 'rgb(var(--ink-2) / 0.22)', boxShadow: 'inset 0 0 0 1px rgb(var(--ink-2))' }, 'Granted, not transmitting'],
    [{ background: hatch('rgb(var(--warn))'), boxShadow: 'inset 0 0 0 1.5px rgb(var(--warn))' }, 'Suspended'],
  ];
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
      {items.map(([s, t]) => (
        <li key={t} className="flex items-center gap-1.5"><Swatch style={s} />{t}</li>
      ))}
    </ul>
  );
}
