import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, SIGNED_OUT_EVENT } from './api';
import { SignInPage } from '../pages/SignIn';

// Who is signed in. The console's data needs a user (the session cookie set by /api/auth/login);
// until there is one, the sign-in form replaces the whole app, so nothing behind it loads.

export type Role = 'admin' | 'operator' | 'viewer';

export interface User {
  id: number;
  username: string;
  displayName: string | null;
  role: Role;
  enabled: boolean;
  defaultPassword: boolean;
  createdAt: number;
  updatedAt: number;
  passwordChangedAt: number;
  lastLoginAt: number | null;
  lastLoginAddr: string | null;
}

export interface Me {
  /** session: signed in here; password: HTTP Basic; token: an API key; open: SAS_AUTH=off. */
  method: 'open' | 'session' | 'password' | 'token';
  role: Role;
  scope: 'read' | 'write';
  tokenName: string | null;
  user: User | null;
  authEnabled: boolean;
}

export const ROLE_LABEL: Record<Role, string> = { admin: 'Admin', operator: 'Operator', viewer: 'Viewer' };
export const ROLE_INFO: Record<Role, string> = {
  admin: 'Everything, including user accounts and every API key.',
  operator: 'Runs the SAS: settings, CBSDs, certificates, registry and faults. No user accounts.',
  viewer: 'Read-only. No private keys, backups or user accounts.',
};

interface AuthApi {
  me: Me;
  canWrite: boolean;
  isAdmin: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthCtx = createContext<AuthApi | null>(null);

type State = { s: 'loading' } | { s: 'out'; note?: string } | { s: 'in'; me: Me };

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ s: 'loading' });

  const refresh = useCallback(async () => {
    try {
      setState({ s: 'in', me: await api.get<Me>('/api/auth/me') });
    } catch (e) {
      setState({ s: 'out', note: e instanceof ApiError ? undefined : 'The SAS is not reachable. Check that it is running, then sign in.' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Any 401 from the console's data: the session ended (signed out elsewhere, password changed,
  // account disabled or expired).
  useEffect(() => {
    const on = () => setState((st) => (st.s === 'in' ? { s: 'out', note: 'Your session ended. Sign in again to continue.' } : st));
    window.addEventListener(SIGNED_OUT_EVENT, on);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, on);
  }, []);

  const signOut = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    setState({ s: 'out' });
  }, []);

  if (state.s === 'loading') return <div className="h-dvh bg-ground" aria-busy="true" />;
  if (state.s === 'out') return <SignInPage note={state.note} onSignedIn={refresh} />;
  const { me } = state;
  return (
    <AuthCtx.Provider value={{ me, canWrite: me.scope === 'write', isAdmin: me.role === 'admin' && me.scope === 'write', refresh, signOut }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth(): AuthApi {
  const v = useContext(AuthCtx);
  if (!v) throw new Error('AuthGate missing');
  return v;
}

/** "Display Name (username)" or the user name. */
export function userLabel(u: Pick<User, 'username' | 'displayName'>): string {
  return u.displayName ? `${u.displayName} (${u.username})` : u.username;
}
