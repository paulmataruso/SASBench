import { useEffect, useMemo, useState } from 'react';
import { Send, Wand2 } from 'lucide-react';
import { api } from '../lib/api';
import { usePref, useResource } from '../lib/live';
import { useFollow } from '../lib/follow';
import { useStatus } from '../lib/status';
import { useLocation, setQuery } from '../lib/router';
import { clock, RC_NAMES, SAS_METHODS } from '../lib/format';
import type { Cbsd, Grant, MessageRow } from '../lib/types';
import { Button, CodeTag, CopyButton, ErrorNote, Field, Input, JsonView, Module, PageHeader, Select, Tabs, Textarea, cx, useToast } from '../components/ui';

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
  const [method, setMethod] = useState<Method>('registration');
  const [version, setVersion] = useState('');
  const [payload, setPayload] = useState(() => JSON.stringify(template('registration', '', ''), null, 2));
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
      if (m.method && (SAS_METHODS as readonly string[]).includes(m.method)) setMethod(m.method as Method);
      if (m.version) setVersion(m.version);
      setPayload(JSON.stringify(m.request, null, 2));
      setResp(null);
      toast.info(`Loaded request from wire log #${from}`);
      setQuery('from', null);
    }, (e) => toast.err(e.message));
  }, [query, toast]);

  const cbsdId = target || followed || cbsds.data?.[0]?.cbsdId || '';
  const grantId = grants.data?.find((g) => g.cbsdId === cbsdId)?.grantId ?? '';

  const fill = (m: Method) => {
    setMethod(m);
    setPayload(JSON.stringify(template(m, cbsdId || '<cbsdId>', grantId || '<grantId>'), null, 2));
    setResp(null);
    setErr(null);
  };

  const parsed = useMemo(() => {
    try {
      return { ok: true as const, v: JSON.parse(payload) };
    } catch (e: any) {
      return { ok: false as const, e: e.message as string };
    }
  }, [payload]);

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
      <PageHeader title="Request console" sub="Send SAS–CBSD protocol requests straight into the engine, as a radio would. Exchanges are logged on the wire log as transport INTERNAL; certificate checks do not apply here.">
        <Field label="Target CBSD" className="w-72">
          <Select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">{followed ? 'Followed CBSD' : 'First registered CBSD'}</option>
            {(cbsds.data ?? []).map((c) => <option key={c.cbsdId} value={c.cbsdId}>{c.fccId} / {c.serial}</option>)}
          </Select>
        </Field>
      </PageHeader>

      <div className="grid gap-4 xl:grid-cols-2">
        <Module
          title="Request"
          actions={(
            <span className={cx('text-xs', parsed.ok ? 'text-ink-3' : 'text-bad-ink')}>{parsed.ok ? 'Valid JSON' : `JSON error: ${parsed.e}`}</span>
          )}
        >
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <Field label="Method" className="w-48">
              <Select value={method} onChange={(e) => setMethod(e.target.value as Method)}>
                {SAS_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </Select>
            </Field>
            <Field label="Version" className="w-28">
              <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="v1.2" />
            </Field>
            <Button icon={Wand2} onClick={() => fill(method)} title="Replace the payload with a template for this method, filled with the target CBSD and its grant">Template</Button>
          </div>
          <div className="mb-2 flex flex-wrap gap-1">
            {SAS_METHODS.map((m) => (
              <Button key={m} size="sm" variant={m === method ? 'primary' : 'ghost'} onClick={() => fill(m)}>{m}</Button>
            ))}
          </div>
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
            <span className="text-xs text-ink-3">Ctrl+Enter sends. Templates use the target CBSD{grantId ? ' and its first active grant' : ''}.</span>
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
                    <button type="button" className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm hover:bg-panel-3/70" onClick={() => {
                      setMethod(h.method);
                      setPayload(h.payload);
                    }}>
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
