import type { Row } from '../../db.ts';
import { jparse } from '../../db.ts';
import type { Settings } from '../../settings.ts';
import type { CertRecord } from '../../pki/pki.ts';

// Database rows → API resources (camelCase). The CBSD, grant, protection and PPA shapes are the
// console's own (api.ts), so both APIs describe the same objects the same way.

export { cbsdOut, grantOut, protectionOut, ppaOut } from '../../api.ts';

export const eventOut = (r: Row) => ({
  id: r.id, ts: r.ts, level: r.level, category: r.category, message: r.message, cbsdId: r.cbsd_id ?? null, grantId: r.grant_id ?? null,
});

const list = (s: string | null | undefined) => (s ? String(s).split(',').filter(Boolean) : []);

export const messageOut = (r: Row) => ({
  id: r.id, ts: r.ts, transport: r.transport, remoteAddr: r.remote_addr ?? null, path: r.path ?? null, method: r.method ?? null,
  version: r.version ?? null, httpStatus: r.http_status ?? null, durationMs: r.duration_ms ?? null, cbsdIds: list(r.cbsd_ids),
  codes: list(r.codes).map(Number), certSubject: r.cert_subject ?? null, error: r.error ?? null,
});

export const messageDetailOut = (r: Row) => ({
  ...messageOut(r), request: jparse(r.request, r.request ?? null), response: jparse(r.response, r.response ?? null),
});

export const faultOut = (r: Row) => ({
  id: r.id, enabled: !!r.enabled, name: r.name ?? null, method: r.method, matchCbsd: r.match_cbsd ?? null, action: r.action,
  responseCode: r.response_code ?? null, responseData: jparse(r.response_data, r.response_data ?? null), responseMessage: r.response_message ?? null,
  httpStatus: r.http_status ?? null, delayMs: r.delay_ms ?? null, remaining: r.remaining ?? null, hits: r.hits, createdAt: r.created_at,
});

/** API (camelCase) fault rule → the snake_case fields faultVals() in api.ts expects. */
export const faultIn = (b: Record<string, any>) => ({
  enabled: b.enabled, name: b.name, method: b.method, match_cbsd: b.matchCbsd, action: b.action, response_code: b.responseCode,
  response_data: b.responseData, response_message: b.responseMessage, http_status: b.httpStatus, delay_ms: b.delayMs, remaining: b.remaining,
});

export const fccOut = (r: Row) => ({ fccId: r.fcc_id, maxEirp: r.max_eirp, createdAt: r.created_at });
export const userOut = (r: Row) => ({ userId: r.user_id, createdAt: r.created_at });
export const blacklistOut = (r: Row) => ({ id: r.id, fccId: r.fcc_id, serial: r.serial ?? null, reason: r.reason ?? null, createdAt: r.created_at });
export const conditionalOut = (r: Row) => ({ fccId: r.fcc_id, serial: r.serial, data: jparse(r.data, {}), source: r.source ?? null, createdAt: r.created_at });
export const cpiOut = (r: Row) => ({ cpiId: r.cpi_id, name: r.name ?? null, publicKey: r.public_key, source: r.source, createdAt: r.created_at });
export const incumbentOut = (r: Row) => ({ kind: r.kind, id: r.id, data: jparse(r.data, {}), createdAt: r.created_at });

export function certOut(c: CertRecord, s: Settings) {
  return { ...c, usage: { serverCertificate: s.serverCertIds.includes(c.id), trustedClientCa: s.trustedClientCaIds.includes(c.id) } };
}

export function crlOut(c: { id: string; name: string; issuerHash: string; thisUpdate: number | null; nextUpdate: number | null; revoked: string[] }) {
  return { id: c.id, name: c.name, issuerHash: c.issuerHash, thisUpdate: c.thisUpdate, nextUpdate: c.nextUpdate, revokedCount: c.revoked.length, revoked: c.revoked };
}
