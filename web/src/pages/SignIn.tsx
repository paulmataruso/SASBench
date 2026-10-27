import { useEffect, useRef, useState } from 'react';
import { ChevronRight, LogIn } from 'lucide-react';
import { api } from '../lib/api';
import { RackMark } from '../components/brand';
import { Button, CopyButton, ErrorNote, Field, Input, Note } from '../components/ui';

/** The sign-in form, shown instead of the console until there is a session. */
export function SignInPage({ note, onSignedIn }: { note?: string; onSignedIn: () => Promise<void> }) {
  const [username, setUsername] = useState(() => {
    try {
      return localStorage.getItem('sas.lastUser') ?? '';
    } catch {
      return '';
    }
  });
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const userRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = 'Sign in · SASBench';
    (username ? pwRef : userRef).current?.focus();
    // Focus once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    if (!username.trim() || !password) {
      setError('Enter your user name and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { username: username.trim(), password });
      try {
        localStorage.setItem('sas.lastUser', username.trim());
      } catch { /* storage unavailable */ }
      await onSignedIn();
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setPassword('');
      pwRef.current?.focus();
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-ground px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="on-rail flex items-center gap-2.5 rounded-t border border-b-0 border-rail-3 bg-rail px-4 py-3">
          <RackMark />
          <span className="text-md font-semibold tracking-[-0.01em] text-white">SASBench</span>
          <span className="ml-auto font-label text-2xs font-semibold uppercase tracking-[0.12em] text-rail-mute">CBRS lab SAS</span>
        </div>
        <div className="rounded-b border border-line bg-panel shadow-panel">
          <form
            className="space-y-4 px-5 pb-5 pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <h1 className="text-lg font-semibold text-ink">Sign in</h1>
            {note && <Note tone="warn">{note}</Note>}
            <Field label="User name">
              <Input ref={userRef} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} className="w-full" />
            </Field>
            <Field label="Password">
              <Input ref={pwRef} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className="w-full" />
            </Field>
            {error && <ErrorNote>{error}</ErrorNote>}
            <Button type="submit" variant="primary" icon={LogIn} loading={busy} className="w-full">Sign in</Button>
          </form>
          <ForgotPassword username={username.trim()} />
        </div>
      </div>
    </main>
  );
}

/** How to get back in: an admin resets it, or the reset tool on the SAS host. */
function ForgotPassword({ username }: { username: string }) {
  // The command names the user typed above when it is a valid user name (all shell-safe characters).
  const user = /^[A-Za-z0-9._@][A-Za-z0-9._@-]{0,63}$/.test(username) ? username : 'admin';
  const command = `docker exec sasbench node server/src/tools/reset-password.ts ${user}`;
  return (
    <details className="group border-t border-line">
      <summary className="flex h-10 cursor-pointer list-none items-center gap-1.5 rounded-b px-5 focus-visible:outline-offset-[-2px] group-open:rounded-none text-sm text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 text-ink-3 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
        Forgot your password?
      </summary>
      <div className="space-y-3 px-5 pb-5 pt-1 text-sm text-ink-2">
        <p>An admin can set a new one for you on the <span className="font-medium text-ink">Users</span> page.</p>
        <div className="space-y-1.5">
          <p>No admin can sign in? On the SAS host, run:</p>
          <div className="flex items-start gap-1 rounded border border-line bg-panel-2 py-1 pl-2.5 pr-1">
            <code className="min-w-0 flex-1 py-1 font-mono text-xs text-ink [overflow-wrap:anywhere]">
              <span className="select-none text-ink-3">$ </span>{command}
            </code>
            <CopyButton text={command} label="Copy command" />
          </div>
        </div>
        <p className="text-xs text-ink-3">
          It prints a new password for <span className="font-mono">{user}</span>. On a source install, leave out <span className="font-mono">docker exec sasbench</span>.
        </p>
      </div>
    </details>
  );
}
