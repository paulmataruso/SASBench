import { useMemo, useState } from 'react';
import { Search, Ticket, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useResource } from '../lib/live';
import { useChangeMarks, useFollow } from '../lib/follow';
import type { Grant } from '../lib/types';
import { GrantTable } from '../components/grants';
import { FollowedOnly } from '../components/rack';
import { Button, Empty, ErrorNote, Input, Module, PageHeader, Segmented, SkeletonRows, cx, useAction, useConfirm } from '../components/ui';

type View = 'active' | 'ended' | 'all';
const QUERY: Record<View, string> = {
  active: '?state=GRANTED,AUTHORIZED',
  ended: '?state=TERMINATED,RELINQUISHED,EXPIRED,DELETED&limit=1000',
  all: '?limit=1000',
};

export function GrantsPage() {
  const [view, setView] = useState<View>('active');
  const [q, setQ] = useState('');
  const [onlyFollowed, setOnlyFollowed] = useState(false);
  const { followed } = useFollow();
  const r = useResource<Grant[]>(`/api/grants${QUERY[view]}`, ['grants', 'cbsds']);
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const { marks, ack } = useChangeMarks(r.data, (g) => g.grantId, (g) => `${g.state}${g.suspended ? ' (suspended)' : ''}`, view);

  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (r.data ?? []).filter((g) => (!onlyFollowed || !followed || g.cbsdId === followed)
      && (!n || [g.grantId, g.cbsdId, g.fccId, g.serial, g.state, g.endReason].some((v) => v?.toLowerCase().includes(n))));
  }, [r.data, q, onlyFollowed, followed]);

  const auth = (r.data ?? []).filter((g) => g.state === 'AUTHORIZED').length;
  const susp = (r.data ?? []).filter((g) => g.suspended && (g.state === 'GRANTED' || g.state === 'AUTHORIZED')).length;

  return (
    <div>
      <PageHeader
        title="Grants"
        sub={view === 'active'
          ? `${r.data?.length ?? 0} active · ${auth} authorized to transmit${susp ? ` · ${susp} suspended` : ''}. Suspend, terminate or reshape a grant and watch how the CBSD reacts on its next heartbeat.`
          : 'Ended grants keep their end reason. They are deleted by re-registration, deregistration or the button on the right.'}
      >
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Grant ID, FCC ID, reason…" className="w-60 pl-7" aria-label="Search grants" />
        </div>
        <FollowedOnly checked={onlyFollowed} onChange={setOnlyFollowed} />
        <Segmented value={view} onChange={setView} label="Grant view" options={[{ value: 'active', label: 'Active' }, { value: 'ended', label: 'Ended' }, { value: 'all', label: 'All' }]} />
        {view !== 'active' && (
          <Button icon={Trash2} variant="danger-ghost" loading={busy === 'purge'} onClick={async () => {
            if (await confirm({ title: 'Delete all ended grants?', body: 'Removes TERMINATED, RELINQUISHED, EXPIRED and DELETED grants from the database. Active grants are not touched.', confirm: 'Delete ended grants', danger: true })) {
              await run('purge', async () => {
                const x = await api.del<{ deleted: number }>('/api/grants/ended');
                return x;
              }, 'Ended grants deleted');
            }
          }}>Delete ended</Button>
        )}
      </PageHeader>

      <Module bodyClass="">
        {r.error && <div className="p-3"><ErrorNote>{r.error}</ErrorNote></div>}
        {r.loading && !r.data ? <SkeletonRows rows={6} cols={8} /> : rows.length === 0 ? (
          <Empty icon={Ticket} title={r.data?.length ? 'No grant matches this filter' : view === 'active' ? 'No active grants' : 'No ended grants'} className={cx(r.data?.length ? '' : 'py-14')}>
            {!r.data?.length && view === 'active' ? 'A grant appears when a registered CBSD sends a grant request the SAS accepts.' : null}
          </Empty>
        ) : (
          <GrantTable grants={rows} marks={marks} onAck={ack} />
        )}
      </Module>
    </div>
  );
}
