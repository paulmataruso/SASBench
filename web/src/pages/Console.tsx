import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Send, Wand2 } from 'lucide-react';
import { api } from '../lib/api';
import { usePref, useResource } from '../lib/live';
import { useFollow } from '../lib/follow';
import { useStatus } from '../lib/status';
import { useLocation, setQuery } from '../lib/router';
import { clock, RC_NAMES, SAS_METHODS } from '../lib/format';
import type { Cbsd, Grant, MessageRow } from '../lib/types';
import { Button, CodeTag, CopyButton, ErrorNote, Field, Input, JsonView, Module, PageHeader, Segmented, Select, Tabs, Textarea, cx, useConfirm, useToast } from '../components/ui';

type Method = (typeof SAS_METHODS)[number];

interface HistoryItem { ts: number; method: Method; payload: string; codes: number[] }

function template(method: Method, cbsdId: string, grantId: string): unknown {
  switch (method) {
    case 'registration':
      return {
        registrationRequest: [{
          userId: 'lab-user', fccId: 'LAB-CBSD-A', cbsdSerialNumber: 'SN-0001', callSign: '', cbsdCategory: 'A',
          airInterface: { radioTechnology: 'E_UTRA' },
          installationParam: {
            latitude: 37.41962, longitude: -122.08229, height: 3, heightType: 'AGL', indoorDeployment: true,
            antennaAzimuth: 0, antennaDowntilt: 0, antennaGain: 5, antennaBeamwidth: 360, eirpCapability: 24,
          },
          measCapability: ['RECEIVED_POWER_WITHOUT_GRANT'],
        }],
      };
    case 'spectrumInquiry':
      return { spectrumInquiryRequest: [{ cbsdId, inquiredSpectrum: [{ lowFrequency: 3550000000, highFrequency: 3700000000 }] }] };
    case 'grant':
      return { grantRequest: [{ cbsdId, operationParam: { maxEirp: 20, operationFrequencyRange: { lowFrequency: 3550000000, highFrequency: 3570000000 } } }] };
    case 'heartbeat':
      return { heartbeatRequest: [{ cbsdId, grantId, operationState: 'GRANTED' }] };
    case 'relinquishment':
      return { relinquishmentRequest: [{ cbsdId, grantId }] };
    case 'deregistration':
      return { deregistrationRequest: [{ cbsdId }] };
  }
}

export function ConsolePage() {
  const { query } = useLocation();
  const { data: status } = useStatus();
  const { followed } = useFollow();
  const cbsds = useResource<Cbsd[]>('/api/cbsds?state=REGISTERED', ['cbsds']);
  const grants = useResource<Grant[]>('/api/grants?state=GRANTED,AUTHORIZED', ['grants']);
  const toast = useToast();
  const confirm = useConfirm();
  const [method, setMethod] = useState<Method>('registration');
  const [version, setVersion] = useState('');
  // One draft per method, so switching methods never throws away an edited request. `sent` is
  // what each draft was last filled from or sent as; a draft that differs from it has unsaved edits.
  const [drafts, setDrafts] = useState<Partial<Record<Method, string>>>(() => ({ registration: JSON.stringify(template('registration', '', ''), null, 2) }));
  const [sent, setSent] = useState<Partial<Record<Method, string>>>(() => ({ registration: JSON.stringify(template('registration', '', ''), null, 2) }));
  const payload = drafts[method] ?? '';
  const setPayload = (v: string) => setDrafts((d) => ({ ...d, [method]: v }));
  const [target, setTarget] = useState<string>('');
  const [resp, setResp] = useState<unknown>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [history, setHistory] = usePref<HistoryItem[]>('console.history', []);
  const [view, setView] = useState<'response' | 'curl'>('response');

  // Replay a logged exchange: /console?from=<message id>
  useEffect(() => {
    const from = query.get('from');
    if (!from) return;
    api.get<MessageRow>(`/api/messages/${from}`).then((m) => {
      const mm = m.method && (SAS_METHODS as readonly string[]).includes(m.method) ? m.method as Method : 'registration';
      const text = JSON.stringify(m.request, null, 2);
      setMethod(mm);
      if (m.version) setVersion(m.version);
      setDrafts((d) => ({ ...d, [mm]: text }));
      setSent((b) => ({ ...b, [mm]: text }));
      setResp(null);
      toast.info(`Loaded request from wire log #${from}`);
      setQuery('from', null);
    }, (e) => toast.err(e.message));
  }, [query, toast]);

  const cbsdId = target || followed || cbsds.data?.[0]?.cbsdId || '';
  const grantId = grants.data?.find((g) => g.cbsdId === cbsdId)?.grantId ?? '';

  const dirty = (m: Method) => drafts[m] !== undefined && drafts[m] !== sent[m];

  /** Replace a method's draft (template, history), asking first when it holds edits. */
  const load = async (m: Method, text: string) => {
    if (dirty(m) && drafts[m] !== text && !(await confirm({ title: `Replace your edited ${m} request?`, body: 'The request in the editor has changes that were not sent. They will be lost.', confirm: 'Replace' }))) return;
    setMethod(m);
    setDrafts((d) => ({ ...d, [m]: text }));
    setSent((b) => ({ ...b, [m]: text }));
    setResp(null);
    setErr(null);
  };
  const fill = (m: Method) => load(m, JSON.stringify(template(m, cbsdId || '<cbsdId>', grantId || '<grantId>'), null, 2));
  /** Switching method keeps each method's draft; a method opened for the first time starts from its template. */
  const pick = (m: Method) => {
    if (drafts[m] === undefined) void fill(m);
    else {
      setMethod(m);
      setResp(null);
      setErr(null);
    }
  };

  const parsed = useMemo(() => {
    try {
      return { ok: true as const, v: JSON.parse(payload) };
    } catch (e: any) {
      return { ok: false as const, e: e.message as string };
    }
  }, [payload]);
  // A body written for another method (e.g. a registrationRequest sent as grant) gets 102 from the SAS.
  const bodyMethod = parsed.ok && parsed.v && typeof parsed.v === 'object'
    ? SAS_METHODS.find((m) => `${m}Request` in parsed.v && !(`${method}Request` in parsed.v))
    : undefined;

  const send = async () => {
    if (!parsed.ok) return;
    setSending(true);
    setErr(null);
    try {
      const r = await api.post<Record<string, any>>('/api/console', { method, version: version || undefined, payload: parsed.v });
      setResp(r);
      setView('response');
      const codes = ((r[`${method}Response`] ?? []) as any[]).map((x) => x?.response?.responseCode);
      setHistory([{ ts: Date.now(), method, payload, codes }, ...history].slice(0, 25));
      setSent((b) => ({ ...b, [method]: payload }));
    } catch (e: any) {
      setErr(e.message);
      setResp(null);
    } finally {
      setSending(false);
    }
  };

  const httpUrl = status?.urls.find((u) => u.startsWith('http:'));
  const httpsUrl = status?.urls.find((u) => u.startsWith('https:'));
  const base = (httpUrl ?? httpsUrl ?? 'http://localhost:8000/v1.2/').replace(/v\d+\.\d+\/$/, `${version || 'v1.2'}/`);
  const compact = parsed.ok ? JSON.stringify(parsed.v) : payload;
  const curl = `curl -sS${base.startsWith('https') ? ' --cacert sas-root-ca.pem --cert device-cert.pem --key device-key.pem' : ''} -X POST '${base}${method}' \\\n  -H 'Content-Type: application/json' \\\n  -d '${compact.replace(/'/g, "'\\''")}'`;
  const codes = resp ? (((resp as any)[`${method}Response`] ?? []) as any[]).map((x) => x?.response?.responseCode) : [];

  return (
    <div>
      <PageHeader title="Request console" sub="Send SAS–CBSD protocol requests straight into the engine, as a radio would. Exchanges are logged on the wire log as transport INTERNAL; certificate checks do not apply here." />

      <div className="grid gap-4 xl:grid-cols-2">
        <Module
          title="Request"
          actions={(
            <span className={cx('text-xs', parsed.ok ? 'text-ink-3' : 'text-bad-ink')}>{parsed.ok ? 'Valid JSON' : `JSON error: ${parsed.e}`}</span>
          )}
        >
          <div className="mb-3">
            {/* Six protocol names do not fit one row in the half-width module: wrap them 3 + 3. */}
            <Segmented
              value={method}
              onChange={pick}
              label="Method"
              className="grid grid-cols-2 gap-0.5 sm:grid-cols-3 lg:flex xl:grid xl:grid-cols-3"
              options={SAS_METHODS.map((m) => ({ value: m, label: <span className="font-mono">{m}{dirty(m) && m !== method ? <span className="text-sel" title="Edited, not sent"> •</span> : null}</span>, title: dirty(m) ? `${m} (edited, not sent)` : m }))}
            />
          </div>
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <Field label="Target CBSD" className="min-w-[220px] flex-1 max-sm:basis-full" hint="Templates fill in its cbsdId and first active grant.">
              <Select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">{followed ? 'Followed CBSD' : 'First registered CBSD'}</option>
                {(cbsds.data ?? []).map((c) => <option key={c.cbsdId} value={c.cbsdId}>{c.fccId} / {c.serial}</option>)}
              </Select>
            </Field>
            <Field label="Version" className="w-24" hint="Path segment">
              <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="v1.2" />
            </Field>
            <Field label={<span className="invisible">Template</span>} hint={<span className="invisible">.</span>}>
              <Button icon={Wand2} onClick={() => void fill(method)} title={`Replace the ${method} request with a template for the target CBSD`}>Template</Button>
            </Field>
          </div>
          {bodyMethod && (
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded border border-warn/40 bg-warn-soft px-3 py-1.5 text-sm text-warn-ink">
              <AlertTriangle className="size-3.5 flex-none" aria-hidden />
              <span>This body is a <span className="font-mono">{bodyMethod}Request</span>; sent as <span className="font-mono">{method}</span> it would get 102 MISSING_PARAM.</span>
              <Button size="sm" className="ml-auto" onClick={() => {
                setDrafts((d) => ({ ...d, [bodyMethod]: payload, [method]: sent[method] ?? '' }));
                setSent((b) => ({ ...b, [bodyMethod]: payload }));
                setMethod(bodyMethod);
              }}>Move it to {bodyMethod}</Button>
            </div>
          )}
          <Textarea
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            rows={22}
            aria-invalid={!parsed.ok}
            aria-label="Request JSON"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-xs text-ink-3">Ctrl+Enter sends. Each method keeps its own draft.</span>
            <Button variant="primary" icon={Send} loading={sending} disabled={!parsed.ok} onClick={send}>Send {method}</Button>
          </div>
        </Module>

        <div className="space-y-4">
          <div>
            <Tabs value={view} onChange={setView} tabs={[{ value: 'response', label: 'Response' }, { value: 'curl', label: 'Same request with curl' }]} />
            <Module className="rounded-t-none border-t-0">
              {view === 'response' ? (
                <>
                  {err && <ErrorNote>{err}</ErrorNote>}
                  {!resp && !err && <p className="py-10 text-center text-sm text-ink-3">Send a request to see the SAS response here.</p>}
                  {resp != null && (
                    <>
                      <div className="mb-2 flex flex-wrap items-center gap-1.5">
                        {codes.map((c, i) => <CodeTag key={i} code={c} />)}
                        <span className="ml-auto"><CopyButton text={JSON.stringify(resp, null, 2)} label="Copy response" /></span>
                      </div>
                      <JsonView value={resp} maxHeight={560} />
                    </>
                  )}
                </>
              ) : (
                <>
                  <p className="mb-2 text-sm text-ink-2">
                    Runs against the real listener{base.startsWith('https') ? ' with a client certificate from a radio kit' : ''}, so it goes through TLS and logging like a radio would.
                  </p>
                  <div className="relative">
                    <pre className="json overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-panel-2 p-3 pr-10">{curl}</pre>
                    <CopyButton text={curl} label="Copy curl command" className="absolute right-1.5 top-1.5" />
                  </div>
                </>
              )}
            </Module>
          </div>

          <Module title="History" meta="this browser" actions={history.length ? <Button size="sm" variant="ghost" onClick={() => setHistory([])}>Clear</Button> : null} bodyClass="">
            {history.length === 0 ? <p className="px-3 py-6 text-center text-sm text-ink-3">Requests you send are kept here for quick re-use.</p> : (
              <ul className="max-h-[260px] divide-y divide-line overflow-y-auto">
                {history.map((h, i) => (
                  <li key={i}>
                    <button type="button" className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm hover:bg-panel-3/70" title="Load this request into the editor" onClick={() => void load(h.method, h.payload)}>
                      <span className="num w-[58px] font-mono text-2xs text-ink-3">{clock(h.ts)}</span>
                      <span className="flex-1 font-mono text-xs">{h.method}</span>
                      <span className="flex gap-1">{[...new Set(h.codes)].slice(0, 3).map((c) => <span key={c} title={RC_NAMES[c]}><CodeTag code={c} /></span>)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Module>
        </div>
      </div>
    </div>
  );
}
