import { useMemo, useState, type ReactNode } from 'react';
import { Pencil, Plus, Trash2, Zap } from 'lucide-react';
import { api } from '../lib/api';
import { useResource } from '../lib/live';
import { useFollow } from '../lib/follow';
import { RC_NAMES, SAS_METHODS, cbsdLabel } from '../lib/format';
import { Link } from '../lib/router';
import type { Cbsd, FaultRule } from '../lib/types';
import { CbsdName } from '../components/rack';
import {
  Button, Drawer, Empty, ErrorNote, Field, Input, Module, Note, PageHeader, Select, SkeletonRows, Switch, Tag, Textarea,
  useAction, useConfirm, cx,
} from '../components/ui';

// Fault injection: rules that rewrite what the SAS listeners put on the wire (server/src/sas/faults.ts).

type Action = FaultRule['action'];

const ACTIONS: Array<{ value: Action; label: string; scope: 'object' | 'exchange'; help: string }> = [
  {
    value: 'response_code', label: 'Override responseCode', scope: 'object',
    help: 'Each matching response object gets this responseCode (plus optional responseMessage / responseData). For non-zero codes the success-only fields '
      + '(cbsdId, grantId, grantExpireTime, heartbeatInterval, availableChannel…) are removed; heartbeat responses keep a transmitExpireTime.',
  },
  {
    value: 'patch', label: 'Patch response object', scope: 'object',
    help: 'RFC 7386 JSON merge patch applied to each matching response object. Example: {"heartbeatInterval": 5} or {"transmitExpireTime": "2030-01-01T00:00:00Z"}. '
      + 'A null value deletes the field.',
  },
  {
    value: 'http_status', label: 'HTTP status', scope: 'exchange',
    help: 'The whole exchange is answered with this HTTP status instead of a protocol response. Response data (optional) becomes the body.',
  },
  { value: 'delay', label: 'Delay', scope: 'exchange', help: 'Waits this long before answering normally. Several delay rules add up.' },
  { value: 'drop', label: 'Drop connection', scope: 'exchange', help: 'The connection is closed without any HTTP response, as if the SAS were unreachable.' },
  { value: 'malformed', label: 'Malformed JSON', scope: 'exchange', help: 'Answers HTTP 200 with a truncated, unparseable JSON body.' },
];

const ACTION = Object.fromEntries(ACTIONS.map((a) => [a.value, a])) as Record<Action, (typeof ACTIONS)[number]>;

interface Draft {
  enabled: boolean;
  name: string;
  method: string;
  match_cbsd: string;
  action: Action;
  response_code: string;
  response_message: string;
  response_data: string;
  http_status: string;
  delay_ms: string;
  remaining: string;
}

const EMPTY: Draft = {
  enabled: true, name: '', method: 'heartbeat', match_cbsd: '', action: 'response_code', response_code: '501', response_message: '',
  response_data: '', http_status: '503', delay_ms: '5000', remaining: '1',
};

function toDraft(f: FaultRule): Draft {
  return {
    enabled: f.enabled, name: f.name ?? '', method: f.method, match_cbsd: f.match_cbsd ?? '', action: f.action,
    response_code: f.response_code === null ? '' : String(f.response_code), response_message: f.response_message ?? '',
    response_data: f.response_data === null || f.response_data === undefined ? '' : JSON.stringify(f.response_data, null, 2),
    http_status: f.http_status === null ? '' : String(f.http_status), delay_ms: f.delay_ms === null ? '' : String(f.delay_ms),
    remaining: f.remaining === null ? '' : String(f.remaining),
  };
}

/** Full body for POST/PUT (PUT replaces every column). */
function ruleBody(f: FaultRule, patch: Partial<FaultRule> = {}) {
  const r = { ...f, ...patch };
  return {
    enabled: r.enabled, name: r.name, method: r.method, match_cbsd: r.match_cbsd, action: r.action, response_code: r.response_code,
    response_data: r.response_data === null || r.response_data === undefined ? null : JSON.stringify(r.response_data),
    response_message: r.response_message, http_status: r.http_status, delay_ms: r.delay_ms, remaining: r.remaining,
  };
}

function draftBody(d: Draft) {
  return {
    enabled: d.enabled, name: d.name.trim() || null, method: d.method, match_cbsd: d.match_cbsd.trim() || null, action: d.action,
    response_code: d.action === 'response_code' ? Number(d.response_code) : null,
    response_message: d.action === 'response_code' ? d.response_message.trim() || null : null,
    response_data: ['response_code', 'patch', 'http_status'].includes(d.action) && d.response_data.trim() ? d.response_data.trim() : null,
    http_status: d.action === 'http_status' ? Number(d.http_status) : null,
    delay_ms: d.action === 'delay' ? Number(d.delay_ms) : null,
    remaining: d.remaining.trim() === '' ? null : Number(d.remaining),
  };
}

export function summarize(f: { action: Action; response_code?: number | string | null; http_status?: number | string | null; delay_ms?: number | string | null; response_data?: any }): string {
  switch (f.action) {
    case 'response_code': {
      const c = Number(f.response_code ?? 0);
      return `responseCode ${c} ${RC_NAMES[c] ?? ''}`.trim();
    }
    case 'patch': {
      const keys = f.response_data && typeof f.response_data === 'object' ? Object.keys(f.response_data) : [];
      return keys.length ? `patch ${keys.join(', ')}` : 'patch response';
    }
    case 'http_status': return `HTTP ${f.http_status ?? 500}`;
    case 'delay': return `delay ${Number(f.delay_ms ?? 0) / 1000} s`;
    case 'drop': return 'drop connection';
    case 'malformed': return 'malformed JSON body';
  }
}

/** A one-click fault. `lead` and `effect` render the button; `label` names the rule it creates. */
interface Preset { group: string; label: string; lead: string; effect: ReactNode; rule: Partial<Draft> & { action: Action } }

const code = (c: number) => <><span className="font-mono">{c}</span> <span className="font-label tracking-[0.04em]">{RC_NAMES[c]}</span></>;

const PRESETS: Preset[] = [
  { group: 'Heartbeat', label: 'Next heartbeat → 501 SUSPENDED_GRANT', lead: 'Next heartbeat', effect: code(501), rule: { method: 'heartbeat', action: 'response_code', response_code: '501', remaining: '1' } },
  { group: 'Heartbeat', label: 'Next heartbeat → 500 TERMINATED_GRANT', lead: 'Next heartbeat', effect: code(500), rule: { method: 'heartbeat', action: 'response_code', response_code: '500', remaining: '1' } },
  { group: 'Heartbeat', label: 'Next heartbeat → 502 UNSYNC_OP_PARAM', lead: 'Next heartbeat', effect: code(502), rule: { method: 'heartbeat', action: 'response_code', response_code: '502', remaining: '1' } },
  { group: 'Heartbeat', label: 'Heartbeat interval → 10 s', lead: 'heartbeatInterval', effect: <span className="font-mono">10 s</span>, rule: { method: 'heartbeat', action: 'patch', response_data: '{"heartbeatInterval": 10}', remaining: '' } },
  { group: 'Grant and registration', label: 'Next grant → 400 INTERFERENCE', lead: 'Next grant', effect: code(400), rule: { method: 'grant', action: 'response_code', response_code: '400', remaining: '1' } },
  { group: 'Grant and registration', label: 'Next registration → 104 CERT_ERROR', lead: 'Next registration', effect: code(104), rule: { method: 'registration', action: 'response_code', response_code: '104', remaining: '1' } },
  { group: 'Transport', label: 'Next 3 heartbeats → HTTP 503', lead: 'Next 3 heartbeats', effect: <>HTTP <span className="font-mono">503</span></>, rule: { method: 'heartbeat', action: 'http_status', http_status: '503', remaining: '3' } },
  { group: 'Transport', label: 'Drop next heartbeat', lead: 'Next heartbeat', effect: 'connection dropped', rule: { method: 'heartbeat', action: 'drop', remaining: '1' } },
  { group: 'Transport', label: 'Malformed next spectrumInquiry', lead: 'Next spectrumInquiry', effect: 'malformed JSON', rule: { method: 'spectrumInquiry', action: 'malformed', remaining: '1' } },
  { group: 'Transport', label: 'Delay every response 5 s', lead: 'Every response', effect: <>delayed <span className="font-mono">5 s</span></>, rule: { method: '*', action: 'delay', delay_ms: '5000', remaining: '' } },
];
const GROUPS = [...new Set(PRESETS.map((p) => p.group))];

export function FaultsPage() {
  const faults = useResource<FaultRule[]>('/api/faults', ['faults']);
  const cbsds = useResource<Cbsd[]>('/api/cbsds', ['cbsds']);
  const { followed } = useFollow();
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<{ id: number | null; draft: Draft } | null>(null);
  // Which radio quick faults hit: the followed CBSD by default, any CBSD on request.
  const [target, setTarget] = useState<string | null>(null);
  const scope = target ?? followed ?? '';
  const known = new Set((cbsds.data ?? []).map((c) => c.cbsdId));

  const rules = faults.data ?? [];
  const armed = rules.filter((r) => r.enabled && (r.remaining === null || r.remaining > 0)).length;

  const addPreset = (p: Preset) => run(`preset:${p.label}`, async () => {
    const match = scope;
    const d: Draft = { ...EMPTY, ...p.rule, name: p.label + (match ? ` (${cbsdLabel(match)})` : ''), match_cbsd: match };
    await api.post('/api/faults', draftBody(d));
    await faults.reload();
  }, `Armed: ${p.label}`);

  const toggle = (f: FaultRule, enabled: boolean) => run(`toggle:${f.id}`, async () => {
    faults.setData(rules.map((r) => (r.id === f.id ? { ...r, enabled } : r)));
    await api.put(`/api/faults/${f.id}`, ruleBody(f, { enabled }));
    await faults.reload();
  });

  const remove = async (f: FaultRule) => {
    if (!(await confirm({ title: 'Delete fault rule?', body: <>“{f.name || summarize(f)}” will stop applying immediately.</>, confirm: 'Delete', danger: true }))) return;
    await run(`del:${f.id}`, async () => {
      await api.del(`/api/faults/${f.id}`);
      await faults.reload();
    }, 'Fault rule deleted');
  };

  const removeSpent = async () => {
    const spent = rules.filter((r) => r.remaining !== null && r.remaining <= 0);
    if (!spent.length) return;
    await run('spent', async () => {
      for (const r of spent) await api.del(`/api/faults/${r.id}`);
      await faults.reload();
    }, `${spent.length} spent rule${spent.length > 1 ? 's' : ''} removed`);
  };

  return (
    <>
      <PageHeader
        title="Fault injection"
        sub="Rules rewrite what the SAS listeners put on the wire; SAS state is untouched. To really suspend, terminate or deregister, use the actions on the Grants and CBSD pages."
      >
        <Button variant="primary" icon={Plus} onClick={() => setEditing({ id: null, draft: { ...EMPTY, match_cbsd: followed ?? '' } })}>New rule</Button>
      </PageHeader>

      {armed > 0 && (
        <Note tone="warn" className="mb-4 flex items-center gap-2">
          <Zap className="size-4 flex-none" aria-hidden />
          <span>
            {armed} rule{armed > 1 ? 's are' : ' is'} armed. Matching CBSDs see responses that deviate from the specification until the rule is disabled or used up.
          </span>
        </Note>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
        <Module
          title="Rules"
          meta={rules.length ? `${rules.length} total · ${armed} armed` : undefined}
          bodyClass="p-0"
          actions={rules.some((r) => r.remaining !== null && r.remaining <= 0) ? (
            <Button size="sm" variant="ghost" onClick={removeSpent} loading={busy === 'spent'}>Remove spent</Button>
          ) : null}
        >
          {faults.error ? <div className="p-3"><ErrorNote>{faults.error}</ErrorNote></div>
            : faults.loading && !faults.data ? <SkeletonRows rows={4} cols={6} />
            : !rules.length ? (
              <Empty icon={Zap} title="No fault rules">
                Arm a quick fault on the right, or create a rule to force a specific responseCode, HTTP status, delay or dropped connection
                for one method or one CBSD.
              </Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="dtable">
                  <thead>
                    <tr>
                      <th className="w-12">On</th>
                      <th>Rule</th>
                      <th>Method</th>
                      <th>Match</th>
                      <th>Effect</th>
                      <th className="text-right">Remaining</th>
                      <th className="text-right">Hits</th>
                      <th className="w-20"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((f) => {
                      const spent = f.remaining !== null && f.remaining <= 0;
                      const live = f.enabled && !spent;
                      return (
                        <tr key={f.id} className={cx(!live && 'text-ink-3')}>
                          <td>
                            <Switch checked={f.enabled} onChange={(v) => void toggle(f, v)} label={<span className="sr-only">Enabled</span>} disabled={busy === `toggle:${f.id}`} />
                          </td>
                          <td className="max-w-[260px]">
                            <div className="truncate font-medium text-ink">{f.name || `Rule #${f.id}`}</div>
                          </td>
                          <td><span className="font-mono text-xs">{f.method === '*' ? 'any' : f.method}</span></td>
                          <td className="max-w-[200px]">
                            {f.match_cbsd && known.has(f.match_cbsd) ? <CbsdName cbsdId={f.match_cbsd} />
                              : f.match_cbsd ? <span className="block truncate font-mono text-xs" title={f.match_cbsd}>“{f.match_cbsd}”</span>
                              : <span className="whitespace-nowrap text-ink-3">every CBSD</span>}
                          </td>
                          <td className="whitespace-nowrap">
                            <Tag tone={live ? 'warn' : 'off'}>{summarize(f)}</Tag>
                            <span className="ml-2 whitespace-nowrap text-xs text-ink-3">{ACTION[f.action]?.scope === 'exchange' ? 'whole exchange' : 'per object'}</span>
                          </td>
                          <td className="num text-right">{f.remaining === null ? <span className="text-ink-3">∞</span> : spent ? <Tag>spent</Tag> : f.remaining}</td>
                          <td className="num text-right">
                            {f.hits > 0 ? (
                              <Link
                                to={`/messages?${new URLSearchParams({ ...(f.method !== '*' ? { method: f.method } : {}), ...(f.match_cbsd && known.has(f.match_cbsd) ? { cbsdId: f.match_cbsd } : {}) })}`}
                                className="underline decoration-line-strong hover:decoration-ink-3"
                                title="Matching exchanges in the wire log"
                              >
                                {f.hits}
                              </Link>
                            ) : 0}
                          </td>
                          <td>
                            <div className="flex justify-end gap-0.5">
                              <Button size="sm" variant="ghost" icon={Pencil} title="Edit" aria-label="Edit rule" onClick={() => setEditing({ id: f.id, draft: toDraft(f) })} />
                              <Button size="sm" variant="danger-ghost" icon={Trash2} title="Delete" aria-label="Delete rule" onClick={() => void remove(f)} loading={busy === `del:${f.id}`} />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </Module>

        <Module title="Quick faults" bodyClass="p-3">
          <Field label="Applies to" className="mb-3" hint={scope ? 'Only requests from this CBSD are affected.' : 'Every CBSD talking to the SAS listeners is affected.'}>
            <Select value={scope} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Every CBSD</option>
              {(cbsds.data ?? []).map((c) => <option key={c.cbsdId} value={c.cbsdId}>{c.fccId} / {c.serial}{c.cbsdId === followed ? ' (followed)' : ''}</option>)}
            </Select>
          </Field>
          <div className="space-y-3">
            {GROUPS.map((g) => (
              <section key={g}>
                <h3 className="silk mb-1">{g}</h3>
                <div className="flex flex-col gap-1.5">
                  {PRESETS.filter((p) => p.group === g).map((p) => (
                    <Button key={p.label} className="!justify-start" icon={Zap} onClick={() => void addPreset(p)} loading={busy === `preset:${p.label}`} title={`Arm: ${p.label}`}>
                      <span className="truncate">{p.lead} <span className="text-ink-3">→</span> {p.effect}</span>
                    </Button>
                  ))}
                </div>
              </section>
            ))}
          </div>
          <p className="mt-3 text-xs text-ink-3">
            Faults apply to requests arriving on the SAS HTTP/HTTPS listeners. The request console talks to the engine directly and bypasses them.
          </p>
        </Module>
      </div>

      <FaultEditor
        state={editing}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await faults.reload();
        }}
      />
    </>
  );
}

function FaultEditor({ state, onClose, onSaved }: { state: { id: number | null; draft: Draft } | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [d, setD] = useState<Draft>(EMPTY);
  const [key, setKey] = useState<unknown>(null);
  const { run, busy } = useAction();
  if (state && key !== state) {
    setKey(state);
    setD(state.draft);
  }
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const jsonError = useMemo(() => {
    if (!d.response_data.trim() || !['response_code', 'patch', 'http_status'].includes(d.action)) return null;
    try {
      const v = JSON.parse(d.response_data);
      if (d.action === 'patch' && (typeof v !== 'object' || v === null || Array.isArray(v))) return 'A merge patch must be a JSON object';
      return null;
    } catch (e: any) {
      return `Invalid JSON: ${e.message}`;
    }
  }, [d.response_data, d.action]);

  const errors = {
    response_code: d.action === 'response_code' && !Number.isInteger(Number(d.response_code)) ? 'Choose a responseCode' : null,
    http_status: d.action === 'http_status' && !(Number(d.http_status) >= 100 && Number(d.http_status) <= 599) ? 'HTTP status must be 100–599' : null,
    delay_ms: d.action === 'delay' && !(Number(d.delay_ms) > 0) ? 'Delay must be a positive number of milliseconds' : null,
    remaining: d.remaining.trim() !== '' && !(Number.isInteger(Number(d.remaining)) && Number(d.remaining) >= 0) ? 'Whole number, or blank for unlimited' : null,
    patch: d.action === 'patch' && !d.response_data.trim() ? 'A patch needs a JSON object' : null,
  };
  const invalid = !!jsonError || Object.values(errors).some(Boolean);

  const save = () => run('save', async () => {
    const body = draftBody(d);
    if (state?.id) await api.put(`/api/faults/${state.id}`, body);
    else await api.post('/api/faults', body);
    await onSaved();
  }, state?.id ? 'Fault rule updated' : 'Fault rule created');

  const a = ACTION[d.action];
  const preview = `${d.method === '*' ? 'Every SAS request' : `${d.method} requests`}${d.match_cbsd.trim() ? ` involving “${d.match_cbsd.trim()}”` : ''}: ${summarize({ ...d, response_data: safeParse(d.response_data) })}${d.remaining.trim() === '' ? ', until disabled' : `, ${d.remaining} time${d.remaining === '1' ? '' : 's'}`}.`;

  return (
    <Drawer
      open={!!state}
      onClose={onClose}
      width={560}
      title={state?.id ? `Edit fault rule #${state.id}` : 'New fault rule'}
    >
      <form
        className="space-y-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!invalid) void save();
        }}
      >
        <Field label="Name" hint="Shown in the event log whenever the rule fires.">
          <Input value={d.name} onChange={(e) => set('name', e.target.value)} placeholder={summarize({ ...d, response_data: safeParse(d.response_data) })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Method">
            <Select value={d.method} onChange={(e) => set('method', e.target.value)}>
              <option value="*">Any method</option>
              {SAS_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
          </Field>
          <Field label="Remaining hits" hint="Blank = unlimited. Decrements on every match." error={errors.remaining}>
            <Input inputMode="numeric" value={d.remaining} onChange={(e) => set('remaining', e.target.value)} placeholder="∞" aria-invalid={!!errors.remaining} />
          </Field>
        </div>
        <Field label="Match CBSD" hint="Substring of the cbsdId, FCC ID, serial number or grantId in the request object. Blank = every CBSD.">
          <Input className="font-mono text-sm" value={d.match_cbsd} onChange={(e) => set('match_cbsd', e.target.value)} placeholder="e.g. TEST-FCC-ID or a serial number" />
        </Field>
        <Field label="Effect">
          <Select value={d.action} onChange={(e) => set('action', e.target.value as Action)}>
            {ACTIONS.map((x) => <option key={x.value} value={x.value}>{x.label} ({x.scope === 'object' ? 'per response object' : 'whole exchange'})</option>)}
          </Select>
        </Field>
        <p className="-mt-2 text-sm text-ink-3">{a.help}</p>

        {d.action === 'response_code' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="responseCode" error={errors.response_code}>
              <Select value={d.response_code} onChange={(e) => set('response_code', e.target.value)}>
                {Object.entries(RC_NAMES).map(([c, n]) => <option key={c} value={c}>{c} {n}</option>)}
              </Select>
            </Field>
            <Field label="responseMessage" hint="Optional.">
              <Input value={d.response_message} onChange={(e) => set('response_message', e.target.value)} />
            </Field>
          </div>
        )}
        {d.action === 'http_status' && (
          <Field label="HTTP status" error={errors.http_status}>
            <Input inputMode="numeric" value={d.http_status} onChange={(e) => set('http_status', e.target.value)} aria-invalid={!!errors.http_status} />
          </Field>
        )}
        {d.action === 'delay' && (
          <Field label="Delay (ms)" error={errors.delay_ms}>
            <Input inputMode="numeric" value={d.delay_ms} onChange={(e) => set('delay_ms', e.target.value)} aria-invalid={!!errors.delay_ms} />
          </Field>
        )}
        {(d.action === 'response_code' || d.action === 'patch' || d.action === 'http_status') && (
          <Field
            label={d.action === 'patch' ? 'Merge patch (JSON object)' : d.action === 'http_status' ? 'Response body (JSON, optional)' : 'responseData (JSON, optional)'}
            error={jsonError ?? errors.patch}
          >
            <Textarea rows={6} value={d.response_data} onChange={(e) => set('response_data', e.target.value)} aria-invalid={!!(jsonError ?? errors.patch)}
              placeholder={d.action === 'patch' ? '{"heartbeatInterval": 10}' : d.action === 'http_status' ? '{"error": "maintenance"}' : '["installationParam"]'} />
          </Field>
        )}
        <Switch checked={d.enabled} onChange={(v) => set('enabled', v)} label="Enabled" />
        <div className="rounded border border-line bg-panel-2 px-3 py-2 text-sm text-ink-2">{preview}</div>
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={invalid} loading={busy === 'save'}>{state?.id ? 'Save rule' : 'Arm rule'}</Button>
        </div>
      </form>
    </Drawer>
  );
}

function safeParse(s: string): any {
  try {
    return s.trim() ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}
