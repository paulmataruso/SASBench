import { useState } from 'react';
import { KeyRound, LogOut, Save, Trash2, UserPlus, Users as UsersIcon } from 'lucide-react';
import { api } from '../lib/api';
import { useResource } from '../lib/live';
import { Link } from '../lib/router';
import { ago, clock } from '../lib/format';
import { ROLE_INFO, ROLE_LABEL, useAuth, type Role, type User } from '../lib/auth';
import {
  Button, Drawer, Empty, ErrorNote, Field, Input, Led, Module, Note, PageHeader, Readout, Select, SkeletonRows, Switch, Tag, TwoUp,
  useAction, useConfirm, type Tone,
} from '../components/ui';

// User accounts (admins only): add, change role, enable or disable, set a password, sign out
// everywhere, delete. Backed by /api/v1/users.

interface Session { createdAt: number; lastSeenAt: number; expiresAt: number; addr: string | null; userAgent: string | null; current: boolean }

const ROLES: Role[] = ['admin', 'operator', 'viewer'];
const ROLE_TONE: Record<Role, Tone> = { admin: 'sel', operator: 'info', viewer: 'off' };
const MIN_PASSWORD = 8;

export function RoleTag({ role }: { role: Role }) {
  return <Tag tone={ROLE_TONE[role]} title={ROLE_INFO[role]}>{ROLE_LABEL[role]}</Tag>;
}

function RoleSelect({ value, onChange, disabled }: { value: Role; onChange: (r: Role) => void; disabled?: boolean }) {
  return (
    <Field label="Role" hint={ROLE_INFO[value]}>
      <Select value={value} onChange={(e) => onChange(e.target.value as Role)} disabled={disabled} className="w-full">
        {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
      </Select>
    </Field>
  );
}

/** Password and confirmation; returns the problem, if any, for the caller to show. */
function passwordProblem(pw: string, again: string): string | null {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw !== again) return 'The two passwords differ.';
  return null;
}

export function UsersPage() {
  const { me } = useAuth();
  const r = useResource<{ items: User[] }>('/api/v1/users', ['users']);
  const [editing, setEditing] = useState<number | null>(null);
  const users = r.data?.items;
  const edited = users?.find((u) => u.id === editing) ?? null;
  const admins = users?.filter((u) => u.role === 'admin' && u.enabled).length ?? 0;

  return (
    <div>
      <PageHeader title="Users" sub="Who can sign in to this console and the REST API, and what they may do. API keys act as the user who owns them." />
      <TwoUp
        form={<AddUser onAdded={() => void r.reload()} />}
        list={
          <Module title="Accounts" meta={users ? `${users.length} user${users.length === 1 ? '' : 's'}` : undefined} bodyClass="p-0">
            {r.error && !users && <div className="p-3"><ErrorNote>{r.error}</ErrorNote></div>}
            {!users ? <SkeletonRows rows={3} cols={5} /> : !users.length ? (
              <Empty icon={UsersIcon} title="No users">Add one with the form.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="dtable">
                  <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last sign-in</th><th /></tr></thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id} aria-selected={u.id === editing} className="cursor-pointer" onClick={() => setEditing(u.id)}>
                        <td className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-ink">{u.displayName ?? u.username}</span>
                            {u.id === me.user?.id && <Tag tone="sel">You</Tag>}
                            {u.defaultPassword && <Tag tone="warn" title="Still has the default password">Default password</Tag>}
                          </div>
                          {u.displayName && <div className="font-mono text-xs text-ink-3">{u.username}</div>}
                        </td>
                        <td><RoleTag role={u.role} /></td>
                        <td>
                          <span className="inline-flex items-center gap-1.5 text-ink-2">
                            <Led c={u.enabled ? 'ok' : 'off'} />{u.enabled ? 'Enabled' : 'Disabled'}
                          </span>
                        </td>
                        <td className="whitespace-nowrap text-ink-2">
                          <span title={u.lastLoginAt ? clock(u.lastLoginAt, true) : undefined}>{ago(u.lastLoginAt)}</span>
                          {u.lastLoginAddr && <span className="ml-1.5 font-mono text-xs text-ink-3">{u.lastLoginAddr}</span>}
                        </td>
                        <td className="w-16 text-right">
                          <Button size="sm" onClick={(e) => { e.stopPropagation(); setEditing(u.id); }} aria-label={`Edit ${u.username}`}>Edit</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Module>
        }
      />
      {edited && <EditUser key={edited.id} user={edited} self={edited.id === me.user?.id} lastAdmin={edited.role === 'admin' && edited.enabled && admins <= 1}
        onClose={() => setEditing(null)} onChanged={() => void r.reload()} />}
    </div>
  );
}

function AddUser({ onAdded }: { onAdded: () => void }) {
  const { run, busy } = useAction();
  const blank = { username: '', displayName: '', role: 'operator' as Role, password: '', again: '' };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState<Record<string, string>>({});

  const add = async () => {
    const e: Record<string, string> = {};
    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(f.username)) e.username = 'Use 1–64 letters, digits and . _ @ - (no spaces).';
    const pw = passwordProblem(f.password, f.again);
    if (pw) e[f.password.length < MIN_PASSWORD ? 'password' : 'again'] = pw;
    setErr(e);
    if (Object.keys(e).length) return;
    const u = await run('add', () => api.post<User>('/api/v1/users', {
      username: f.username, displayName: f.displayName.trim() || null, role: f.role, password: f.password,
    }), `User ${f.username} added`);
    if (u) {
      setF(blank);
      onAdded();
    }
  };

  return (
    <Module title="Add user">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void add(); }} autoComplete="off">
        <Field label="User name" error={err.username} hint="Used to sign in. Not case-sensitive.">
          <Input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} className="w-full font-mono" autoCapitalize="none" spellCheck={false} aria-invalid={!!err.username} />
        </Field>
        <Field label="Display name" hint="Optional">
          <Input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} className="w-full" />
        </Field>
        <RoleSelect value={f.role} onChange={(role) => setF({ ...f, role })} />
        <Field label="Password" error={err.password} hint={`At least ${MIN_PASSWORD} characters. Tell the user; they can change it after signing in.`}>
          <Input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} className="w-full" aria-invalid={!!err.password} />
        </Field>
        <Field label="Password again" error={err.again}>
          <Input type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} className="w-full" aria-invalid={!!err.again} />
        </Field>
        <Button type="submit" variant="primary" icon={UserPlus} loading={busy === 'add'}>Add user</Button>
      </form>
    </Module>
  );
}

function EditUser({ user, self, lastAdmin, onClose, onChanged }: {
  user: User; self: boolean; lastAdmin: boolean; onClose: () => void; onChanged: () => void;
}) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const { refresh } = useAuth();
  const [f, setF] = useState({ displayName: user.displayName ?? '', role: user.role, enabled: user.enabled });
  const [pw, setPw] = useState({ password: '', again: '', err: null as string | null });
  const sessions = useResource<{ items: Session[] }>(`/api/v1/users/${user.id}/sessions`, ['users']);
  const path = `/api/v1/users/${user.id}`;
  const dirty = f.displayName !== (user.displayName ?? '') || f.role !== user.role || f.enabled !== user.enabled;
  const losesAccess = f.role !== user.role || (!f.enabled && user.enabled);

  const save = async () => {
    if (losesAccess && !self && !(await confirm({
      title: `Change ${user.username}?`,
      body: 'Their console sessions end; their API keys follow the new role straight away.',
      confirm: 'Save changes',
    }))) return;
    const ok = await run('save', () => api.patch(path, {
      ...(f.displayName !== (user.displayName ?? '') ? { displayName: f.displayName.trim() || null } : {}),
      ...(f.role !== user.role ? { role: f.role } : {}),
      ...(f.enabled !== user.enabled ? { enabled: f.enabled } : {}),
    }), 'Changes saved');
    if (ok) {
      onChanged();
      if (self) void refresh(); // your own role may have changed
    }
  };

  const setPassword = async () => {
    const problem = passwordProblem(pw.password, pw.again);
    if (problem) return setPw({ ...pw, err: problem });
    const ok = await run('password', () => api.patch(path, { password: pw.password }),
      self ? 'Password set. Your other sessions were signed out.' : `Password set. ${user.username} was signed out everywhere.`);
    if (ok) {
      setPw({ password: '', again: '', err: null });
      onChanged();
      if (self) void refresh();
    }
  };

  const signOutAll = async () => {
    const r = await run('signout', () => api.del<{ revoked: number }>(`${path}/sessions`));
    if (r) {
      void sessions.reload();
      onChanged();
    }
  };

  const remove = async () => {
    if (!(await confirm({
      title: `Delete ${user.username}?`,
      body: 'The account, its sessions and all of its API keys are deleted. This cannot be undone.',
      confirm: 'Delete user', danger: true,
    }))) return;
    const ok = await run('delete', () => api.del(path), `User ${user.username} deleted`);
    if (ok !== undefined) {
      onClose();
      onChanged();
    }
  };

  const live = sessions.data?.items ?? [];
  return (
    <Drawer open onClose={onClose} title={<span>{user.displayName ?? user.username} <span className="ml-1 font-mono text-sm font-normal text-ink-3">{user.username}</span></span>} width={560}>
      <div className="space-y-5 p-4">
        <Readout rows={[
          ['Created', clock(user.createdAt, true)],
          ['Password changed', <span key="p">{ago(user.passwordChangedAt)}{user.defaultPassword && <Tag tone="warn" className="ml-2">Default password</Tag>}</span>],
          ['Last sign-in', user.lastLoginAt ? `${ago(user.lastLoginAt)}${user.lastLoginAddr ? ` from ${user.lastLoginAddr}` : ''}` : 'never'],
          ['API keys', <Link key="k" to="/api-keys" className="text-sel-ink underline">Manage on API keys</Link>],
        ]} />

        <section className="space-y-3 border-t border-line pt-4">
          <h3 className="silk text-xs text-ink-2">Account</h3>
          <Field label="Display name">
            <Input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} className="w-full" />
          </Field>
          <RoleSelect value={f.role} onChange={(role) => setF({ ...f, role })} disabled={lastAdmin} />
          <Switch checked={f.enabled} onChange={(enabled) => setF({ ...f, enabled })} disabled={lastAdmin || self} label="Enabled"
            description={self ? 'You cannot disable your own account.' : 'A disabled user cannot sign in, and their API keys stop working until enabled again.'} />
          {lastAdmin && <Note tone="info">This is the only enabled admin. Make another user an admin before changing this account's role or disabling it.</Note>}
          <Button variant="primary" icon={Save} disabled={!dirty} loading={busy === 'save'} onClick={save}>Save changes</Button>
        </section>

        <section className="space-y-3 border-t border-line pt-4">
          <h3 className="silk text-xs text-ink-2">Set a new password</h3>
          <p className="text-sm text-ink-2">{self ? 'Your other sessions end.' : `${user.username} is signed out everywhere and must use the new password. Their API keys keep working.`}</p>
          <form className="space-y-3" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void setPassword(); }}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="New password" error={pw.err}>
                <Input type="password" autoComplete="new-password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value, err: null })} className="w-full" aria-invalid={!!pw.err} />
              </Field>
              <Field label="Again">
                <Input type="password" autoComplete="new-password" value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value, err: null })} className="w-full" />
              </Field>
            </div>
            <Button type="submit" icon={KeyRound} disabled={!pw.password} loading={busy === 'password'}>Set password</Button>
          </form>
        </section>

        <section className="space-y-3 border-t border-line pt-4">
          <div className="flex items-center gap-3">
            <h3 className="silk text-xs text-ink-2">Console sessions</h3>
            <Button size="sm" icon={LogOut} className="ml-auto" disabled={!live.some((s) => !s.current)} loading={busy === 'signout'} onClick={signOutAll}>
              Sign out everywhere
            </Button>
          </div>
          {!sessions.data ? <SkeletonRows rows={2} cols={3} /> : !live.length ? (
            <p className="text-sm text-ink-3">Not signed in anywhere. Scripts using a password or an API key do not open sessions.</p>
          ) : (
            <ul className="divide-y divide-line rounded border border-line">
              {live.map((s, i) => (
                <li key={i} className="flex items-start gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-ink">{s.addr ?? 'unknown address'}</span>
                      {s.current && <Tag tone="sel">This session</Tag>}
                    </div>
                    <div className="truncate text-xs text-ink-3" title={s.userAgent ?? undefined}>{browserOf(s.userAgent)}</div>
                  </div>
                  <div className="text-right text-xs text-ink-3">
                    <div>active {ago(s.lastSeenAt)}</div>
                    <div>since {clock(s.createdAt, true)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {!self && (
          <section className="space-y-2 border-t border-line pt-4">
            <h3 className="silk text-xs text-bad-ink">Delete user</h3>
            <p className="text-sm text-ink-2">Deletes the account with its sessions and API keys.</p>
            <Button variant="danger" icon={Trash2} disabled={lastAdmin} loading={busy === 'delete'} onClick={remove}>Delete {user.username}</Button>
          </section>
        )}
      </div>
    </Drawer>
  );
}

/** "Firefox on Linux"-style summary of a User-Agent header. */
function browserOf(ua: string | null): string {
  if (!ua) return 'Unknown browser';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl\//.test(ua) ? 'curl' : null;
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  return browser ? `${browser}${os ? ` on ${os}` : ''}` : ua.slice(0, 80);
}
