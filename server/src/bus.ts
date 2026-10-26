import { EventEmitter } from 'node:events';
import type { Db } from './db.ts';
import type { SettingsStore } from './settings.ts';

// Event bus: persists audit events and protocol message logs, and fans them out
// to UI clients over Server-Sent Events.

export type Level = 'info' | 'warn' | 'error' | 'success';

export interface MsgLogEntry {
  ts: number;
  transport: string;
  remoteAddr?: string;
  path?: string;
  method?: string;
  version?: string;
  httpStatus?: number;
  durationMs?: number;
  cbsdIds?: string[];
  codes?: number[];
  certSubject?: string;
  request?: unknown;
  response?: unknown;
  error?: string;
}

export class Bus extends EventEmitter {
  private pruneCounter = 0;

  private db: Db;
  private settings: SettingsStore;

  constructor(db: Db, settings: SettingsStore) {
    super();
    this.db = db;
    this.settings = settings;
    this.setMaxListeners(200);
  }

  event(level: Level, category: string, message: string, cbsdId?: string | null, grantId?: string | null) {
    const ts = Date.now();
    const r = this.db.run('INSERT INTO events(ts, level, category, message, cbsd_id, grant_id) VALUES (?,?,?,?,?,?)',
      ts, level, category, message, cbsdId ?? null, grantId ?? null);
    this.emit('sse', 'event', { id: Number(r.lastInsertRowid), ts, level, category, message, cbsdId, grantId });
    this.maybePrune();
  }

  message(e: MsgLogEntry) {
    const r = this.db.run(
      `INSERT INTO msg_log(ts, transport, remote_addr, path, method, version, http_status, duration_ms, cbsd_ids, codes,
        cert_subject, request, response, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      e.ts, e.transport, e.remoteAddr ?? null, e.path ?? null, e.method ?? null, e.version ?? null,
      e.httpStatus ?? null, e.durationMs ?? null, e.cbsdIds?.length ? e.cbsdIds.join(',') : null,
      e.codes?.length ? e.codes.join(',') : null, e.certSubject ?? null,
      e.request === undefined ? null : truncate(JSON.stringify(e.request)),
      e.response === undefined ? null : truncate(JSON.stringify(e.response)), e.error ?? null);
    this.emit('sse', 'message', {
      id: Number(r.lastInsertRowid), ts: e.ts, transport: e.transport, remoteAddr: e.remoteAddr, path: e.path,
      method: e.method, version: e.version, httpStatus: e.httpStatus, durationMs: e.durationMs,
      cbsdIds: e.cbsdIds ?? [], codes: e.codes ?? [], certSubject: e.certSubject, error: e.error,
    });
    this.maybePrune();
  }

  /** Notify UI that SAS state changed (cbsds / grants / settings / certs ...). */
  changed(what: string) {
    this.emit('sse', 'changed', { what });
  }

  private maybePrune() {
    if (++this.pruneCounter % 500 !== 0) return;
    const s = this.settings.get();
    this.db.run('DELETE FROM msg_log WHERE id <= (SELECT MAX(id) FROM msg_log) - ?', s.msgLogLimit);
    this.db.run('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?', s.eventLogLimit);
  }
}

function truncate(s: string, max = 512 * 1024): string {
  return s.length > max ? s.slice(0, max) : s;
}
