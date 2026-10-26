// Formatting helpers: frequencies, times, durations, response codes.

export const RC_NAMES: Record<number, string> = {
  0: 'SUCCESS', 100: 'VERSION', 101: 'BLACKLISTED', 102: 'MISSING_PARAM', 103: 'INVALID_VALUE', 104: 'CERT_ERROR',
  105: 'DEREGISTER', 200: 'REG_PENDING', 201: 'GROUP_ERROR', 300: 'UNSUPPORTED_SPECTRUM', 400: 'INTERFERENCE',
  401: 'GRANT_CONFLICT', 500: 'TERMINATED_GRANT', 501: 'SUSPENDED_GRANT', 502: 'UNSYNC_OP_PARAM',
};

export const SAS_METHODS = ['registration', 'spectrumInquiry', 'grant', 'heartbeat', 'relinquishment', 'deregistration'] as const;

export function mhz(hz: number | null | undefined, digits?: number): string {
  if (hz === null || hz === undefined || !Number.isFinite(hz)) return '—';
  const v = hz / 1e6;
  const d = digits ?? (Number.isInteger(v) ? 0 : Math.abs(v * 10 - Math.round(v * 10)) < 1e-6 ? 1 : 3);
  return v.toFixed(d);
}

export function range(lo: number, hi: number): string {
  return `${mhz(lo)}–${mhz(hi)}`;
}

export function pad2(n: number) {
  return String(n).padStart(2, '0');
}

export function clock(ts: number | null | undefined, withDate = false): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const t = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  if (!withDate) return t;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${t}`;
}

export function clockMs(ts: number): string {
  const d = new Date(ts);
  return `${clock(ts)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function iso(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function dur(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad2(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${pad2(Math.floor((s % 3600) / 60))}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return 'never';
  const s = (now - ts) / 1000;
  if (s < 1.5) return 'just now';
  return `${dur(s)} ago`;
}

export function until(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  const s = (ts - now) / 1000;
  return s <= 0 ? `${dur(-s)} ago` : `in ${dur(s)}`;
}

export function parseCodes(codes: string | number[] | null | undefined): number[] {
  if (codes === null || codes === undefined || codes === '') return [];
  if (Array.isArray(codes)) return codes;
  return String(codes).split(',').filter(Boolean).map(Number);
}

export function rcTone(code: number): 'ok' | 'warn' | 'bad' {
  if (code === 0) return 'ok';
  if (code === 200 || code === 501 || code === 105) return 'warn';
  return 'bad';
}

export function bytesHuman(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Patch-cable identity colours. Slots are handed out in registration order so the first eight
// CBSDs never share a colour; slot order puts the hues furthest from the LED colours first.
const SLOT_ORDER = [2, 5, 3, 4, 7, 0, 1, 6];
const slots = new Map<string, number>();

/** Assign identity slots to CBSDs (oldest first). Existing assignments are kept stable. */
export function setPatchOrder(cbsdIds: string[]): boolean {
  let changed = false;
  const known = new Set(cbsdIds);
  for (const id of [...slots.keys()]) {
    if (!known.has(id)) {
      slots.delete(id);
      changed = true;
    }
  }
  const used = new Set(slots.values());
  for (const id of cbsdIds) {
    if (slots.has(id)) continue;
    let i = 0;
    while (used.has(i)) i++;
    slots.set(id, i);
    used.add(i);
    changed = true;
  }
  return changed;
}

function hashSlot(cbsdId: string): number {
  let h = 2166136261;
  for (let i = 0; i < cbsdId.length; i++) h = Math.imul(h ^ cbsdId.charCodeAt(i), 16777619);
  return (h >>> 0) % 8;
}

/** Patch colour index (0–7) for a CBSD; unknown CBSDs fall back to a hash. */
export function patchIndex(cbsdId: string): number {
  return SLOT_ORDER[(slots.get(cbsdId) ?? hashSlot(cbsdId)) % 8];
}

export function patchColor(cbsdId: string, alpha = 1): string {
  return `rgb(var(--p${patchIndex(cbsdId)}) / ${alpha})`;
}

export function shortId(id: string, n = 10): string {
  if (id.length <= n + 3) return id;
  return `${id.slice(0, n)}…`;
}

/** cbsdId is "<fccId>/<sha1(serial)>"; show the FCC ID and a short hash. */
export function cbsdLabel(cbsdId: string): string {
  const i = cbsdId.indexOf('/');
  return i > 0 ? `${cbsdId.slice(0, i)}/${cbsdId.slice(i + 1, i + 9)}` : cbsdId;
}
