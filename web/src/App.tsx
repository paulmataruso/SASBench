import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AudioLines, BookUser, Crosshair, History, LayoutDashboard, Menu, Monitor, Moon, RadioTower, ScrollText,
  Settings2, ShieldCheck, SquareTerminal, Sun, Ticket, X, Zap, type LucideIcon,
} from 'lucide-react';
import { RouterProvider, Link, useLocation } from './lib/router';
import { LiveProvider, useLive, useResource } from './lib/live';
import { FollowProvider, useFollow } from './lib/follow';
import { StatusProvider, useStatus, PROFILE_LABEL } from './lib/status';
import { ConfirmProvider, ToastProvider, Led, Segmented, Tag, cx } from './components/ui';
import { cbsdLabel, setPatchOrder } from './lib/format';
import type { Cbsd } from './lib/types';
import { OverviewPage } from './pages/Overview';
import { CbsdsPage } from './pages/Cbsds';
import { CbsdDetailPage } from './pages/CbsdDetail';
import { GrantsPage } from './pages/Grants';
import { SpectrumPage } from './pages/Spectrum';
import { CertificatesPage } from './pages/Certificates';
import { RegistryPage } from './pages/Registry';
import { FaultsPage } from './pages/Faults';
import { MessagesPage } from './pages/Messages';
import { EventsPage } from './pages/Events';
import { ConsolePage } from './pages/Console';
import { SettingsPage } from './pages/Settings';

export function App() {
  return (
    <RouterProvider>
      <LiveProvider>
        <StatusProvider>
          <FollowProvider>
            <ToastProvider>
              <ConfirmProvider>
                <Shell />
              </ConfirmProvider>
            </ToastProvider>
          </FollowProvider>
        </StatusProvider>
      </LiveProvider>
    </RouterProvider>
  );
}

interface NavItem { to: string; label: string; icon: LucideIcon; badge?: (s: ReturnType<typeof useStatus>['data']) => ReactNode }

const NAV: Array<{ group: string; items: NavItem[] }> = [
  {
    group: 'Operate',
    items: [
      { to: '/', label: 'Overview', icon: LayoutDashboard },
      { to: '/cbsds', label: 'CBSDs', icon: RadioTower, badge: (s) => s?.counts.cbsdsTotal || null },
      { to: '/grants', label: 'Grants', icon: Ticket, badge: (s) => s?.counts.grantsByState.AUTHORIZED || null },
      { to: '/spectrum', label: 'Spectrum', icon: AudioLines, badge: (s) => (s?.counts.activeProtections ? <span className="text-warn">{s.counts.activeProtections}</span> : null) },
    ],
  },
  {
    group: 'Diagnose',
    items: [
      { to: '/messages', label: 'Wire log', icon: ScrollText },
      { to: '/events', label: 'Events', icon: History },
      { to: '/console', label: 'Request console', icon: SquareTerminal },
      { to: '/faults', label: 'Fault injection', icon: Zap, badge: (s) => (s?.counts.faultRules ? <span className="text-warn">{s.counts.faultRules} armed</span> : null) },
    ],
  },
  {
    group: 'Configure',
    items: [
      { to: '/certificates', label: 'Certificates', icon: ShieldCheck },
      { to: '/registry', label: 'Registry', icon: BookUser },
      { to: '/settings', label: 'Settings', icon: Settings2 },
    ],
  },
];

function route(path: string): ReactNode {
  if (path === '/') return <OverviewPage />;
  if (path === '/cbsds') return <CbsdsPage />;
  if (path.startsWith('/cbsds/')) return <CbsdDetailPage id={decodeURIComponent(path.slice(7))} />;
  if (path === '/grants') return <GrantsPage />;
  if (path === '/spectrum') return <SpectrumPage />;
  if (path === '/certificates') return <CertificatesPage />;
  if (path === '/registry') return <RegistryPage />;
  if (path === '/faults') return <FaultsPage />;
  if (path === '/messages') return <MessagesPage />;
  if (path === '/events') return <EventsPage />;
  if (path === '/console') return <ConsolePage />;
  if (path === '/settings') return <SettingsPage />;
  return (
    <div className="py-16 text-center">
      <p className="text-lg font-semibold">No page at {path}</p>
      <Link to="/" className="mt-2 inline-block text-sel-ink underline">Back to the overview</Link>
    </div>
  );
}

function Shell() {
  const { path } = useLocation();
  const [menu, setMenu] = useState(false);
  // Identity colours follow registration order; recomputed before the pages render.
  const cbsds = useResource<Cbsd[]>('/api/cbsds', ['cbsds']);
  useMemo(() => {
    if (cbsds.data) setPatchOrder([...cbsds.data].sort((a, b) => a.createdAt - b.createdAt).map((c) => c.cbsdId));
  }, [cbsds.data]);
  useEffect(() => setMenu(false), [path]);
  const title = NAV.flatMap((g) => g.items).find((i) => (i.to === '/' ? path === '/' : path.startsWith(i.to)))?.label ?? 'CBRS Lab SAS';
  useEffect(() => {
    document.title = `${title} · CBRS Lab SAS`;
  }, [title]);

  return (
    <div className="flex h-dvh overflow-hidden">
      <Rail className="hidden md:flex" />
      {menu && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div className="absolute inset-0 bg-rail/50" onClick={() => setMenu(false)} aria-hidden />
          <Rail className="drawer-in relative flex w-[240px]" expanded onClose={() => setMenu(false)} />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenu={() => setMenu(true)} />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1680px] p-4 lg:px-6 lg:py-5">{route(path)}</div>
        </main>
      </div>
    </div>
  );
}

function Rail({ className, expanded, onClose }: { className?: string; expanded?: boolean; onClose?: () => void }) {
  const { path } = useLocation();
  const { data: s } = useStatus();
  const l = s?.listeners;
  const full = expanded ? '' : 'hidden lg:inline';
  return (
    <nav aria-label="Main" className={cx('h-full flex-none flex-col bg-rail text-rail-fg', expanded ? '' : 'w-14 lg:w-[216px]', className)}>
      <div className="flex h-12 items-center gap-2.5 border-b border-rail-3 px-[15px]">
        <RackMark />
        <span className={cx('whitespace-nowrap text-md font-semibold tracking-[-0.01em] text-white', full)}>CBRS Lab SAS</span>
        {onClose && (
          <button type="button" onClick={onClose} className="ml-auto text-rail-mute hover:text-white" aria-label="Close menu">
            <X className="size-4" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {NAV.map((g) => (
          <div key={g.group} className="mb-2">
            <div className={cx('px-[18px] pb-1 pt-2 font-label text-2xs font-semibold uppercase tracking-[0.12em] text-rail-mute', full)}>{g.group}</div>
            <div className={cx('mx-3 my-1 border-t border-rail-3', expanded ? 'hidden' : 'lg:hidden')} />
            <ul>
              {g.items.map((it) => {
                const active = it.to === '/' ? path === '/' : path.startsWith(it.to);
                const badge = it.badge?.(s);
                return (
                  <li key={it.to} className="px-2">
                    <Link
                      to={it.to}
                      title={it.label}
                      aria-current={active ? 'page' : undefined}
                      className={cx(
                        'group flex h-8 items-center gap-2.5 rounded px-2.5 text-base transition-colors duration-150',
                        active ? 'bg-rail-3 text-white' : 'text-rail-fg/80 hover:bg-rail-2 hover:text-white',
                      )}
                    >
                      <it.icon className={cx('size-4 flex-none', active ? 'text-rail-sel' : 'text-rail-mute group-hover:text-rail-fg')} strokeWidth={1.75} aria-hidden />
                      <span className={cx('truncate', full)}>{it.label}</span>
                      {badge ? <span className={cx('num ml-auto text-xs text-rail-mute', full)}>{badge}</span> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-rail-3 px-[18px] py-3">
        <div className={cx('space-y-1.5', expanded ? '' : 'hidden lg:block')}>
          <ListenerLine label="HTTPS" on={l?.https.enabled} up={l?.https.listening} err={l?.https.error} port={l?.https.port} />
          <ListenerLine label="HTTP" on={l?.http.enabled} up={l?.http.listening} err={l?.http.error} port={l?.http.port} />
          <div className="pt-1 font-mono text-2xs text-rail-mute">v{s?.version ?? '…'} · {s?.hostname ?? ''}</div>
        </div>
        <div className={cx('flex flex-col items-center gap-2', expanded ? 'hidden' : 'lg:hidden')}>
          <Led c={!l?.https.enabled ? 'off' : l.https.listening ? 'ok' : 'bad'} title={`HTTPS :${l?.https.port ?? ''}`} />
          <Led c={!l?.http.enabled ? 'off' : l.http.listening ? 'ok' : 'bad'} title={`HTTP :${l?.http.port ?? ''}`} />
        </div>
      </div>
    </nav>
  );
}

function ListenerLine({ label, on, up, err, port }: { label: string; on?: boolean; up?: boolean; err?: string | null; port?: number }) {
  return (
    <div className="flex items-center gap-2 text-xs" title={err ?? undefined}>
      <Led c={!on ? 'off' : up ? 'ok' : 'bad'} title={!on ? 'disabled' : up ? 'listening' : 'down'} />
      <span className="font-label font-semibold uppercase tracking-[0.09em] text-rail-mute">{label}</span>
      <span className="num ml-auto font-mono text-rail-fg/90">{on ? `:${port}` : 'off'}</span>
    </div>
  );
}

function RackMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-6 flex-none" aria-hidden>
      <rect x="2" y="3" width="20" height="18" rx="2.5" fill="rgb(var(--rail-3))" />
      <rect x="4.5" y="6" width="15" height="4" rx="1" fill="rgb(var(--rail))" />
      <rect x="4.5" y="12" width="15" height="4" rx="1" fill="rgb(var(--rail))" />
      <circle cx="7" cy="8" r="1.1" fill="rgb(var(--ok))" />
      <circle cx="10" cy="8" r="1.1" fill="rgb(var(--ok))" />
      <circle cx="7" cy="14" r="1.1" fill="rgb(var(--warn))" />
    </svg>
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const { connected } = useLive();
  const { data: s } = useStatus();
  const { followed, setFollowed } = useFollow();
  const profile = s?.profile ? PROFILE_LABEL[s.profile] ?? s.profile : 'Custom settings';
  return (
    <header className="flex h-12 flex-none items-center gap-3 border-b border-line bg-panel px-3 lg:px-6">
      <button type="button" onClick={onMenu} className="-ml-1 rounded p-1.5 text-ink-2 hover:bg-panel-3 md:hidden" aria-label="Open menu">
        <Menu className="size-5" />
      </button>
      {followed ? (
        <div className="flex min-w-0 items-center gap-1 rounded border border-sel/30 bg-sel-soft py-0.5 pl-2 pr-0.5 text-sm text-sel-ink">
          <Crosshair className="size-3.5 flex-none" aria-hidden />
          <span className="hidden sm:inline">Following</span>
          <Link to={`/cbsds/${encodeURIComponent(followed)}`} className="truncate font-mono text-xs font-medium underline-offset-2 hover:underline">{cbsdLabel(followed)}</Link>
          <button type="button" onClick={() => setFollowed(null)} className="rounded p-1 hover:bg-sel/10" aria-label="Stop following" title="Stop following">
            <X className="size-3" />
          </button>
        </div>
      ) : (
        <span className="hidden text-sm text-ink-3 sm:inline">Follow a CBSD from its page to track it across every view.</span>
      )}
      <div className="ml-auto flex items-center gap-2">
        {s && s.counts.faultRules > 0 && (
          <Link to="/faults" title="Fault rules alter what goes on the wire">
            <Tag tone="warn"><Zap className="size-3" aria-hidden />{s.counts.faultRules} fault rule{s.counts.faultRules > 1 ? 's' : ''} armed</Tag>
          </Link>
        )}
        <Link to="/settings" className="hidden sm:block" title="Settings profile">
          <Tag tone={s?.profile === 'winnforum' ? 'sel' : s?.profile === 'open' ? 'warn' : 'off'}>{profile}</Tag>
        </Link>
        <span className="flex items-center gap-1.5 pl-1 text-xs text-ink-3" title={connected ? 'Live updates connected' : 'Reconnecting to the server…'}>
          <Led c={connected ? 'ok' : 'bad'} />
          <span className="hidden sm:inline">{connected ? 'Live' : 'Offline'}</span>
        </span>
        <ThemeToggle />
      </div>
    </header>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<string>(() => {
    try {
      return localStorage.getItem('sas.theme') ?? 'system';
    } catch {
      return 'system';
    }
  });
  const apply = (t: string) => {
    setTheme(t);
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem('sas.theme', t);
    } catch { /* storage unavailable */ }
  };
  return (
    <Segmented
      size="sm"
      label="Theme"
      value={theme as 'system' | 'light' | 'dark'}
      onChange={apply}
      options={[
        { value: 'system', label: <Monitor className="size-3.5" aria-label="System theme" />, title: 'Follow system' },
        { value: 'light', label: <Sun className="size-3.5" aria-label="Light theme" />, title: 'Light' },
        { value: 'dark', label: <Moon className="size-3.5" aria-label="Dark theme" />, title: 'Dark' },
      ]}
    />
  );
}
