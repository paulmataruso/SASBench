import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  AudioLines, BookUser, ChevronDown, Crosshair, History, KeyRound, LayoutDashboard, LogOut, Menu, Monitor, Moon, RadioTower, ScrollText,
  Settings2, ShieldCheck, SquareTerminal, Sun, Ticket, UserRound, Users, X, Zap, type LucideIcon,
} from 'lucide-react';
import { RouterProvider, Link, navigate, useLocation } from './lib/router';
import { AuthGate, ROLE_LABEL, useAuth } from './lib/auth';
import { LiveProvider, useLive, useResource } from './lib/live';
import { FollowProvider, useFollow } from './lib/follow';
import { StatusProvider, useStatus, PROFILE_LABEL } from './lib/status';
import { ConfirmProvider, ToastProvider, Led, Segmented, Select, Tag, cx, useModalFocus } from './components/ui';
import { CbsdName } from './components/rack';
import { RackMark } from './components/brand';
import { setCbsdNames, setPatchOrder } from './lib/format';
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
import { UsersPage } from './pages/Users';
import { ApiKeysPage } from './pages/ApiKeys';
import { AccountPage } from './pages/Account';

export function App() {
  return (
    <RouterProvider>
      <AuthGate>
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
      </AuthGate>
    </RouterProvider>
  );
}

interface NavItem { to: string; label: string; icon: LucideIcon; badge?: (s: ReturnType<typeof useStatus>['data']) => ReactNode; adminOnly?: boolean }

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
      { to: '/api-keys', label: 'API keys', icon: KeyRound },
      { to: '/users', label: 'Users', icon: Users, adminOnly: true },
    ],
  },
];

/** Pages reached from the account menu rather than the rail. */
const OTHER_TITLES: Record<string, string> = { '/account': 'Your account' };

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
  if (path === '/api-keys') return <ApiKeysPage />;
  if (path === '/users') return <UsersPage />;
  if (path === '/account') return <AccountPage />;
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
    if (!cbsds.data) return;
    setPatchOrder([...cbsds.data].sort((a, b) => a.createdAt - b.createdAt).map((c) => c.cbsdId));
    setCbsdNames(cbsds.data);
  }, [cbsds.data]);
  useEffect(() => setMenu(false), [path]);
  const menuRef = useModalFocus(menu, () => setMenu(false));
  const title = NAV.flatMap((g) => g.items).find((i) => (i.to === '/' ? path === '/' : path.startsWith(i.to)))?.label ?? OTHER_TITLES[path] ?? 'SASBench';
  useEffect(() => {
    document.title = `${title} · SASBench`;
  }, [title]);

  return (
    <div className="flex h-dvh overflow-hidden">
      <a
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
        className="sr-only z-50 rounded border border-line bg-panel px-3 py-1.5 text-sm font-medium text-ink shadow-pop focus:not-sr-only focus:fixed focus:left-3 focus:top-2"
      >
        Skip to content
      </a>
      <Rail className="hidden md:flex" />
      {menu && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div className="absolute inset-0 bg-rail/50" onClick={() => setMenu(false)} aria-hidden />
          <div ref={menuRef as RefObject<HTMLDivElement>} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Navigation" className="relative flex outline-none">
            <Rail className="drawer-in relative flex w-[240px]" expanded onClose={() => setMenu(false)} />
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenu={() => setMenu(true)} title={title} cbsds={cbsds.data ?? []} />
        <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
          <DefaultPasswordBar />
          <div className="mx-auto max-w-[1680px] p-4 lg:px-6 lg:py-5">{route(path)}</div>
        </main>
      </div>
    </div>
  );
}

function Rail({ className, expanded, onClose }: { className?: string; expanded?: boolean; onClose?: () => void }) {
  const { path } = useLocation();
  const { data: s } = useStatus();
  const { isAdmin } = useAuth();
  const l = s?.listeners;
  const full = expanded ? '' : 'hidden lg:inline';
  return (
    <nav aria-label="Main" className={cx('on-rail h-full flex-none flex-col bg-rail text-rail-fg', expanded ? '' : 'w-14 lg:w-[216px]', className)}>
      <div className="flex h-12 items-center gap-2.5 border-b border-rail-3 px-[15px]">
        <RackMark />
        <span className={cx('whitespace-nowrap text-md font-semibold tracking-[-0.01em] text-white', full)}>SASBench</span>
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
              {g.items.filter((it) => !it.adminOnly || isAdmin).map((it) => {
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
                      {badge ? <span className={cx('num ml-auto text-xs', active ? 'text-rail-fg/80' : 'text-rail-mute', full)}>{badge}</span> : null}
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

function TopBar({ onMenu, title, cbsds }: { onMenu: () => void; title: string; cbsds: Cbsd[] }) {
  const { connected } = useLive();
  const { data: s } = useStatus();
  const { followed, setFollowed } = useFollow();
  const profile = s?.profile ? PROFILE_LABEL[s.profile] ?? s.profile : 'Custom settings';
  return (
    <header className="flex h-12 flex-none items-center gap-3 border-b border-line bg-panel px-3 lg:px-6">
      <button type="button" onClick={onMenu} className="-ml-1 rounded p-1.5 text-ink-2 hover:bg-panel-3 md:hidden" aria-label="Open menu" aria-haspopup="dialog">
        <Menu className="size-5" />
      </button>
      <span className="truncate text-md font-semibold text-ink sm:hidden">{title}</span>
      {followed ? (
        <div className="hidden min-w-0 items-center gap-1.5 rounded border border-sel/30 bg-sel-soft py-0.5 pl-2 pr-0.5 text-sm text-sel-ink sm:flex">
          <Crosshair className="size-3.5 flex-none" aria-hidden />
          <span>Following</span>
          <CbsdName cbsdId={followed} className="font-medium text-sel-ink" />
          <button type="button" onClick={() => setFollowed(null)} className="rounded p-1 hover:bg-sel/10" aria-label="Stop following" title="Stop following">
            <X className="size-3" />
          </button>
        </div>
      ) : cbsds.length > 0 ? (
        <label className="hidden items-center gap-2 sm:flex" title="The followed CBSD is highlighted on every page and can narrow the wire log, grants and events">
          <Crosshair className="size-3.5 flex-none text-ink-3" aria-hidden />
          <span className="sr-only">Follow a CBSD</span>
          <Select value="" onChange={(e) => e.target.value && setFollowed(e.target.value)} className="h-7 w-[240px] py-0 text-sm text-ink-2">
            <option value="">Follow a CBSD…</option>
            {cbsds.map((c) => <option key={c.cbsdId} value={c.cbsdId}>{c.fccId} / {c.serial}</option>)}
          </Select>
        </label>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        {s && s.counts.faultRules > 0 && (
          <Link to="/faults" title="Fault rules alter what goes on the wire">
            <Tag tone="warn"><Zap className="size-3" aria-hidden />{s.counts.faultRules} fault rule{s.counts.faultRules > 1 ? 's' : ''} armed</Tag>
          </Link>
        )}
        <Link to="/settings" className="hidden sm:block" title="Settings profile">
          <Tag tone={s?.profile === 'open' ? 'warn' : 'off'}>{profile}</Tag>
        </Link>
        <span className="flex items-center gap-1.5 pl-1 text-xs text-ink-3" title={connected ? 'Live updates connected' : 'Reconnecting to the server…'}>
          <Led c={connected ? 'ok' : 'bad'} />
          <span className="hidden sm:inline">{connected ? 'Live' : 'Offline'}</span>
        </span>
        <ThemeToggle />
        <AccountMenu />
      </div>
    </header>
  );
}

/** Who is signed in, with the account pages and sign-out. */
function AccountMenu() {
  const { me, isAdmin, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { path } = useLocation();
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  if (me.method === 'open') {
    return (
      <Link to="/account" title="SAS_AUTH=off: anyone who can reach this console has full access">
        <Tag tone="warn">Sign-in off</Tag>
      </Link>
    );
  }
  const name = me.user?.username ?? me.tokenName ?? 'API key';
  const item = 'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-base text-ink-2 hover:bg-panel-3 hover:text-ink focus-visible:bg-panel-3';
  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-7 items-center gap-1.5 rounded border border-transparent px-1.5 text-sm text-ink-2 hover:border-line hover:bg-panel-2 hover:text-ink"
      >
        <UserRound className="size-4 flex-none" aria-hidden />
        <span className="hidden max-w-[140px] truncate md:inline">{name}</span>
        {me.scope === 'read' && <span className="hidden md:inline"><Tag tone="off">Read-only</Tag></span>}
        <ChevronDown className="size-3.5 flex-none text-ink-3" aria-hidden />
        <span className="sr-only">Account menu</span>
      </button>
      {open && (
        <div role="menu" aria-label="Account" className="absolute right-0 top-full z-40 mt-1 w-60 overflow-hidden rounded border border-line bg-panel py-1 shadow-pop">
          <div className="border-b border-line px-3 pb-2 pt-1.5">
            <div className="truncate text-base font-medium text-ink">{me.user?.displayName ?? name}</div>
            <div className="text-xs text-ink-3">{ROLE_LABEL[me.role]}{me.method === 'token' ? ' · API key' : ''}</div>
          </div>
          <button type="button" role="menuitem" className={item} onClick={() => go('/account')}><UserRound className="size-4 text-ink-3" aria-hidden />Your account</button>
          <button type="button" role="menuitem" className={item} onClick={() => go('/api-keys')}><KeyRound className="size-4 text-ink-3" aria-hidden />API keys</button>
          {isAdmin && <button type="button" role="menuitem" className={item} onClick={() => go('/users')}><Users className="size-4 text-ink-3" aria-hidden />Users</button>}
          {me.method === 'session' && (
            <button type="button" role="menuitem" className={cx(item, 'mt-1 border-t border-line pt-2')} onClick={() => void signOut()}>
              <LogOut className="size-4 text-ink-3" aria-hidden />Sign out
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Shown on every page while the signed-in user still has the default password (admin / admin). */
function DefaultPasswordBar() {
  const { me } = useAuth();
  const { path } = useLocation();
  if (!me.user?.defaultPassword || path === '/account') return null;
  return (
    <div role="status" className="border-b border-warn/40 bg-warn-soft">
      <div className="mx-auto flex max-w-[1680px] items-start gap-2.5 px-4 py-2 text-sm text-warn-ink lg:px-6">
        <KeyRound className="mt-0.5 size-4 flex-none" aria-hidden />
        <p>
          You are signed in as <span className="font-mono">{me.user.username}</span> with the default password. Anyone who knows it can change this SAS.{' '}
          <Link to="/account" className="whitespace-nowrap font-medium underline underline-offset-2">Change password</Link>
        </p>
      </div>
    </div>
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
