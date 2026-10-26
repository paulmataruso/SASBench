import {
  createContext, forwardRef, useCallback, useContext, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Loader2, X, type LucideIcon } from 'lucide-react';
import { RC_NAMES, rcTone } from '../lib/format';

export function cx(...c: Array<string | false | null | undefined>) {
  return c.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------- buttons

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-primary text-primary-fg border-primary hover:bg-primary-hover hover:border-primary-hover',
  secondary: 'bg-panel text-ink border-line-strong hover:border-ink-3 hover:bg-panel-2 active:bg-panel-3',
  ghost: 'bg-transparent text-ink-2 border-transparent hover:bg-panel-3 hover:text-ink active:bg-line/60',
  danger: 'bg-bad text-white border-bad hover:brightness-110 active:brightness-95',
  'danger-ghost': 'bg-transparent text-bad-ink border-transparent hover:bg-bad-soft',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  icon?: LucideIcon;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon: Icon, loading, children, className, disabled, type = 'button', ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx(
        'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded border font-medium transition-[background-color,border-color,color,filter] duration-150',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2 text-sm' : 'h-8 px-3 text-base',
        !children && (size === 'sm' ? 'w-7 px-0' : 'w-8 px-0'),
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : Icon ? <Icon className="size-3.5" aria-hidden strokeWidth={2} /> : null}
      {children}
    </button>
  );
});

// ---------------------------------------------------------------- form controls

// A Field hands its id to the control inside it, so the visible label names the control and the
// hint / error describes it without every caller wiring htmlFor and aria-describedby by hand.
const FieldCtx = createContext<{ id: string; describedBy?: string } | null>(null);

function useFieldProps<P extends { id?: string; 'aria-label'?: string; 'aria-describedby'?: string }>(props: P): P {
  const f = useContext(FieldCtx);
  if (!f) return props;
  // A control with its own aria-label shares the Field with others (e.g. a min/max pair): it keeps
  // the hint but leaves the label's id to the Field's main control.
  const id = props.id ?? (props['aria-label'] ? undefined : f.id);
  return { ...props, id, 'aria-describedby': props['aria-describedby'] ?? f.describedBy };
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx('field', className)} {...useFieldProps(rest)} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...rest }, ref) {
  return <select ref={ref} className={cx('field', className)} {...useFieldProps(rest)} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx('field font-mono text-sm leading-[19px]', className)} spellCheck={false} {...useFieldProps(rest)} />;
});

export function Field({ label, hint, error, children, className, htmlFor }: {
  label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string; htmlFor?: string;
}) {
  const auto = useId();
  const id = htmlFor ?? auto;
  const note = error || hint ? `${id}-note` : undefined;
  return (
    <div className={cx('min-w-0', className)}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-ink-2">{label}</label>
      <FieldCtx.Provider value={{ id, describedBy: note }}>{children}</FieldCtx.Provider>
      {error ? <p id={note} className="mt-1 text-xs text-bad-ink">{error}</p> : hint ? <p id={note} className="mt-1 text-xs text-ink-3">{hint}</p> : null}
    </div>
  );
}

export function Switch({ checked, onChange, label, description, disabled, className }: {
  checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean; className?: string;
}) {
  const id = useId();
  return (
    <div className={cx('flex items-start gap-3', className)}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative mt-0.5 inline-flex h-[18px] w-8 flex-none items-center rounded-full border transition-colors duration-150 disabled:opacity-50',
          checked ? 'border-sel bg-sel' : 'border-line-strong bg-panel-3',
        )}
      >
        <span className={cx('inline-block size-3 rounded-full bg-white shadow transition-transform duration-150 ease-out', checked ? 'translate-x-[15px]' : 'translate-x-[2px]')} />
      </button>
      <label htmlFor={id} className="min-w-0 cursor-pointer select-none">
        <span className="block text-base text-ink">{label}</span>
        {description ? <span className="mt-0.5 block text-xs text-ink-3">{description}</span> : null}
      </label>
    </div>
  );
}

/** Arrow keys move between the options of a radio group or tab list and select the one reached. */
function arrowNav<T>(e: KeyboardEvent<HTMLElement>, values: T[], value: T, onChange: (v: T) => void) {
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  const to = e.key === 'Home' ? 0 : e.key === 'End' ? values.length - 1 : step ? (values.indexOf(value) + step + values.length) % values.length : -1;
  if (to < 0) return;
  e.preventDefault();
  onChange(values[to]);
  const buttons = e.currentTarget.querySelectorAll<HTMLElement>('[data-opt]');
  buttons[to]?.focus();
}

export function Segmented<T extends string>({ value, onChange, options, size = 'md', label, className }: {
  value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode; title?: string }>; size?: 'sm' | 'md'; label?: string;
  /** Layout of the options; defaults to a single inline row. */
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx('rounded border border-line-strong bg-panel-2 p-0.5', className ?? 'inline-flex')}
      onKeyDown={(e) => arrowNav(e, options.map((o) => o.value), value, onChange)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          data-opt=""
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          title={o.title}
          aria-label={typeof o.label === 'string' ? undefined : o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded-sm font-medium transition-colors duration-150',
            size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-sm',
            value === o.value ? 'bg-panel text-ink shadow-panel ring-1 ring-line-strong' : 'text-ink-3 hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- layout

/** A rack module: white face, hairline border, silkscreen header strip. */
export function Module({ title, actions, children, className, bodyClass, id, meta }: {
  title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string; id?: string; meta?: ReactNode;
}) {
  return (
    <section id={id} className={cx('flex min-w-0 flex-col rounded border border-line bg-panel shadow-panel', className)}>
      {title !== undefined && (
        <header className="flex min-h-[34px] flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-panel-2 px-3 py-1">
          <h2 className="silk text-xs text-ink-2">{title}</h2>
          {meta ? <div className="text-xs text-ink-3">{meta}</div> : null}
          <div className="ml-auto flex flex-wrap items-center gap-1.5">{actions}</div>
        </header>
      )}
      <div className={cx('min-h-0 flex-1', bodyClass ?? 'p-3')}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, children, sub }: { title: ReactNode; children?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-ink">{title}</h1>
        {sub ? <p className="mt-0.5 max-w-[80ch] text-sm text-ink-3">{sub}</p> : null}
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs, className }: {
  value: T; onChange: (v: T) => void; tabs: Array<{ value: T; label: ReactNode; count?: number }>; className?: string;
}) {
  return (
    <div role="tablist" className={cx('flex gap-1 overflow-x-auto border-b border-line', className)} onKeyDown={(e) => arrowNav(e, tabs.map((t) => t.value), value, onChange)}>
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          type="button"
          data-opt=""
          aria-selected={value === t.value}
          tabIndex={value === t.value ? 0 : -1}
          onClick={() => onChange(t.value)}
          className={cx(
            '-mb-px inline-flex h-9 items-center gap-2 whitespace-nowrap border-b-2 px-3 text-base font-medium transition-colors duration-150',
            value === t.value ? 'border-sel text-ink' : 'border-transparent text-ink-3 hover:border-line-strong hover:text-ink',
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="num rounded-sm bg-panel-3 px-1.5 text-xs text-ink-2">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Label/value readout grid for detail panels. */
export function Readout({ rows, cols = 2 }: { rows: Array<[ReactNode, ReactNode] | null | false>; cols?: 1 | 2 | 3 }) {
  return (
    <dl className={cx('grid gap-x-6 gap-y-2', cols === 1 ? 'grid-cols-1' : cols === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3')}>
      {rows.filter(Boolean).map((r, i) => {
        const [k, v] = r as [ReactNode, ReactNode];
        return (
          <div key={i} className="min-w-0">
            <dt className="silk">{k}</dt>
            <dd className="mt-0.5 break-words text-base text-ink">{v ?? <span className="text-ink-3">—</span>}</dd>
          </div>
        );
      })}
    </dl>
  );
}

// ---------------------------------------------------------------- status

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'off' | 'sel';

export function Led({ c, flash, title, className }: { c: Tone | null; flash?: number; title?: string; className?: string }) {
  // Changing `key` restarts the CSS flash animation each time a new heartbeat arrives.
  return (
    <span
      key={flash}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      title={title}
      className={cx('led', className)}
      data-c={c && c !== 'off' ? c : undefined}
      data-flash={flash ? '' : undefined}
    />
  );
}

const TAG_TONES: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok-ink border-ok/30',
  warn: 'bg-warn-soft text-warn-ink border-warn/40',
  bad: 'bg-bad-soft text-bad-ink border-bad/30',
  info: 'bg-info-soft text-info-ink border-info/30',
  sel: 'bg-sel-soft text-sel-ink border-sel/30',
  off: 'bg-panel-3 text-ink-2 border-line-strong',
};

export function Tag({ tone = 'off', children, className, title, mono }: { tone?: Tone; children: ReactNode; className?: string; title?: string; mono?: boolean }) {
  return (
    <span title={title} className={cx('inline-flex h-[20px] items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 text-xs font-medium', mono ? 'font-mono text-2xs' : 'font-label tracking-[0.04em]', TAG_TONES[tone], className)}>
      {children}
    </span>
  );
}

export function grantTone(state: string, suspended?: boolean): Tone {
  if (state === 'AUTHORIZED') return suspended ? 'warn' : 'ok';
  if (state === 'GRANTED') return suspended ? 'warn' : 'info';
  if (state === 'TERMINATED' || state === 'DELETED') return 'bad';
  return 'off';
}

export function GrantStateTag({ state, suspended }: { state: string; suspended?: boolean }) {
  return (
    <Tag tone={grantTone(state, suspended)}>
      {state}
      {suspended && (state === 'GRANTED' || state === 'AUTHORIZED') ? ' · SUSPENDED' : ''}
    </Tag>
  );
}

export function CodeTag({ code }: { code: number }) {
  return (
    <Tag tone={rcTone(code)} mono title={RC_NAMES[code] ?? 'unknown'}>
      {code}
      {code !== 0 && <span className="font-label text-2xs font-semibold tracking-[0.04em] opacity-80">{RC_NAMES[code] ?? ''}</span>}
    </Tag>
  );
}

export function HttpTag({ status }: { status: number | null | undefined }) {
  if (!status) return <Tag tone="bad" mono>—</Tag>;
  return <Tag tone={status < 300 ? 'off' : status < 500 ? 'warn' : 'bad'} mono>{status}</Tag>;
}

// ---------------------------------------------------------------- feedback

export function Empty({ icon: Icon, title, children, action, className }: { icon?: LucideIcon; title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-col items-center justify-center px-6 py-10 text-center', className)}>
      {Icon ? <Icon className="mb-3 size-6 text-ink-3" strokeWidth={1.5} aria-hidden /> : null}
      <p className="text-md font-medium text-ink">{title}</p>
      {children ? <div className="mt-1 max-w-[60ch] text-sm text-ink-3">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function SkeletonRows({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2 p-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex gap-3">
          {Array.from({ length: cols }, (_, j) => <div key={j} className="skeleton h-4 flex-1" style={{ maxWidth: j === 0 ? 140 : undefined }} />)}
        </div>
      ))}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div role="alert" className="rounded border border-bad/30 bg-bad-soft px-3 py-2 text-sm text-bad-ink">{children}</div>;
}

export function Note({ tone = 'info', children, className }: { tone?: 'info' | 'warn' | 'ok' | 'bad'; children: ReactNode; className?: string }) {
  return <div className={cx('rounded border px-3 py-2 text-sm', TAG_TONES[tone], className)}>{children}</div>;
}

// ---------------------------------------------------------------- copy

export function CopyButton({ text, label, className, size = 'sm' }: { text: string; label?: string; className?: string; size?: 'sm' | 'md' }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1200);
  };
  return (
    <Button variant="ghost" size={size} icon={done ? Check : Copy} onClick={copy} className={className} title={label ?? 'Copy'} aria-label={label ?? 'Copy'}>
      {label && size === 'md' ? (done ? 'Copied' : label) : null}
    </Button>
  );
}

export function Mono({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return <span title={title} className={cx('font-mono text-xs text-ink', className)}>{children}</span>;
}

// ---------------------------------------------------------------- JSON

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function highlightJson(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'undefined';
  return esc(text).replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m) => {
      if (m.startsWith('"')) return m.endsWith(':') ? `<span class="k">${m}</span>` : `<span class="s">${m}</span>`;
      if (m === 'true' || m === 'false' || m === 'null') return `<span class="b">${m}</span>`;
      return `<span class="n">${m}</span>`;
    },
  );
}

export function JsonView({ value, className, maxHeight }: { value: unknown; className?: string; maxHeight?: number }) {
  return (
    <pre
      className={cx('json overflow-auto whitespace-pre-wrap rounded border border-line bg-panel-2 p-3 [overflow-wrap:anywhere]', className)}
      style={maxHeight ? { maxHeight } : undefined}
      dangerouslySetInnerHTML={{ __html: highlightJson(value) }}
    />
  );
}

// ---------------------------------------------------------------- drawer & dialog

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Keyboard containment for a modal layer: focus moves in when it opens, Tab cycles inside it,
 * Escape closes it, and focus returns to whatever opened it.
 */
export function useModalFocus(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => ref.current?.focus());
    const on = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        close.current();
        return;
      }
      if (e.key !== 'Tab' || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === ref.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !ref.current.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', on);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', on);
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);
  return ref;
}

export function Drawer({ open, onClose, title, children, width = 640, actions }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number; actions?: ReactNode;
}) {
  const ref = useModalFocus(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-rail/30" onClick={onClose} aria-hidden />
      <aside
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="drawer-in relative flex h-full w-full flex-col border-l border-line bg-panel shadow-pop outline-none"
        style={{ maxWidth: width }}
      >
        <header className="flex min-h-[48px] items-center gap-3 border-b border-line bg-panel-2 px-4">
          <div id={titleId} className="min-w-0 flex-1 truncate text-md font-semibold">{title}</div>
          {actions}
          <button type="button" onClick={onClose} aria-label="Close" title="Close (Esc)" className="-mr-1.5 rounded p-1.5 text-ink-2 transition-colors hover:bg-panel-3 hover:text-ink">
            <X className="size-[18px]" strokeWidth={2} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}

interface ConfirmOpts {
  title: string;
  body?: ReactNode;
  confirm?: string;
  danger?: boolean;
  /** Require typing this word to enable the confirm button. */
  typeToConfirm?: string;
}

const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [typed, setTyped] = useState('');
  const ref = useRef<HTMLDialogElement>(null);
  const ask = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => {
    setTyped('');
    setState({ ...o, resolve });
  }), []);
  useEffect(() => {
    if (state && ref.current && !ref.current.open) ref.current.showModal();
  }, [state]);
  const close = (v: boolean) => {
    state?.resolve(v);
    ref.current?.close();
    setState(null);
  };
  const blocked = !!state?.typeToConfirm && typed !== state.typeToConfirm;
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      <dialog
        ref={ref}
        onCancel={(e) => {
          e.preventDefault();
          close(false);
        }}
        className="w-[min(440px,calc(100vw-32px))] rounded-md border border-line bg-panel p-0 text-ink shadow-pop backdrop:bg-rail/40"
      >
        {state && (
          <form
            method="dialog"
            onSubmit={(e) => {
              e.preventDefault();
              if (!blocked) close(true);
            }}
          >
            <div className="px-5 pb-4 pt-5">
              <h2 className="text-md font-semibold">{state.title}</h2>
              {state.body ? <div className="mt-2 text-base text-ink-2">{state.body}</div> : null}
              {state.typeToConfirm ? (
                <Field label={<>Type <span className="font-mono">{state.typeToConfirm}</span> to confirm</>} className="mt-4">
                  <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
                </Field>
              ) : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-line bg-panel-2 px-5 py-3">
              <Button onClick={() => close(false)}>Cancel</Button>
              <Button type="submit" variant={state.danger ? 'danger' : 'primary'} disabled={blocked} autoFocus={!state.typeToConfirm}>
                {state.confirm ?? 'Confirm'}
              </Button>
            </div>
          </form>
        )}
      </dialog>
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  return useContext(ConfirmCtx);
}

// ---------------------------------------------------------------- toasts

interface ToastItem { id: number; tone: 'ok' | 'bad' | 'info'; text: ReactNode }
interface ToastApi { ok: (t: ReactNode) => void; err: (t: ReactNode) => void; info: (t: ReactNode) => void }
const ToastCtx = createContext<ToastApi>({ ok: () => {}, err: () => {}, info: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((tone: ToastItem['tone'], text: ReactNode) => {
    const id = ++seq.current;
    setItems((x) => [...x.slice(-3), { id, tone, text }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), tone === 'bad' ? 7000 : 3500);
  }, []);
  const apiRef = useRef<ToastApi>({ ok: (t) => push('ok', t), err: (t) => push('bad', t), info: (t) => push('info', t) });
  return (
    <ToastCtx.Provider value={apiRef.current}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(380px,calc(100vw-32px))] flex-col gap-2" aria-live="polite">
          {items.map((t) => (
            <div key={t.id} className="toast-in pointer-events-auto flex items-start gap-2.5 rounded border border-line bg-panel px-3 py-2.5 text-base shadow-pop">
              <Led c={t.tone === 'bad' ? 'bad' : t.tone === 'ok' ? 'ok' : 'info'} className="mt-1.5" />
              <div className="min-w-0 flex-1 break-words">{t.text}</div>
              <button type="button" className="text-ink-3 hover:text-ink" aria-label="Dismiss" onClick={() => setItems((x) => x.filter((i) => i.id !== t.id))}>
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

/** Run an async action with a busy flag; errors become toasts. Returns [run, busyKey]. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>, okMsg?: ReactNode): Promise<T | undefined> => {
    setBusy(key);
    try {
      const r = await fn();
      if (okMsg) toast.ok(okMsg);
      return r;
    } catch (e: any) {
      toast.err(e?.message ?? String(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }, [toast]);
  return { run, busy };
}
