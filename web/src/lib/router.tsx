import { createContext, useContext, useEffect, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';

// Minimal history-API router; the server falls back to index.html for unknown paths.

interface Loc {
  path: string;
  query: URLSearchParams;
}

const RouterCtx = createContext<Loc>({ path: '/', query: new URLSearchParams() });

const read = (): Loc => ({ path: window.location.pathname.replace(/\/+$/, '') || '/', query: new URLSearchParams(window.location.search) });

export function navigate(to: string, replace = false) {
  if (to === window.location.pathname + window.location.search) return;
  if (replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  window.dispatchEvent(new Event('sas:navigate'));
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const on = () => setLoc(read());
    window.addEventListener('popstate', on);
    window.addEventListener('sas:navigate', on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('sas:navigate', on);
    };
  }, []);
  return <RouterCtx.Provider value={loc}>{children}</RouterCtx.Provider>;
}

export function useLocation(): Loc {
  return useContext(RouterCtx);
}

/** Update one query parameter in place (no history entry). */
export function setQuery(key: string, value: string | null) {
  const q = new URLSearchParams(window.location.search);
  if (value === null || value === '') q.delete(key);
  else q.set(key, value);
  const s = q.toString();
  navigate(window.location.pathname + (s ? `?${s}` : ''), true);
}

export function Link({ to, children, onClick, ...rest }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...rest}>{children}</a>;
}
