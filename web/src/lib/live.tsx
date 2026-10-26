import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import type { EventRow, MessageRow } from './types';

// Live connection to the server's SSE stream (/api/stream) and data hooks that refetch when
// the server reports a change to the topic they depend on.

type Listener<T> = (data: T) => void;

interface LiveApi {
  connected: boolean;
  onMessage: (fn: Listener<MessageRow>) => () => void;
  onEvent: (fn: Listener<EventRow>) => () => void;
  onChanged: (fn: Listener<string>) => () => void;
}

const LiveCtx = createContext<LiveApi | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const subs = useRef({ message: new Set<Listener<any>>(), event: new Set<Listener<any>>(), changed: new Set<Listener<any>>() });

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      es = new EventSource('/api/stream');
      es.onopen = () => {
        setConnected(true);
        // Anything may have changed while we were disconnected.
        for (const fn of subs.current.changed) fn('all');
      };
      es.onerror = () => {
        setConnected(false);
        if (es?.readyState === EventSource.CLOSED) {
          es.close();
          retry = setTimeout(open, 3000);
        }
      };
      es.addEventListener('message', (e) => {
        const d = JSON.parse((e as MessageEvent).data);
        for (const fn of subs.current.message) fn(d);
      });
      es.addEventListener('event', (e) => {
        const d = JSON.parse((e as MessageEvent).data);
        for (const fn of subs.current.event) fn(d);
      });
      es.addEventListener('changed', (e) => {
        const d = JSON.parse((e as MessageEvent).data);
        for (const fn of subs.current.changed) fn(d.what);
      });
    };
    open();
    return () => {
      clearTimeout(retry);
      es?.close();
    };
  }, []);

  const sub = useCallback((kind: 'message' | 'event' | 'changed') => (fn: Listener<any>) => {
    subs.current[kind].add(fn);
    return () => {
      subs.current[kind].delete(fn);
    };
  }, []);

  const value = useRef<LiveApi>({ connected: false, onMessage: sub('message'), onEvent: sub('event'), onChanged: sub('changed') });
  value.current = { ...value.current, connected };
  return <LiveCtx.Provider value={value.current}>{children}</LiveCtx.Provider>;
}

export function useLive(): LiveApi {
  const v = useContext(LiveCtx);
  if (!v) throw new Error('LiveProvider missing');
  return v;
}

export function useLiveMessages(fn: Listener<MessageRow>) {
  const { onMessage } = useLive();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => onMessage((m) => ref.current(m)), [onMessage]);
}

export function useLiveEvents(fn: Listener<EventRow>) {
  const { onEvent } = useLive();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => onEvent((m) => ref.current(m)), [onEvent]);
}

export interface Resource<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (d: T) => void;
}

/**
 * GET `path` and keep it fresh: refetch whenever the server announces a change to one of `topics`
 * (throttled to one request per `throttleMs`). Pass path = null to skip.
 */
export function useResource<T = any>(path: string | null, topics: string[] = [], throttleMs = 800): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { onChanged } = useLive();
  const seq = useRef(0);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    if (!path) return;
    const my = ++seq.current;
    last.current = Date.now();
    try {
      const d = await api.get<T>(path);
      if (my === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e: any) {
      if (my === seq.current) setError(e.message);
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const topicKey = topics.join(',');
  useEffect(() => {
    if (!topicKey) return;
    const set = new Set(topicKey.split(','));
    return onChanged((what) => {
      if (what !== 'all' && !set.has(what)) return;
      const wait = Math.max(0, throttleMs - (Date.now() - last.current));
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void load(), wait);
    });
  }, [topicKey, onChanged, load, throttleMs]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return { data, error, loading, reload: load, setData };
}

/** Shared 1 Hz clock for countdowns and "x ago" labels. */
const tickSubs = new Set<(n: number) => void>();
let tickTimer: ReturnType<typeof setInterval> | undefined;
export function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    tickSubs.add(setNow);
    if (!tickTimer) tickTimer = setInterval(() => {
      const n = Date.now();
      for (const fn of tickSubs) fn(n);
    }, 1000);
    return () => {
      tickSubs.delete(setNow);
      if (!tickSubs.size) {
        clearInterval(tickTimer);
        tickTimer = undefined;
      }
    };
  }, []);
  return now;
}

/** Persisted per-browser preference (localStorage, failure-tolerant). */
export function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`sas.${key}`);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback((nv: T) => {
    setV(nv);
    try {
      localStorage.setItem(`sas.${key}`, JSON.stringify(nv));
    } catch { /* storage unavailable */ }
  }, [key]);
  return [v, set];
}
