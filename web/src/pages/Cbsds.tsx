import { useMemo, useState } from 'react';
import { Check, Crosshair, RadioTower, Search } from 'lucide-react';
import { api } from '../lib/api';
import { useNow, useResource } from '../lib/live';
import { useChangeMarks, useFollow } from '../lib/follow';
import { navigate } from '../lib/router';
import { ago } from '../lib/format';
import type { Cbsd, Grant } from '../lib/types';
import { CbsdRack, Swatch, TxIndicator, groupGrants, useHeartbeatPulses } from '../components/rack';
import { Button, Empty, ErrorNote, Input, Led, Module, Note, PageHeader, Segmented, SkeletonRows, Tag, cx, useAction } from '../components/ui';

type Filter = 'all' | 'REGISTERED' | 'PENDING' | 'UNREGISTERED';

export function CbsdsPage() {
  const cbsds = useResource<Cbsd[]>('/api/cbsds', ['cbsds', 'grants']);
  const grants = useResource<Grant[]>('/api/grants?state=GRANTED,AUTHORIZED', ['grants', 'cbsds']);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const { followed, setFollowed } = useFollow();
  const { run, busy } = useAction();
  const pulses = useHeartbeatPulses();
  const now = useNow();
  const grouped = groupGrants(grants.data);
  const { marks, ack } = useChangeMarks(cbsds.data, (c) => c.cbsdId, (c) => `${c.state}${c.pendingDeregister ? '+105' : ''}`);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (cbsds.data ?? []).filter((c) => (filter === 'all' || c.state === filter) && (!needle || [c.cbsdId, c.fccId, c.serial, c.userId, c.remoteAddr, c.radioTechnology, c.callSign].some((v) => v?.toLowerCase().includes(needle))));
  }, [cbsds.data, filter, q]);
  const count = (st: string) => (cbsds.data ?? []).filter((c) => c.state === st).length;
  const pending = (cbsds.data ?? []).filter((c) => c.state === 'PENDING');

  return (
    <div>
      <PageHeader
        title="CBSDs"
        sub="Every radio that has sent a registration request. Open one to see its parameters, grants and exchanges, or to approve, deregister and cap it."
      >
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="FCC ID, serial, user, IP…" className="w-64 pl-7" aria-label="Search CBSDs" />
        </div>
        <Segmented
          value={filter}
          onChange={setFilter}
          label="State filter"
          options={[
            { value: 'all', label: `All ${cbsds.data?.length ?? ''}` },
            { value: 'REGISTERED', label: `Registered ${count('REGISTERED')}` },
            { value: 'PENDING', label: `Pending ${count('PENDING')}` },
            { value: 'UNREGISTERED', label: `Unregistered ${count('UNREGISTERED')}` },
          ]}
        />
      </PageHeader>

      {pending.length > 0 && (
        <Note tone="warn" className="mb-4 flex flex-wrap items-center gap-3">
          <span>
            {pending.length} registration{pending.length > 1 ? 's' : ''} waiting for approval. The CBSD keeps receiving 200 REG_PENDING until you approve it; approval completes on its next registration request.
          </span>
          <Button size="sm" variant="primary" icon={Check} loading={busy === 'approve-all'} onClick={() => run('approve-all', async () => {
            for (const c of pending) await api.post(`/api/cbsds/${encodeURIComponent(c.cbsdId)}/approve`);
          }, `Approved ${pending.length} registration${pending.length > 1 ? 's' : ''}`)}>
            Approve all
          </Button>
        </Note>
      )}

      <Module bodyClass="">
        {cbsds.error && <div className="p-3"><ErrorNote>{cbsds.error}</ErrorNote></div>}
        {cbsds.loading && !cbsds.data ? <SkeletonRows rows={6} cols={7} /> : rows.length === 0 ? (
          cbsds.data?.length ? (
            <Empty icon={Search} title="No CBSD matches this filter" action={<Button size="sm" onClick={() => { setQ(''); setFilter('all'); }}>Clear filter</Button>} />
          ) : (
            <Empty icon={RadioTower} title="No CBSDs yet">
              A CBSD appears here after its first registration request reaches the SAS, whether or not it succeeds.
            </Empty>
          )
        ) : (
          <>
          <div className="md:hidden">
            <CbsdRack cbsds={rows} grants={grouped} pulses={pulses} marks={marks} onAck={ack} />
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="dtable min-w-[1000px]">
              <thead>
                <tr>
                  <th className="w-[1%]" aria-label="Identity" />
                  <th className="w-[1%]">State</th>
                  <th>FCC ID / serial</th>
                  <th>Category · technology</th>
                  <th>User ID</th>
                  <th>Grants</th>
                  <th className="w-[1%]">TX window</th>
                  <th>Location</th>
                  <th className="text-right">Last seen</th>
                  <th className="w-[1%]" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const gs = grouped.get(c.cbsdId) ?? [];
                  const p = pulses[c.cbsdId];
                  const isF = followed === c.cbsdId;
                  const ended = (c.grants.TERMINATED ?? 0) + (c.grants.RELINQUISHED ?? 0) + (c.grants.EXPIRED ?? 0) + (c.grants.DELETED ?? 0);
                  return (
                    <tr key={c.cbsdId} aria-selected={isF} className="cursor-pointer" onMouseEnter={() => marks[c.cbsdId] && ack(c.cbsdId)} onClick={() => navigate(`/cbsds/${encodeURIComponent(c.cbsdId)}`)}>
                      <td className="pr-0">
                        <span className="flex items-center gap-1.5">
                          <Swatch cbsdId={c.cbsdId} />
                          {marks[c.cbsdId] ? <span className="changed-mark" title={`Changed: ${marks[c.cbsdId]}`} /> : <span className="w-[7px]" />}
                        </span>
                      </td>
                      <td>
                        <span className="flex items-center gap-2">
                          <Led c={c.state === 'REGISTERED' ? 'ok' : c.state === 'PENDING' ? 'warn' : 'off'} flash={p?.n} />
                          <span className="font-label text-xs font-semibold tracking-[0.04em] text-ink-2">{c.state}</span>
                          {c.pendingDeregister && <Tag tone="warn">105 PENDING</Tag>}
                        </span>
                      </td>
                      <td className="max-w-[260px]">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-mono text-xs font-medium">{c.fccId}<span className="text-ink-3"> / </span>{c.serial}</span>
                          {isF && <Crosshair className="size-3.5 flex-none text-sel" aria-label="Followed" />}
                        </div>
                        <div className="truncate font-mono text-2xs text-ink-3" title={c.cbsdId}>{c.cbsdId}</div>
                      </td>
                      <td className="whitespace-nowrap text-sm">{c.category ? `Cat ${c.category}` : '—'}<span className="text-ink-3"> · {c.radioTechnology ?? '—'}</span></td>
                      <td className="max-w-[160px] truncate font-mono text-xs">{c.userId ?? '—'}</td>
                      <td className="whitespace-nowrap text-sm">
                        <span className="num">{(c.grants.AUTHORIZED ?? 0) + (c.grants.GRANTED ?? 0)} active</span>
                        {ended ? <span className="num text-ink-3"> · {ended} ended</span> : null}
                      </td>
                      <td><TxIndicator grants={gs} now={now} /></td>
                      <td className="num whitespace-nowrap font-mono text-2xs text-ink-2">
                        {c.latitude != null && c.longitude != null ? `${c.latitude.toFixed(4)}, ${c.longitude.toFixed(4)}` : '—'}
                        {c.height != null && <span className="text-ink-3"> · {c.height} m {c.heightType ?? ''}</span>}
                        {c.indoor === true && <span className="text-ink-3"> · indoor</span>}
                      </td>
                      <td className="num whitespace-nowrap text-right text-xs text-ink-2">
                        {ago(c.lastSeen, now)}
                        <div className="font-mono text-2xs text-ink-3">{c.transport ? c.transport.toUpperCase() : ''} {c.remoteAddr ?? ''}</div>
                      </td>
                      <td>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={Crosshair}
                          className={cx(isF && 'text-sel')}
                          title={isF ? 'Stop following' : 'Follow this CBSD across pages'}
                          aria-label={isF ? 'Stop following' : 'Follow'}
                          onClick={(e) => {
                            e.stopPropagation();
                            setFollowed(isF ? null : c.cbsdId);
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Module>
    </div>
  );
}
