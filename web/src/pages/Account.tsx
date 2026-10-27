import { useState } from 'react';
import { KeyRound, LogOut } from 'lucide-react';
import { api } from '../lib/api';
import { Link } from '../lib/router';
import { ago, clock } from '../lib/format';
import { ROLE_INFO, useAuth } from '../lib/auth';
import { Button, Field, Input, Module, Note, PageHeader, Readout, TwoUp, useAction } from '../components/ui';
import { RoleTag } from './Users';

// The signed-in user's own account: details and password.

const MIN_PASSWORD = 8;

export function AccountPage() {
  const { me, refresh, signOut } = useAuth();
  const u = me.user;
  return (
    <div>
      <PageHeader title="Your account">
        {me.method === 'session' && <Button icon={LogOut} onClick={() => void signOut()}>Sign out</Button>}
      </PageHeader>
      {!u ? (
        <Note tone={me.method === 'open' ? 'warn' : 'info'} className="max-w-[80ch]">
          {me.method === 'open'
            ? 'Sign-in is switched off (SAS_AUTH=off): anyone who can reach this console has full access. Remove SAS_AUTH=off from the environment and restart to require accounts.'
            : `Signed in with the API key “${me.tokenName}”, which has no owner.`}
        </Note>
      ) : (
        <TwoUp
          form={me.method === 'token'
            ? <Module title="Password"><Note tone="info">Signed in with an API key; sign in with your password to change it.</Note></Module>
            : <ChangePassword defaultPassword={u.defaultPassword} onChanged={refresh} />}
          list={
            <Module title="Account">
              <Readout rows={[
                ['User name', <span key="u" className="font-mono">{u.username}</span>],
                ['Display name', u.displayName],
                ['Role', <span key="r" className="inline-flex flex-wrap items-center gap-2"><RoleTag role={u.role} /><span className="text-sm text-ink-3">{ROLE_INFO[u.role]}</span></span>],
                ['Signed in with', me.method === 'session' ? 'This browser (session)' : me.method === 'password' ? 'User name and password (HTTP Basic)' : `API key “${me.tokenName}”`],
                ['Last sign-in', u.lastLoginAt ? `${clock(u.lastLoginAt, true)}${u.lastLoginAddr ? ` from ${u.lastLoginAddr}` : ''}` : 'never'],
                ['Password changed', ago(u.passwordChangedAt)],
              ]} />
              <p className="mt-4 border-t border-line pt-3 text-sm text-ink-2">
                Scripts and other applications should use an <Link to="/api-keys" className="text-sel-ink underline">API key</Link> rather than your password.
              </p>
            </Module>
          }
        />
      )}
    </div>
  );
}

function ChangePassword({ defaultPassword, onChanged }: { defaultPassword: boolean; onChanged: () => Promise<void> }) {
  const { run, busy } = useAction();
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [err, setErr] = useState<{ field: 'current' | 'next' | 'again'; text: string } | null>(null);

  const submit = async () => {
    if (!f.current) return setErr({ field: 'current', text: 'Enter your current password.' });
    if (f.next.length < MIN_PASSWORD) return setErr({ field: 'next', text: `Use at least ${MIN_PASSWORD} characters.` });
    if (f.next === f.current) return setErr({ field: 'next', text: 'Choose a password different from the current one.' });
    if (f.next !== f.again) return setErr({ field: 'again', text: 'The two passwords differ.' });
    setErr(null);
    try {
      await api.post('/api/v1/auth/password', { currentPassword: f.current, newPassword: f.next });
    } catch (e: any) {
      // The API names the field: "currentPassword is not your current password".
      const text = String(e?.message ?? e);
      return setErr(/^currentPassword /.test(text) ? { field: 'current', text: 'This is not your current password.' } : { field: 'next', text: text.replace(/^newPassword /, '') });
    }
    await run('done', async () => {
      setF({ current: '', next: '', again: '' });
      await onChanged();
    }, 'Password changed. Your other sessions were signed out.');
  };

  return (
    <Module title="Change password">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {defaultPassword && <Note tone="warn">You are still using the default password. Anyone who knows it can sign in as you.</Note>}
        <Field label="Current password" error={err?.field === 'current' ? err.text : null}>
          <Input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} className="w-full" aria-invalid={err?.field === 'current'} />
        </Field>
        <Field label="New password" hint={`At least ${MIN_PASSWORD} characters.`} error={err?.field === 'next' ? err.text : null}>
          <Input type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} className="w-full" aria-invalid={err?.field === 'next'} />
        </Field>
        <Field label="New password again" error={err?.field === 'again' ? err.text : null}>
          <Input type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} className="w-full" aria-invalid={err?.field === 'again'} />
        </Field>
        <Button type="submit" variant="primary" icon={KeyRound} loading={busy === 'done'}>Change password</Button>
      </form>
    </Module>
  );
}
