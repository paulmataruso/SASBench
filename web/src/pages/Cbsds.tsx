import { useMemo, useState } from 'react';
import { Check, RadioTower, Search } from 'lucide-react';
import { api } from '../lib/api';
import { useResource } from '../lib/live';
import { useChangeMarks } from '../lib/follow';
import type { Cbsd, Grant } from '../lib/types';
import { CbsdRack, groupGrants, useHeartbeatPulses } from '../components/rack';
import { Button, Empty, ErrorNote, Input, Module, Note, PageHeader, Segmented, SkeletonRows, useAction } from '../components/ui';

type Filter = 'all' | 'REGISTERED' | 'PENDING' | 'UNREGISTERED';

export function CbsdsPage() {
  const cbsds = useResource<Cbsd[]>('/api/cbsds', ['cbsds', 'grants']);
  const grants = useResource<Grant[]>('/api/grants?state=GRANTED,AUTHORIZED', ['grants', 'cbsds']);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const { run, busy } = useAction();
  const pulses = useHeartbeatPulses();
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
          <CbsdRack cbsds={rows} grants={grouped} pulses={pulses} marks={marks} onAck={ack} detail />
        )}
      </Module>
    </div>
  );
}
