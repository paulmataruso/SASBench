import { useEffect, useState, type ReactNode } from 'react';
import { mhz } from '../../lib/format';
import { Field, Input, Select, Switch, cx } from '../../components/ui';

// Field helpers shared by the Settings sections: each edits one setting key in the draft.

export type S = Record<string, any>;

export interface FProps { cur: S; set: (k: string, v: any) => void; defaults: S; draft: S }

export function Grid({ children }: { children: ReactNode }) {
  return <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">{children}</div>;
}

export function changedMark(p: FProps, k: string) {
  const d = p.defaults[k];
  if (d === undefined || JSON.stringify(d) === JSON.stringify(p.cur[k])) return null;
  return <span className="ml-1.5 font-normal text-ink-3" title={`Default: ${JSON.stringify(d)}`}>· default {Array.isArray(d) ? d.join(', ') : typeof d === 'boolean' ? (d ? 'on' : 'off') : String(d)}</span>;
}

export function Toggle(p: FProps & { k: string; label: string; desc?: string }) {
  return (
    <Switch
      checked={!!p.cur[p.k]}
      onChange={(v) => p.set(p.k, v)}
      label={<span className={cx(p.k in p.draft && 'font-medium')}>{p.label}{changedMark(p, p.k)}</span>}
      description={p.desc}
    />
  );
}

/** `fromEnv`: the environment variable that sets this setting; the field is then read-only. */
export function Num(p: FProps & { k: string; label: string; min?: number; max?: number; step?: number; hint?: ReactNode; fromEnv?: string }) {
  const [text, setText] = useState(String(p.cur[p.k] ?? ''));
  const v = p.cur[p.k];
  useEffect(() => setText(String(v ?? '')), [v]);
  const bad = text === '' || !Number.isFinite(Number(text)) || (p.min !== undefined && Number(text) < p.min) || (p.max !== undefined && Number(text) > p.max);
  return (
    <Field
      label={<>{p.label}{changedMark(p, p.k)}</>}
      hint={p.fromEnv ? <>Set by <span className="font-mono">{p.fromEnv}</span> in .env, which applies when SASBench starts (<span className="font-mono">docker compose up -d</span>).</> : p.hint}
      error={bad ? `Enter a number${p.min !== undefined ? ` ≥ ${p.min}` : ''}${p.max !== undefined ? ` and ≤ ${p.max}` : ''}` : null}
    >
      <Input
        type="number"
        value={text}
        min={p.min}
        max={p.max}
        step={p.step ?? 1}
        aria-invalid={bad}
        disabled={!!p.fromEnv}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(n)) p.set(p.k, n);
        }}
        className="w-48"
      />
    </Field>
  );
}

export function Mhz(p: FProps & { k: string; label: string; hint?: ReactNode }) {
  const [text, setText] = useState(mhz(p.cur[p.k]));
  const v = p.cur[p.k];
  useEffect(() => setText(mhz(v)), [v]);
  return (
    <Field label={<>{p.label}{p.defaults[p.k] !== undefined && p.defaults[p.k] !== p.cur[p.k] ? <span className="ml-1.5 font-normal text-ink-3">· default {mhz(p.defaults[p.k])}</span> : null}</>} hint={p.hint}>
      <Input
        type="number"
        step="0.1"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(n)) p.set(p.k, Math.round(n * 1e6));
        }}
        className="w-48"
      />
    </Field>
  );
}

export function Choice(p: FProps & { k: string; label: string; options: Array<[string, string]>; hint?: ReactNode }) {
  return (
    <Field label={<>{p.label}{changedMark(p, p.k)}</>} hint={p.hint}>
      <Select value={p.cur[p.k]} onChange={(e) => p.set(p.k, e.target.value)} className="max-w-[380px]">
        {p.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </Select>
    </Field>
  );
}

export function Text(p: FProps & { k: string; label: string; hint?: ReactNode; list?: boolean }) {
  const val = p.cur[p.k];
  const [text, setText] = useState(p.list ? (val ?? []).join(', ') : val ?? '');
  useEffect(() => setText(p.list ? (val ?? []).join(', ') : val ?? ''), [JSON.stringify(val)]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Field label={<>{p.label}{changedMark(p, p.k)}</>} hint={p.hint}>
      <Input
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          p.set(p.k, p.list ? e.target.value.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean) : e.target.value);
        }}
        className="max-w-[380px] font-mono text-sm"
      />
    </Field>
  );
}

