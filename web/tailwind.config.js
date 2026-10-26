/** @type {import('tailwindcss').Config} */
const c = (v) => `rgb(var(--${v}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    fontFamily: {
      sans: ['Barlow', 'system-ui', 'sans-serif'],
      label: ['"Barlow Condensed"', 'Barlow', 'system-ui', 'sans-serif'],
      mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
    },
    fontSize: {
      '2xs': ['10.5px', { lineHeight: '14px' }],
      xs: ['11.5px', { lineHeight: '16px' }],
      sm: ['12.5px', { lineHeight: '18px' }],
      base: ['13.5px', { lineHeight: '20px' }],
      md: ['15px', { lineHeight: '22px' }],
      lg: ['17px', { lineHeight: '24px' }],
      xl: ['21px', { lineHeight: '28px' }],
      '2xl': ['26px', { lineHeight: '32px' }],
    },
    extend: {
      colors: {
        rail: { DEFAULT: c('rail'), 2: c('rail-2'), 3: c('rail-3'), fg: c('rail-fg'), mute: c('rail-mute'), sel: c('rail-sel') },
        ground: c('ground'),
        primary: { DEFAULT: c('primary'), hover: c('primary-hover'), fg: c('primary-fg') },
        panel: { DEFAULT: c('panel'), 2: c('panel-2'), 3: c('panel-3') },
        line: { DEFAULT: c('line'), strong: c('line-strong') },
        ink: { DEFAULT: c('ink'), 2: c('ink-2'), 3: c('ink-3') },
        sel: { DEFAULT: c('sel'), soft: c('sel-soft'), ink: c('sel-ink') },
        ok: { DEFAULT: c('ok'), soft: c('ok-soft'), ink: c('ok-ink') },
        warn: { DEFAULT: c('warn'), soft: c('warn-soft'), ink: c('warn-ink') },
        bad: { DEFAULT: c('bad'), soft: c('bad-soft'), ink: c('bad-ink') },
        info: { DEFAULT: c('info'), soft: c('info-soft'), ink: c('info-ink') },
      },
      borderRadius: { DEFAULT: '3px', sm: '2px', md: '4px', lg: '6px' },
      boxShadow: {
        panel: '0 1px 2px rgb(var(--shadow) / 0.06), 0 1px 1px rgb(var(--shadow) / 0.04)',
        pop: '0 12px 32px -8px rgb(var(--shadow) / 0.28), 0 2px 6px rgb(var(--shadow) / 0.12)',
      },
      transitionTimingFunction: { out: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    },
  },
  plugins: [],
};
