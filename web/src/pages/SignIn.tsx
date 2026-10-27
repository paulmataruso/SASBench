import { useEffect, useRef, useState } from 'react';
import { LogIn } from 'lucide-react';
import { api } from '../lib/api';
import { RackMark } from '../components/brand';
import { Button, ErrorNote, Field, Input, Note } from '../components/ui';

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
        <form
          className="space-y-4 rounded-b border border-line bg-panel px-5 pb-5 pt-4 shadow-panel"
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
        <div className="mt-3 px-1 text-xs text-ink-3">
          <p>Forgot the password? An administrator can set a new one under Users, or on the SAS host run:</p>
          <p className="mt-1 select-all break-all font-mono text-ink-2">node server/src/tools/reset-password.ts admin</p>
        </div>
      </div>
    </main>
  );
}
