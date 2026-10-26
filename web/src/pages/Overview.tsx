import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Pause, Play, RadioTower, ShieldCheck } from 'lucide-react';
import { useLiveMessages, useNow, useResource } from '../lib/live';
import { lanFirst, useStatus } from '../lib/status';
import { useChangeMarks } from '../lib/follow';
import { Link, navigate } from '../lib/router';
import { ago, clock, dur, mhz } from '../lib/format';
import type { Cbsd, Grant, MessageRow } from '../lib/types';
import { BandStrip, CbsdName, CbsdRack, groupGrants, useHeartbeatPulses } from '../components/rack';
import { MessageDrawer, isErrorRow, normMsg, type WireRow } from '../components/message';
import { Button, CodeTag, CopyButton, Empty, HttpTag, Led, Module, SkeletonRows, Tag, cx } from '../components/ui';

export function OverviewPage() {
  const { data: s } = useStatus();
  const cbsds = useResource<Cbsd[]>('/api/cbsds', ['cbsds', 'grants']);
  const grants = useResource<Grant[]>('/api/grants?state=GRANTED,AUTHORIZED', ['grants', 'cbsds', 'spectrum']);
  const spectrum = useResource<{ band: { low: number; high: number }; gaaRanges: Array<{ low: number; high: number }> }>('/api/spectrum', ['settings', 'spectrum']);
  const pulses = useHeartbeatPulses();
  const grouped = groupGrants(grants.data);
  const sig = (c: Cbsd) => {
    const gs = grouped.get(c.cbsdId) ?? [];
    return `${c.state}${c.pendingDeregister ? '+105' : ''}|${gs.map((g) => `${g.state}${g.suspended ? 'S' : ''}`).sort().join(',')}`;
  };
  const { marks, ack } = useChangeMarks(cbsds.data && grants.data ? cbsds.data : undefined, (c) => c.cbsdId, sig);

  const band = spectrum.data?.band ?? { low: 3550e6, high: 3700e6 };
  const active = grants.data ?? [];
  const authorized = active.filter((g) => g.state === 'AUTHORIZED' && !g.suspended);

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Overview</h1>
      <Endpoints />

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px] xl:items-stretch 2xl:grid-cols-[minmax(0,1fr)_440px]">
        <div className="min-w-0 space-y-4">
          <Module
            title="CBSD rack"
            meta={s ? <span className="num">{s.counts.cbsdsRegistered} registered{s.counts.cbsdsPending ? ` · ${s.counts.cbsdsPending} pending` : ''} · {s.counts.cbsdsTotal} known</span> : null}
            actions={<Link to="/cbsds" className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">All CBSDs <ArrowRight className="size-3.5" /></Link>}
            bodyClass=""
          >
            {cbsds.loading && !cbsds.data ? <SkeletonRows rows={4} cols={6} /> : !cbsds.data?.length ? <FirstRun /> : (
              <CbsdRack cbsds={cbsds.data} grants={grouped} pulses={pulses} marks={marks} onAck={ack} />
            )}
          </Module>
          <Module
            title="Band occupancy"
            meta={<span className="num">{mhz(band.low)}–{mhz(band.high)} MHz · {authorized.length} transmitting · {s ? `${s.counts.authorizedMHz} MHz authorized` : ''}</span>}
            actions={<Link to="/spectrum" className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">Spectrum <ArrowRight className="size-3.5" /></Link>}
          >
            <BandStrip grants={active} low={band.low} high={band.high} gaa={spectrum.data?.gaaRanges} />
          </Module>
          <Module title="SAS state">
            <StateReadout />
          </Module>
        </div>
        <div className="flex min-w-0 flex-col">
          <LiveWire />
        </div>
      </div>
    </div>
  );
}

function Endpoints() {
  const { data: s } = useStatus();
  if (!s) return <Module title="Point radios at"><div className="skeleton h-14" /></Module>;
  const l = s.listeners;
  const urls = lanFirst(s.urls);
  const https = urls.filter((u) => u.startsWith('https'));
  const http = urls.filter((u) => u.startsWith('http:'));
  const authLabel: Record<string, string> = { require: 'client certificate required (mutual TLS)', optional: 'client certificate optional', none: 'no client certificate requested' };
  return (
    <Module
      title="Point radios at"
      actions={<Button size="sm" icon={ShieldCheck} onClick={() => navigate('/certificates')}>Radio certificates</Button>}
      bodyClass="grid gap-x-8 gap-y-3 p-3 lg:grid-cols-2"
    >
      <EndpointGroup
        label="HTTPS"
        tone={!l.https.enabled ? 'off' : l.https.listening ? 'ok' : 'bad'}
        urls={https}
        detail={!l.https.enabled ? 'Disabled in settings' : l.https.error ? l.https.error : `${l.https.protocols} · ${authLabel[l.https.clientAuth] ?? l.https.clientAuth} · ${l.https.serverCerts.length} server cert${l.https.serverCerts.length === 1 ? '' : 's'} (${l.https.serverCerts.join(', ')})`}
      />
      <EndpointGroup
        label="HTTP"
        tone={!l.http.enabled ? 'off' : l.http.listening ? 'ok' : 'bad'}
        urls={http}
        detail={!l.http.enabled ? 'Disabled in settings' : l.http.error ? l.http.error : 'Plain HTTP for radios and simulators without TLS. Not part of the WInnForum security profile.'}
      />
    </Module>
  );
}

function EndpointGroup({ label, tone, urls, detail }: { label: string; tone: 'ok' | 'bad' | 'off'; urls: string[]; detail: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? urls : urls.slice(0, 2);
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center gap-2">
        <Led c={tone} title={tone === 'ok' ? 'Listening' : tone === 'bad' ? 'Down' : 'Disabled'} />
        <span className="silk text-ink-2">{label}</span>
      </div>
      {urls.length === 0 ? <p className="text-sm text-ink-3">No URL (listener disabled)</p> : (
        <ul className="space-y-0.5">
          {shown.map((u) => (
            <li key={u} className="group flex items-center gap-1">
              <code className="truncate font-mono text-sm text-ink">{u}</code>
              <CopyButton text={u} label={`Copy ${u}`} className="opacity-60 group-hover:opacity-100" />
            </li>
          ))}
        </ul>
      )}
      {urls.length > 2 && (
        <button type="button" onClick={() => setAll(!all)} className="text-xs text-sel-ink hover:underline">
          {all ? 'Fewer addresses' : `${urls.length - 2} more address${urls.length - 2 === 1 ? '' : 'es'}`}
        </button>
      )}
      <p className={cx('mt-1 text-xs', tone === 'bad' ? 'text-bad-ink' : 'text-ink-3')}>{detail}</p>
    </div>
  );
}

function FirstRun() {
  const { data: s } = useStatus();
  const url = lanFirst(s?.urls ?? []).find((u) => u.startsWith('https')) ?? s?.urls[0];
  return (
    <Empty icon={RadioTower} title="No radios have contacted this SAS yet" className="py-8">
      <ol className="mx-auto mt-2 max-w-[56ch] space-y-1.5 text-left text-sm text-ink-2">
        <li><span className="num mr-2 font-mono text-ink-3">1</span>Issue a certificate kit for the radio on <Link to="/certificates" className="text-sel-ink underline">Certificates</Link> and load the device certificate, key and the SAS root CA onto it.</li>
        <li><span className="num mr-2 font-mono text-ink-3">2</span>Set the radio's SAS URL to <code className="font-mono text-xs text-ink">{url ?? 'https://<this host>:8443/v1.2/'}</code>.</li>
        <li><span className="num mr-2 font-mono text-ink-3">3</span>Its registration, grants and heartbeats appear here as they happen. No radio handy? Send requests from the <Link to="/console" className="text-sel-ink underline">request console</Link>.</li>
      </ol>
    </Empty>
  );
}

/** A wire line; consecutive good heartbeats from the same CBSD fold into one line that counts them. */
interface WireLine extends WireRow { n: number; run?: string; first: number }

const goodBeat = (r: WireRow) => r.method === 'heartbeat' && r.cbsds.length > 0 && !isErrorRow(r);

/**
 * Add an exchange to the top of the list. A good heartbeat joins its CBSD's open run, unless
 * something else has happened to that CBSD since; anything else gets its own line.
 */
function fold(lines: WireLine[], r: WireRow): WireLine[] {
  if (goodBeat(r)) {
    const key = r.cbsds.join(',');
    const i = lines.findIndex((l) => l.cbsds.some((c) => r.cbsds.includes(c)));
    if (i >= 0 && lines[i].run === key) {
      const next = lines.slice();
      next[i] = { ...r, n: lines[i].n + 1, run: key, first: lines[i].first };
      return next;
    }
    return [{ ...r, n: 1, run: key, first: r.ts }, ...lines].slice(0, 80);
  }
  return [{ ...r, n: 1, first: r.ts }, ...lines].slice(0, 80);
}

function LiveWire() {
  const recent = useResource<MessageRow[]>('/api/messages?limit=200', []);
  const [lines, setLines] = useState<WireLine[]>([]);
  const [paused, setPaused] = useState(false);
  const held = useRef<WireRow[]>([]);
  const [heldCount, setHeldCount] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const now = useNow();
  useEffect(() => {
    if (recent.data) setLines(recent.data.map(normMsg).reverse().reduce(fold, [] as WireLine[]));
  }, [recent.data]);
  useLiveMessages((m) => {
    if (paused) {
      held.current.push(normMsg(m));
      setHeldCount(held.current.length);
      return;
    }
    setLines((l) => fold(l, normMsg(m)));
  });
  const togglePause = () => {
    if (paused) {
      const rows = held.current;
      held.current = [];
      setHeldCount(0);
      setLines((l) => rows.reduce(fold, l));
    }
    setPaused(!paused);
  };
  return (
    <Module
      title="Wire"
      className="xl:min-h-0 xl:flex-1"
      meta={lines[0] ? <span className="num">last {ago(Math.max(...lines.slice(0, 8).map((l) => l.ts)), now)}</span> : null}
      actions={(
        <>
          <Button size="sm" variant={paused ? 'primary' : 'ghost'} icon={paused ? Play : Pause} onClick={togglePause} title={paused ? 'Resume live updates' : 'Pause live updates'} aria-label={paused ? 'Resume live updates' : 'Pause live updates'}>
            {paused ? `Resume${heldCount ? ` (${heldCount} new)` : ''}` : null}
          </Button>
          <Link to="/messages" className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">Wire log <ArrowRight className="size-3.5" /></Link>
        </>
      )}
      bodyClass="max-h-[420px] overflow-y-auto xl:h-0 xl:max-h-none xl:min-h-[320px]"
    >
      {recent.loading && !lines.length ? <SkeletonRows rows={6} cols={3} /> : lines.length === 0 ? (
        <Empty title="Quiet on the wire">Every SAS request and response will stream here.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {lines.map((r) => (
            <li key={r.run ? `run:${r.run}:${r.first}` : r.id}>
              <button
                type="button"
                onClick={() => setOpen(r.id)}
                title={r.n > 1 ? `${r.n} heartbeats answered 0 since ${clock(r.first)}; opens the latest` : undefined}
                className={cx('flex w-full items-center gap-2 px-3 py-[7px] text-left text-sm transition-colors hover:bg-panel-3/70', isErrorRow(r) && 'bg-bad-soft/40')}
              >
                <span className="num w-[58px] flex-none font-mono text-2xs text-ink-3">{clock(r.ts)}</span>
                <span className="w-[92px] flex-none truncate font-mono text-xs text-ink">{r.method ?? r.path}</span>
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  {r.cbsds.length ? (
                    <>
                      <CbsdName cbsdId={r.cbsds[0]} link={false} className="text-ink-2" />
                      {r.cbsds.length > 1 && <span className="num flex-none text-xs text-ink-3">+{r.cbsds.length - 1}</span>}
                    </>
                  ) : <span className="truncate font-mono text-xs text-ink-3">{r.remote ?? ''}</span>}
                </span>
                <span className="flex flex-none items-center gap-1">
                  {r.n > 1 && <span className="num font-mono text-xs text-ink-3">×{r.n}</span>}
                  {r.codes.length ? summarizeCodes(r.codes) : <HttpTag status={r.http} />}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <MessageDrawer id={open} onClose={() => setOpen(null)} />
    </Module>
  );
}

function summarizeCodes(codes: number[]) {
  const uniq = [...new Set(codes)];
  if (uniq.length === 1 && codes.length > 1) return <><CodeTag code={uniq[0]} /><span className="num text-2xs text-ink-3">×{codes.length}</span></>;
  return uniq.slice(0, 2).map((c) => <CodeTag key={c} code={c} />);
}

function StateReadout() {
  const { data: s } = useStatus();
  const now = useNow();
  if (!s) return <div className="skeleton h-24" />;
  const g = s.counts.grantsByState;
  const line = (k: string, v: ReactNode, tone?: 'warn' | 'bad', to?: string) => (
    <div className="flex items-baseline justify-between gap-3 border-b border-line py-1">
      {to ? <Link to={to} className="text-sm text-ink-2 underline decoration-line-strong hover:text-ink hover:decoration-ink-3">{k}</Link> : <span className="text-sm text-ink-2">{k}</span>}
      <span className={cx('num font-mono text-sm', tone === 'bad' ? 'text-bad-ink' : tone === 'warn' ? 'text-warn-ink' : 'text-ink')}>{v}</span>
    </div>
  );
  return (
    <div>
      <div className="grid gap-x-6 sm:grid-cols-2 2xl:grid-cols-3">
        {line('Grants authorized / granted', `${g.AUTHORIZED ?? 0} / ${g.GRANTED ?? 0}`)}
        {line('Grants ended (term · relinq · exp)', `${g.TERMINATED ?? 0} · ${g.RELINQUISHED ?? 0} · ${g.EXPIRED ?? 0}`)}
        {line('Requests last hour', s.counts.messagesLastHour)}
        {line('Error responses last hour', s.counts.errorsLastHour, s.counts.errorsLastHour ? 'warn' : undefined, s.counts.errorsLastHour ? '/messages?errors=1' : undefined)}
        {line('Active protections', s.counts.activeProtections, s.counts.activeProtections ? 'warn' : undefined, s.counts.activeProtections ? '/spectrum' : undefined)}
        {line('PPAs', s.counts.ppas)}
        {line('Fault rules armed', s.counts.faultRules, s.counts.faultRules ? 'warn' : undefined, s.counts.faultRules ? '/faults' : undefined)}
        {line('Terrain tiles (HAAT)', s.terrain.tiles ? s.terrain.tiles : 'none', s.terrain.tiles ? undefined : 'warn')}
        {line('Uptime', dur((now - s.startedAt) / 1000))}
      </div>
      {(s.triggers.measInRegistration || s.triggers.measInHeartbeat || s.daily.running) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {s.triggers.measInRegistration && <Tag tone="info">Meas. report trigger: registration</Tag>}
          {s.triggers.measInHeartbeat && <Tag tone="info">Meas. report trigger: heartbeat</Tag>}
          {s.daily.running && <Tag tone="warn">Daily activities running</Tag>}
        </div>
      )}
    </div>
  );
}

