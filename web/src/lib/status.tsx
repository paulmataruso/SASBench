import { createContext, useContext, type ReactNode } from 'react';
import { useResource, type Resource } from './live';
import type { Status } from './types';

// Server status (listeners, counts, profile) shared by the shell and the overview.

const StatusCtx = createContext<Resource<Status> | null>(null);

export function StatusProvider({ children }: { children: ReactNode }) {
  const r = useResource<Status>('/api/status', ['settings', 'listeners', 'status', 'cbsds', 'grants', 'daily', 'faults', 'spectrum', 'certs'], 1500);
  return <StatusCtx.Provider value={r}>{children}</StatusCtx.Provider>;
}

export function useStatus(): Resource<Status> {
  const v = useContext(StatusCtx);
  if (!v) throw new Error('StatusProvider missing');
  return v;
}

export const PROFILE_LABEL: Record<string, string> = { lab: 'Lab profile', winnforum: 'WInnForum strict', open: 'Open (no security)' };

/** SAS URLs with LAN addresses first: radios reach the SAS over the network, not via loopback. */
export function lanFirst(urls: string[]): string[] {
  const loop = (u: string) => /\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(u);
  return [...urls].sort((a, b) => Number(loop(a)) - Number(loop(b)));
}
