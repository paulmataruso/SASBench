import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePref } from './live';

// "Follow" one CBSD (the radio on the bench): it stays highlighted on every page and the
// wire log / grants / events can be narrowed to it with one click.

interface FollowApi {
  followed: string | null;
  setFollowed: (id: string | null) => void;
}

const FollowCtx = createContext<FollowApi>({ followed: null, setFollowed: () => {} });

export function FollowProvider({ children }: { children: ReactNode }) {
  const [followed, setFollowed] = usePref<string | null>('followed', null);
  return <FollowCtx.Provider value={{ followed, setFollowed }}>{children}</FollowCtx.Provider>;
}

export function useFollow() {
  return useContext(FollowCtx);
}

/**
 * Rows whose signature (e.g. grant state) changed since the page loaded keep a marker until
 * the operator acknowledges them (hover / open). The first snapshot never produces marks.
 */
export function useChangeMarks<T>(items: T[] | undefined, key: (t: T) => string, sig: (t: T) => string, scope = '') {
  const seen = useRef<Map<string, string> | null>(null);
  const [marks, setMarks] = useState<Record<string, string>>({});
  // A new scope (e.g. another filter) starts a fresh baseline instead of marking every row as new.
  useEffect(() => {
    seen.current = null;
    setMarks({});
  }, [scope]);
  useEffect(() => {
    if (!items) return;
    const prev = seen.current;
    const next = new Map<string, string>();
    const add: Record<string, string> = {};
    for (const it of items) {
      const k = key(it);
      const s = sig(it);
      next.set(k, s);
      if (prev && prev.get(k) !== s) add[k] = prev.has(k) ? `${prev.get(k)} → ${s}` : 'new';
    }
    seen.current = next;
    if (Object.keys(add).length) setMarks((m) => ({ ...m, ...add }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  const ack = useCallback((k: string) => setMarks((m) => {
    if (!(k in m)) return m;
    const { [k]: _drop, ...rest } = m;
    return rest;
  }), []);
  const ackAll = useCallback(() => setMarks({}), []);
  return { marks, ack, ackAll };
}
