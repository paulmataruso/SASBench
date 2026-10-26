import { useCallback, useEffect, useMemo, useState } from 'react';
import { Crosshair, History, Search, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useLiveEvents } from '../lib/live';
import { useFollow } from '../lib/follow';
import { Link } from '../lib/router';
import { cbsdLabel, clock, iso } from '../lib/format';
import type { EventRow } from '../lib/types';
import { Swatch } from '../components/rack';
import { Button, Empty, ErrorNote, Input, Led, Module, PageHeader, Segmented, SkeletonRows, Switch, cx, useAction, useConfirm } from '../components/ui';

type Level = '' | 'info' | 'success' | 'warn' | 'error';
const PAGE = 300;

export function EventsPage() {
  const [level, setLevel] = useState<Level>('');
  const [q, setQ] = useState('');
  const [mine, setMine] = useState(false);
  const { followed } = useFollow();
  const [rows, setRows] = useState<EventRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [more, setMore] = useState(true);
  const { run, busy } = useAction();
  const confirm = useConfirm();

  const load = useCallback(async () => {
    try {
      const d = await api.get<EventRow[]>(`/api/events?limit=${PAGE}${level ? `&level=${level}` : ''}`);
      setRows(d);
      setMore(d.length === PAGE);
      setErr(null);
    } catch (e: any) {
      setErr(e.message);
    }
  }, [level]);
  useEffect(() => {
    void load();
  }, [load]);
  useLiveEvents((e) => {
    if (level && e.level !== level) return;
    setRows((r) => (r ? [{ ...e, cbsd_id: e.cbsdId, grant_id: e.grantId }, ...r].slice(0, 3000) : r));
  });

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (rows ?? []).filter((e) => (!mine || e.cbsd_id === followed) && (!n || [e.message, e.category, e.cbsd_id, e.grant_id].some((v) => v?.toLowerCase().includes(n))));
  }, [rows, q, mine, followed]);

  const loadMore = async () => {
    if (!rows?.length) return;
    const d = await api.get<EventRow[]>(`/api/events?limit=${PAGE}&before=${rows[rows.length - 1].id}${level ? `&level=${level}` : ''}`);
    setRows([...rows, ...d]);
    setMore(d.length === PAGE);
  };

  return (
    <div>
      <PageHeader title="Events" sub="The SAS's own account of what happened: state changes, policy decisions, warnings about lenient checks, operator actions.">
        <Button icon={Trash2} variant="danger-ghost" loading={busy === 'clear'} onClick={async () => {
          if (await confirm({ title: 'Clear all events?', confirm: 'Clear events', danger: true })) {
            await run('clear', async () => {
              await api.del('/api/events');
              setRows([]);
            }, 'Events cleared');
          }
        }}>Clear</Button>
      </PageHeader>
      <Module bodyClass="">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2.5">
          <Segmented
            value={level}
            onChange={setLevel}
            label="Level"
            options={[{ value: '', label: 'All' }, { value: 'success', label: 'Success' }, { value: 'info', label: 'Info' }, { value: 'warn', label: 'Warnings' }, { value: 'error', label: 'Errors' }]}
          />
          <span className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter text…" className="w-64 pl-7" aria-label="Filter events" />
          </span>
          {followed && <Switch checked={mine} onChange={setMine} label={<span className="inline-flex items-center gap-1"><Crosshair className="size-3.5 text-sel" /> Followed CBSD</span>} />}
        </div>
        {err && <div className="p-3"><ErrorNote>{err}</ErrorNote></div>}
        {!rows ? <SkeletonRows rows={10} cols={4} /> : shown.length === 0 ? (
          <Empty icon={History} title={rows.length ? 'Nothing matches this filter' : 'No events yet'} />
        ) : (
          <>
            <ul className="divide-y divide-line">
              {shown.map((e) => (
                <li key={e.id} className={cx('grid grid-cols-[14px_150px_96px_minmax(0,1fr)] items-start gap-3 px-3 py-2 text-sm max-lg:grid-cols-[14px_minmax(0,1fr)]', followed && e.cbsd_id === followed && 'bg-sel-soft')}>
                  <Led c={e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warn' : e.level === 'success' ? 'ok' : 'info'} className="mt-1.5" title={e.level} />
                  <span className="num font-mono text-xs text-ink-3 max-lg:hidden" title={iso(e.ts)}>{clock(e.ts, true)}</span>
                  <span className="font-label text-xs font-semibold uppercase tracking-[0.06em] text-ink-3 max-lg:hidden">{e.category}</span>
                  <div className="min-w-0">
                    <p className="break-words text-ink">{e.message}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-2xs text-ink-3">
                      <span className="lg:hidden">{clock(e.ts, true)} · {e.category}</span>
                      {e.cbsd_id && (
                        <Link to={`/cbsds/${encodeURIComponent(e.cbsd_id)}`} className="inline-flex items-center gap-1 font-mono hover:underline">
                          <Swatch cbsdId={e.cbsd_id} className="size-2" />{cbsdLabel(e.cbsd_id)}
                        </Link>
                      )}
                      {e.grant_id && <span className="font-mono">grant {e.grant_id}</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            {more && !q && !mine && (
              <div className="border-t border-line p-3 text-center"><Button onClick={loadMore}>Load older events</Button></div>
            )}
          </>
        )}
      </Module>
    </div>
  );
}
