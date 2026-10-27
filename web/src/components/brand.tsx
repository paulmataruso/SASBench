import { cx } from './ui';

/** The SASBench mark: a two-unit rack with status LEDs. */
export function RackMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cx('size-6 flex-none', className)} aria-hidden>
      <rect x="2" y="3" width="20" height="18" rx="2.5" fill="rgb(var(--rail-3))" />
      <rect x="4.5" y="6" width="15" height="4" rx="1" fill="rgb(var(--rail))" />
      <rect x="4.5" y="12" width="15" height="4" rx="1" fill="rgb(var(--rail))" />
      <circle cx="7" cy="8" r="1.1" fill="rgb(var(--ok))" />
      <circle cx="10" cy="8" r="1.1" fill="rgb(var(--ok))" />
      <circle cx="7" cy="14" r="1.1" fill="rgb(var(--warn))" />
    </svg>
  );
}
