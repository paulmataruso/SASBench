import type { Db, Row } from '../db.ts';
import { jparse } from '../db.ts';
import type { Bus } from '../bus.ts';
import type { RequestCtx, SasMethod } from './engine.ts';

// Fault injection for exercising CBSD / Domain Proxy error handling.
// Rules only alter what goes on the wire; SAS state is untouched (use grant/CBSD
// actions for state changes such as suspension or deregistration).

export type FaultAction = 'response_code' | 'patch' | 'http_status' | 'delay' | 'drop' | 'malformed';

export interface PreResult {
  ruleName: string;
  delayMs?: number;
  drop?: boolean;
  httpStatus?: number;
  body?: unknown;
  rawBody?: string;
}

const SUCCESS_ONLY: Record<string, string[]> = {
  registration: ['cbsdId', 'measReportConfig'],
  spectrumInquiry: ['availableChannel'],
  grant: ['grantId', 'grantExpireTime', 'heartbeatInterval', 'channelType', 'measReportConfig'],
  heartbeat: ['grantExpireTime', 'heartbeatInterval', 'measReportConfig'],
  relinquishment: [],
  deregistration: [],
};

export class FaultInjector {
  private db: Db;
  private bus: Bus;

  constructor(db: Db, bus: Bus) {
    this.db = db;
    this.bus = bus;
  }

  private active(method: SasMethod): Row[] {
    return this.db.all(
      "SELECT * FROM fault_rules WHERE enabled = 1 AND (remaining IS NULL OR remaining > 0) AND (method = '*' OR method = ?) ORDER BY id",
      method);
  }

  private matches(rule: Row, item: any, resp?: any): boolean {
    if (!rule.match_cbsd) return true;
    const needle = String(rule.match_cbsd);
    const ids: string[] = [];
    if (item && typeof item === 'object') {
      for (const k of ['cbsdId', 'fccId', 'cbsdSerialNumber', 'grantId']) if (typeof item[k] === 'string') ids.push(item[k]);
    }
    if (resp?.cbsdId) ids.push(resp.cbsdId);
    const cbsdId = item?.cbsdId ?? resp?.cbsdId;
    if (typeof cbsdId === 'string') {
      const c = this.db.get('SELECT fcc_id, serial FROM cbsds WHERE cbsd_id = ?', cbsdId);
      if (c) ids.push(c.fcc_id, c.serial);
    }
    return ids.some((x) => x === needle || x.includes(needle));
  }

  private hit(rule: Row) {
    this.db.run('UPDATE fault_rules SET hits = hits + 1, remaining = CASE WHEN remaining IS NULL THEN NULL ELSE remaining - 1 END WHERE id = ?', rule.id);
    this.bus.changed('faults');
  }

  /** Whole-exchange faults (HTTP status, drop, delay, malformed body). */
  preResponse(method: SasMethod, items: any[], _ctx: RequestCtx): PreResult | null {
    const whole = this.active(method).filter((r) => ['http_status', 'delay', 'drop', 'malformed'].includes(r.action));
    let delay = 0;
    for (const r of whole) {
      const applies = items.length ? items.some((i) => this.matches(r, i)) : !r.match_cbsd;
      if (!applies) continue;
      this.hit(r);
      const name = r.name || `rule #${r.id}`;
      this.bus.event('warn', 'fault', `Fault injected on ${method}: ${describe(r)}`);
      if (r.action === 'delay') {
        delay += r.delay_ms ?? 0;
        continue;
      }
      if (r.action === 'drop') return { ruleName: name, drop: true, delayMs: delay };
      if (r.action === 'http_status') return { ruleName: name, httpStatus: r.http_status ?? 500, delayMs: delay, body: jparse(r.response_data, undefined) };
      if (r.action === 'malformed') return { ruleName: name, rawBody: '{"' + method + 'Response": [ {"response": ', delayMs: delay };
    }
    return delay ? { ruleName: 'delay', delayMs: delay } : null;
  }

  /** Per-object faults: override responseCode or JSON-merge-patch individual response objects. */
  postResponse(method: SasMethod, items: any[], responses: any[], _ctx: RequestCtx) {
    const rules = this.active(method).filter((r) => r.action === 'response_code' || r.action === 'patch');
    if (!rules.length) return;
    responses.forEach((resp, i) => {
      for (const r of rules) {
        const fresh = this.db.get('SELECT remaining FROM fault_rules WHERE id = ?', r.id);
        if (fresh && fresh.remaining !== null && fresh.remaining <= 0) continue;
        if (!this.matches(r, items[i], resp)) continue;
        this.hit(r);
        if (r.action === 'response_code') {
          const code = Number(r.response_code ?? 0);
          if (code !== 0) for (const k of SUCCESS_ONLY[method] ?? []) delete resp[k];
          resp.response = { responseCode: code };
          if (r.response_message) resp.response.responseMessage = r.response_message;
          const data = jparse(r.response_data, undefined);
          if (data !== undefined) resp.response.responseData = data;
          if (method === 'heartbeat' && !resp.transmitExpireTime) resp.transmitExpireTime = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
        } else {
          mergePatch(resp, jparse(r.response_data, {}));
        }
        this.bus.event('warn', 'fault', `Fault injected on ${method} response #${i + 1}: ${describe(r)}`, resp.cbsdId ?? items[i]?.cbsdId);
        break;
      }
    });
  }
}

function describe(r: Row): string {
  switch (r.action) {
    case 'response_code': return `responseCode ${r.response_code}`;
    case 'http_status': return `HTTP ${r.http_status}`;
    case 'delay': return `delay ${r.delay_ms} ms`;
    case 'drop': return 'connection dropped';
    case 'malformed': return 'malformed JSON';
    case 'patch': return 'response patched';
    default: return r.action;
  }
}

/** RFC 7386 JSON merge patch. */
export function mergePatch(target: any, patch: any) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete target[k];
    else if (typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) mergePatch(target[k], v);
    else target[k] = v;
  }
}
