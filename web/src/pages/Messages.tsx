import { useCallback, useEffect, useRef, useState } from 'react';
import { Crosshair, Download, Pause, Play, ScrollText, Search, Trash2, X } from 'lucide-react';
import { api, download } from '../lib/api';
import { useLiveMessages } from '../lib/live';
import { useFollow } from '../lib/follow';
import { setQuery, useLocation, Link } from '../lib/router';
import { cbsdLabel, clockMs, iso, SAS_METHODS } from '../lib/format';
import type { MessageRow } from '../lib/types';
import { MessageDrawer, isErrorRow, normMsg, transportTag, type WireRow } from '../components/message';
import { Swatch } from '../components/rack';
import { Button, CodeTag, Empty, ErrorNote, HttpTag, Input, Module, PageHeader, Select, SkeletonRows, Switch, cx, useAction, useConfirm } from '../components/ui';

const PAGE = 200;

export function MessagesPage() {
  const { query } = useLocation();
  const { followed } = useFollow();
  const [method, setMethod] = useState(query.get('method') ?? '');
  const [errors, setErrors] = useState(query.get('errors') === '1');
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState(query.get('q') ?? '');
  const [qApplied, setQApplied] = useState(q);
  const [paused, setPaused] = useState(false);
  const [rows, setRows] = useState<WireRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [more, setMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [buffered, setBuffered] = useState(0);
  const open = query.get('id') ? Number(query.get('id')) : null;
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const cbsdFilter = mine && followed ? followed : query.get('cbsdId') ?? '';

  const params = useCallback((before?: number) => {
    const p = new URLSearchParams({ limit: String(PAGE) });
    if (method) p.set('method', method);
    if (errors) p.set('errors', '1');
    if (qApplied) p.set('q', qApplied);
    if (cbsdFilter) p.set('cbsdId', cbsdFilter);
    if (before) p.set('before', String(before));
    return p.toString();
  }, [method, errors, qApplied, cbsdFilter]);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const my = ++seq.current;
    setErr(null);
    try {
      const d = await api.get<MessageRow[]>(`/api/messages?${params()}`);
      if (my !== seq.current) return;
      setRows(d.map(normMsg));
      setMore(d.length === PAGE);
      setBuffered(0);
    } catch (e: any) {
      if (my === seq.current) setErr(e.message);
    }
  }, [params]);
  useEffect(() => {
    void load();
  }, [load]);

  useLiveMessages((m) => {
    const r = normMsg(m);
    if (method && r.method !== method) return;
    if (errors && !isErrorRow(r)) return;
    if (cbsdFilter && !r.cbsds.includes(cbsdFilter)) return;
    if (qApplied) return; // text search needs the server; refresh manually
    if (paused) {
      setBuffered((b) => b + 1);
      return;
    }
    setRows((x) => (x ? [r, ...x].slice(0, 2000) : x));
  });

  const loadMore = async () => {
    if (!rows?.length) return;
    setLoadingMore(true);
    try {
      const d = await api.get<MessageRow[]>(`/api/messages?${params(rows[rows.length - 1].id)}`);
      setRows([...rows, ...d.map(normMsg)]);
      setMore(d.length === PAGE);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div>
      <PageHeader title="Wire log" sub="Every request that reached the SAS listeners or the request console, with the exact JSON exchanged. Click a row for the full request and response.">
        <Button icon={Download} onClick={() => download('/api/messages-export')}>Export NDJSON</Button>
        <Button icon={Trash2} variant="danger-ghost" loading={busy === 'clear'} onClick={async () => {
          if (await confirm({ title: 'Clear the wire log?', body: 'Deletes every logged exchange. SAS state is not affected.', confirm: 'Clear log', danger: true })) {
            await run('clear', async () => {
              await api.del('/api/messages');
              setRows([]);
            }, 'Wire log cleared');
          }
        }}>Clear</Button>
      </PageHeader>

      <Module
        bodyClass=""
        title="Exchanges"
        meta={rows ? `${rows.length}${more ? '+' : ''} shown` : null}
        actions={(
          <Button size="sm" variant={paused ? 'primary' : 'ghost'} icon={paused ? Play : Pause} onClick={() => {
            if (paused) void load();
            setPaused(!paused);
          }}>
            {paused ? `Resume${buffered ? ` (${buffered} new)` : ''}` : 'Pause'}
          </Button>
        )}
      >
        <form
          className="flex flex-wrap items-end gap-3 border-b border-line px-3 py-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            setQApplied(q.trim());
          }}
        >
          <label className="text-sm">
            <span className="silk mb-1 block">Method</span>
            <Select value={method} onChange={(e) => setMethod(e.target.value)} className="w-44">
              <option value="">All methods</option>
              {SAS_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              <option disabled>──────────</option>
              {['admin/reset', 'admin/injectdata/fcc_id', 'admin/injectdata/user_id', 'admin/trigger/daily_activities_immediately'].map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
          </label>
          <label className="text-sm">
            <span className="silk mb-1 block">Search JSON / IP</span>
            <span className="relative block">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
              <Input value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => setQApplied(q.trim())} placeholder="grantId, serial, 10.0.0.12…" className="w-64 pl-7" />
            </span>
          </label>
          <Switch checked={errors} onChange={setErrors} label="Errors only" className="pb-1.5" />
          {followed && <Switch checked={mine} onChange={setMine} label={<span className="inline-flex items-center gap-1"><Crosshair className="size-3.5 text-sel" /> Followed CBSD</span>} className="pb-1.5" />}
          {query.get('cbsdId') && !mine && (
            <Button size="sm" icon={X} onClick={() => setQuery('cbsdId', null)} title="Remove CBSD filter">CBSD {cbsdLabel(query.get('cbsdId')!)}</Button>
          )}
        </form>

        {err && <div className="p-3"><ErrorNote>{err}</ErrorNote></div>}
        {!rows ? <SkeletonRows rows={10} cols={7} /> : rows.length === 0 ? (
          <Empty icon={ScrollText} title={method || errors || qApplied || cbsdFilter ? 'Nothing matches these filters' : 'No exchanges yet'}>
            {method || errors || qApplied || cbsdFilter ? 'Loosen a filter, or wait for new traffic.' : 'Requests appear here the moment a radio, the harness or the console talks to the SAS.'}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="dtable min-w-[1100px]">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Transport</th>
                  <th>Client</th>
                  <th>Method</th>
                  <th>HTTP</th>
                  <th>Response codes</th>
                  <th>CBSD</th>
                  <th className="text-right">ms</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    aria-selected={open === r.id || (!!followed && r.cbsds.includes(followed))}
                    className={cx('cursor-pointer', isErrorRow(r) && 'bg-bad-soft/35')}
                    onClick={() => setQuery('id', String(r.id))}
                  >
                    <td className="num whitespace-nowrap font-mono text-xs" title={iso(r.ts)}>{clockMs(r.ts)}</td>
                    <td>{transportTag(r.transport)}</td>
                    <td className="max-w-[220px] truncate font-mono text-2xs text-ink-2" title={r.cert ?? undefined}>{r.remote ?? '—'}</td>
                    <td className="whitespace-nowrap font-mono text-xs text-ink">
                      {r.method ?? r.path}
                      {r.version && r.version !== 'v1.2' ? <span className="text-ink-3"> ({r.version})</span> : null}
                    </td>
                    <td><HttpTag status={r.http} /></td>
                    <td>
                      <span className="flex max-w-[360px] flex-wrap gap-1">
                        {r.codes.slice(0, 6).map((c, i) => <CodeTag key={i} code={c} />)}
                        {r.codes.length > 6 && <span className="num text-2xs text-ink-3">+{r.codes.length - 6}</span>}
                        {r.error && <span className="truncate text-xs text-bad-ink">{r.error}</span>}
                      </span>
                    </td>
                    <td className="max-w-[220px]">
                      {r.cbsds.length ? (
                        <Link to={`/cbsds/${encodeURIComponent(r.cbsds[0])}`} onClick={(e) => e.stopPropagation()} className="flex min-w-0 items-center gap-1.5 hover:underline">
                          <Swatch cbsdId={r.cbsds[0]} />
                          <span className="truncate font-mono text-2xs">{cbsdLabel(r.cbsds[0])}</span>
                          {r.cbsds.length > 1 && <span className="num text-2xs text-ink-3">+{r.cbsds.length - 1}</span>}
                        </Link>
                      ) : <span className="text-ink-3">—</span>}
                    </td>
                    <td className="num text-right font-mono text-2xs text-ink-3">{r.ms ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {more && (
              <div className="border-t border-line p-3 text-center">
                <Button loading={loadingMore} onClick={loadMore}>Load older exchanges</Button>
              </div>
            )}
          </div>
        )}
      </Module>
      <MessageDrawer id={open} onClose={() => setQuery('id', null)} />
    </div>
  );
}
