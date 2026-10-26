import { useEffect, useState } from 'react';
import { SquareTerminal } from 'lucide-react';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { CbsdName } from './rack';
import { clockMs, iso, parseCodes, RC_NAMES } from '../lib/format';
import type { MessageRow } from '../lib/types';
import { Button, CodeTag, CopyButton, Drawer, ErrorNote, HttpTag, JsonView, Readout, SkeletonRows, Tag } from './ui';

// One protocol exchange, verbatim: request and response JSON plus transport details.

export function transportTag(t: string | null | undefined) {
  const v = (t ?? '').toLowerCase();
  // Neutral on purpose: transport is a fact about the link, not a status.
  return <Tag mono>{v ? v.toUpperCase() : '—'}</Tag>;
}

export function msgCbsdIds(m: MessageRow): string[] {
  if (m.cbsdIds) return m.cbsdIds;
  return m.cbsd_ids ? m.cbsd_ids.split(',') : [];
}

export function MessageDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const [m, setM] = useState<MessageRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (id === null) return;
    setM(null);
    setErr(null);
    api.get<MessageRow>(`/api/messages/${id}`).then(setM, (e) => setErr(e.message));
  }, [id]);
  const codes = m ? parseCodes(m.codes) : [];
  const explain = m ? explainCodes(m) : [];
  return (
    <Drawer
      open={id !== null}
      onClose={onClose}
      width={880}
      title={m ? <span className="flex items-center gap-2"><span className="font-mono text-base">{m.method ?? m.path}</span><span className="text-sm font-normal text-ink-3">#{m.id}</span></span> : `Message #${id}`}
      actions={m && m.method && !m.method.startsWith('admin/') && m.request ? (
        <Button size="sm" icon={SquareTerminal} onClick={() => navigate(`/console?from=${m.id}`)}>Replay in console</Button>
      ) : null}
    >
      {err && <div className="p-4"><ErrorNote>{err}</ErrorNote></div>}
      {!m && !err && <SkeletonRows rows={8} cols={3} />}
      {m && (
        <div className="space-y-4 p-4">
          <Readout
            cols={3}
            rows={[
              ['Time', <span className="num font-mono text-sm" title={iso(m.ts)}>{clockMs(m.ts)}</span>],
              ['Transport', <span className="flex items-center gap-2">{transportTag(m.transport)}<span className="font-mono text-xs text-ink-2">{m.remote_addr ?? ''}</span></span>],
              ['HTTP', <span className="flex items-center gap-2"><HttpTag status={m.http_status} /><span className="num text-sm text-ink-3">{m.duration_ms ?? 0} ms</span></span>],
              ['Path', <span className="font-mono text-xs">{m.path ?? '—'}</span>],
              ['Version', m.version ?? '—'],
              ['Response codes', codes.length ? <span className="flex flex-wrap gap-1">{codes.map((c, i) => <CodeTag key={i} code={c} />)}</span> : '—'],
              ['Client certificate', m.cert_subject ? <span className="break-all font-mono text-xs">{m.cert_subject}</span> : <span className="text-ink-3">none presented</span>],
              ['CBSDs', msgCbsdIds(m).length ? (
                <span className="flex flex-col">
                  {msgCbsdIds(m).map((c) => <CbsdName key={c} cbsdId={c} className="text-sel-ink" />)}
                </span>
              ) : '—'],
            ]}
          />
          {m.error && <ErrorNote>{m.error}</ErrorNote>}
          {explain.length > 0 && (
            <div className="rounded border border-line bg-panel-2 px-3 py-2">
              <div className="silk mb-1">Why the SAS answered this way</div>
              <ul className="space-y-0.5 text-sm text-ink-2">
                {explain.map((e, i) => <li key={i}><span className="font-mono text-xs text-ink">[{e.i}] {e.code} {RC_NAMES[e.code] ?? ''}</span> — {e.msg}</li>)}
              </ul>
            </div>
          )}
          <div className="grid gap-4 xl:grid-cols-2">
            <div className="min-w-0">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="silk">Request</span>
                {m.request !== null && m.request !== undefined && <CopyButton text={JSON.stringify(m.request, null, 2)} label="Copy request" />}
              </div>
              {m.request === null || m.request === undefined ? <p className="text-sm text-ink-3">No body</p> : <JsonView value={m.request} maxHeight={560} />}
            </div>
            <div className="min-w-0">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="silk">Response</span>
                {m.response !== null && m.response !== undefined && <CopyButton text={JSON.stringify(m.response, null, 2)} label="Copy response" />}
              </div>
              {m.response === null || m.response === undefined ? <p className="text-sm text-ink-3">No body</p> : <JsonView value={m.response} maxHeight={560} />}
            </div>
          </div>
        </div>
      )}
    </Drawer>
  );
}

/** Pull responseMessage of each non-zero response object out of the response body. */
function explainCodes(m: MessageRow): Array<{ i: number; code: number; msg: string }> {
  const out: Array<{ i: number; code: number; msg: string }> = [];
  const r = m.response;
  if (!r || typeof r !== 'object') return out;
  const arr = Object.values(r).find(Array.isArray) as any[] | undefined;
  (arr ?? []).forEach((o, i) => {
    const code = o?.response?.responseCode;
    if (typeof code === 'number' && code !== 0) {
      const data = o.response.responseData;
      out.push({ i, code, msg: [o.response.responseMessage, data !== undefined ? `responseData: ${JSON.stringify(data)}` : null].filter(Boolean).join(' · ') || 'no responseMessage' });
    }
  });
  return out;
}

export interface WireRow {
  id: number;
  ts: number;
  transport: string;
  remote: string | null;
  path: string | null;
  method: string | null;
  version: string | null;
  http: number | null;
  ms: number | null;
  cbsds: string[];
  codes: number[];
  cert: string | null;
  error: string | null;
}

/** SSE rows are camelCase, REST rows snake_case: normalise both. */
export function normMsg(m: MessageRow): WireRow {
  return {
    id: m.id, ts: m.ts, transport: m.transport, remote: m.remote_addr ?? m.remoteAddr ?? null, path: m.path ?? null,
    method: m.method ?? null, version: m.version ?? null, http: m.http_status ?? m.httpStatus ?? null, ms: m.duration_ms ?? m.durationMs ?? null,
    cbsds: msgCbsdIds(m), codes: parseCodes(m.codes), cert: m.cert_subject ?? m.certSubject ?? null, error: m.error ?? null,
  };
}

export function isErrorRow(r: WireRow): boolean {
  return !!r.error || (r.http ?? 0) >= 400 || r.codes.some((c) => c !== 0);
}
