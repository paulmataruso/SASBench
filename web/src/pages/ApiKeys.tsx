import { useState } from 'react';
import { KeyRound, Plus, Trash2, X } from 'lucide-react';
import { api } from '../lib/api';
import { useResource } from '../lib/live';
import { ago, clock, until } from '../lib/format';
import { userLabel, useAuth, type User } from '../lib/auth';
import {
  Button, CopyButton, Empty, ErrorNote, Field, Input, Module, Note, PageHeader, Segmented, Select, SkeletonRows, Tag, TwoUp,
  useAction, useConfirm,
} from '../components/ui';

// API keys for scripts and other applications: create (the secret is shown once), list, revoke.
// Everyone manages their own keys; admins see and revoke every key and can make keys for others.
// Backed by /api/v1/tokens.

interface ApiKey {
  id: string;
  name: string;
  scope: 'read' | 'write';
  prefix: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  lastUsedAddr: string | null;
  userId: number | null;
  username: string | null;
}

const EXPIRY = [
  ['', 'Never'],
  ['30', '30 days'],
  ['90', '90 days'],
  ['365', '1 year'],
] as const;

export function ApiKeysPage() {
  const { me, isAdmin } = useAuth();
  const keys = useResource<{ items: ApiKey[] }>('/api/v1/tokens', ['tokens']);
  const [created, setCreated] = useState<(ApiKey & { token: string }) | null>(null);
  const items = keys.data?.items;
  const viaKey = me.method === 'token';

  return (
    <div>
      <PageHeader
        title="API keys"
        sub={<>For scripts and other applications using the REST API (<a href="/api/v1/openapi.json" className="text-sel-ink underline" target="_blank" rel="noreferrer">OpenAPI document</a>). A key acts as the user who owns it, never with more access than that user has.</>}
      />
      <TwoUp
        form={
          <div className="space-y-4">
            {created ? <NewKey k={created} onDone={() => setCreated(null)} /> : null}
            {viaKey ? (
              <Module title="Create API key"><Note tone="info">Keys are created by signed-in users, not by other API keys.</Note></Module>
            ) : (
              <CreateKey onCreated={(k) => { setCreated(k); void keys.reload(); }} />
            )}
          </div>
        }
        list={
          <Module title={isAdmin ? 'All API keys' : 'Your API keys'} meta={items ? `${items.length} key${items.length === 1 ? '' : 's'}` : undefined} bodyClass="p-0">
            {keys.error && !items && <div className="p-3"><ErrorNote>{keys.error}</ErrorNote></div>}
            {!items ? <SkeletonRows rows={3} cols={6} /> : !items.length ? (
              <Empty icon={KeyRound} title="No API keys">Create one with the form, then send it as <span className="font-mono">Authorization: Bearer sasb_…</span></Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="dtable">
                  <thead>
                    <tr><th>Name</th>{isAdmin && <th>Owner</th>}<th>Access</th><th>Key</th><th>Last used</th><th>Expires</th><th /></tr>
                  </thead>
                  <tbody>
                    {items.map((k) => <KeyRow key={k.id} k={k} showOwner={isAdmin} mine={k.userId === me.user?.id} canRevoke={!viaKey} />)}
                  </tbody>
                </table>
              </div>
            )}
          </Module>
        }
      />
    </div>
  );
}

function KeyRow({ k, showOwner, mine, canRevoke }: { k: ApiKey; showOwner: boolean; mine: boolean; canRevoke: boolean }) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const expired = k.expiresAt !== null && k.expiresAt <= Date.now();
  const revoke = async () => {
    if (!(await confirm({
      title: `Revoke “${k.name}”?`,
      body: `Anything using ${k.prefix}… stops working immediately, and its open event streams end.`,
      confirm: 'Revoke key', danger: true,
    }))) return;
    await run('revoke', () => api.del(`/api/v1/tokens/${encodeURIComponent(k.id)}`), `API key “${k.name}” revoked`);
  };
  return (
    <tr>
      <td className="font-medium text-ink">{k.name}</td>
      {showOwner && (
        <td className="whitespace-nowrap text-ink-2">
          {k.username ?? <span className="text-ink-3" title="Created before user accounts existed">no owner</span>}
          {mine && <Tag tone="sel" className="ml-2">You</Tag>}
        </td>
      )}
      <td><Tag tone={k.scope === 'write' ? 'warn' : 'off'}>{k.scope === 'write' ? 'Read & write' : 'Read-only'}</Tag></td>
      <td className="font-mono text-xs text-ink-2">{k.prefix}…</td>
      <td className="whitespace-nowrap text-ink-2">
        <span title={k.lastUsedAt ? clock(k.lastUsedAt, true) : undefined}>{ago(k.lastUsedAt)}</span>
        {k.lastUsedAddr && <span className="ml-1.5 font-mono text-xs text-ink-3">{k.lastUsedAddr}</span>}
      </td>
      <td className="whitespace-nowrap">
        {k.expiresAt === null ? <span className="text-ink-3">never</span> : expired ? <Tag tone="bad">Expired</Tag> : (
          <span className="text-ink-2" title={clock(k.expiresAt, true)}>{until(k.expiresAt)}</span>
        )}
      </td>
      <td className="w-10 text-right">
        {canRevoke && <Button size="sm" variant="danger-ghost" icon={Trash2} loading={busy === 'revoke'} onClick={revoke} aria-label={`Revoke ${k.name}`} title="Revoke" />}
      </td>
    </tr>
  );
}

function CreateKey({ onCreated }: { onCreated: (k: ApiKey & { token: string }) => void }) {
  const { me, isAdmin, canWrite } = useAuth();
  const { run, busy } = useAction();
  const users = useResource<{ items: User[] }>(isAdmin ? '/api/v1/users' : null, ['users']);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'read' | 'write'>('read');
  const [days, setDays] = useState<string>('90');
  const [owner, setOwner] = useState<string>('');
  const [err, setErr] = useState<string | null>(null);
  const ownerUser = users.data?.items.find((u) => String(u.id) === owner);
  // A key never has more access than its owner: viewers get read-only keys.
  const writeAllowed = ownerUser ? ownerUser.role !== 'viewer' : canWrite;

  const create = async () => {
    if (!name.trim()) return setErr('Name the key after what will use it.');
    setErr(null);
    const k = await run('create', () => api.post<ApiKey & { token: string }>('/api/v1/tokens', {
      name: name.trim(),
      scope: writeAllowed ? scope : 'read',
      ...(days ? { expiresInDays: Number(days) } : {}),
      ...(owner ? { userId: Number(owner) } : {}),
    }));
    if (k) {
      setName('');
      onCreated(k);
    }
  };

  return (
    <Module title="Create API key">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <Field label="Name" error={err} hint="What will use it, e.g. “CI pipeline” or “Grafana”.">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} className="w-full" aria-invalid={!!err} />
        </Field>
        <Field label="Access" hint={writeAllowed ? (scope === 'write' ? 'Everything the owner may do.' : 'GET requests only; no private keys, backups or user accounts.') : 'Viewers can only have read-only keys.'}>
          <Segmented<'read' | 'write'>
            label="Access"
            value={writeAllowed ? scope : 'read'}
            onChange={(v) => writeAllowed && setScope(v)}
            options={[{ value: 'read', label: 'Read-only' }, { value: 'write', label: 'Read & write' }]}
          />
        </Field>
        <Field label="Expires">
          <Select value={days} onChange={(e) => setDays(e.target.value)} className="w-full">
            {EXPIRY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        {isAdmin && (
          <Field label="Owner" hint="Admins can create keys for other users, e.g. a service account.">
            <Select value={owner} onChange={(e) => setOwner(e.target.value)} className="w-full">
              <option value="">{me.user ? `${userLabel(me.user)} (you)` : 'You'}</option>
              {users.data?.items.filter((u) => u.id !== me.user?.id).map((u) => (
                <option key={u.id} value={u.id} disabled={!u.enabled}>{userLabel(u)}{u.enabled ? '' : ' (disabled)'}</option>
              ))}
            </Select>
          </Field>
        )}
        <Button type="submit" variant="primary" icon={Plus} loading={busy === 'create'}>Create key</Button>
      </form>
    </Module>
  );
}

function NewKey({ k, onDone }: { k: ApiKey & { token: string }; onDone: () => void }) {
  const curl = `curl -H "Authorization: Bearer ${k.token}" ${window.location.origin}/api/v1/status`;
  return (
    <Module
      title={`New key: ${k.name}`}
      actions={<Button size="sm" variant="ghost" icon={X} onClick={onDone} aria-label="Done" title="I have stored the key" />}
      className="border-ok/40"
    >
      <div className="space-y-3">
        <Note tone="ok">Copy the key now and store it somewhere safe. It is not shown again; only a hash is kept.</Note>
        <div className="flex items-center gap-1 rounded border border-line bg-panel-2 py-1 pl-3 pr-1">
          <span className="min-w-0 flex-1 break-all font-mono text-sm text-ink">{k.token}</span>
          <CopyButton text={k.token} label="Copy key" />
        </div>
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className="text-sm font-medium text-ink-2">Try it</span>
            <CopyButton text={curl} label="Copy command" className="ml-auto" />
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded border border-line bg-panel-2 p-2 font-mono text-xs text-ink-2">{curl}</pre>
        </div>
        <Button variant="primary" onClick={onDone}>Done</Button>
      </div>
    </Module>
  );
}
