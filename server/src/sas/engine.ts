import crypto from 'node:crypto';
import type { Db, Row } from '../db.ts';
import { jparse } from '../db.ts';
import type { SettingsStore, Settings } from '../settings.ts';
import type { Bus } from '../bus.ts';
import type { CertSummary } from '../pki/x509.ts';
import { WINNF_OID } from '../pki/x509.ts';
import { RC, RC_NAME, type ResponseObj } from './codes.ts';
import { Policy, cbsdViewFromRow, overlaps, merge, contains, type Range, type CbsdView } from './policy.ts';
import type { Terrain } from './terrain.ts';
import { toRfc3339, floorSec } from '../util/time.ts';
import { validateMeasReport } from './measReport.ts';
import { processRegistration } from './registration.ts';

// The SAS-CBSD protocol engine (WINNF-TS-0016 §7, §8, §10). Every request object in a
// message is processed in order inside one SQLite transaction, so batched (Domain
// Proxy) requests see the effects of earlier objects in the same array.

export const SAS_METHODS = ['registration', 'spectrumInquiry', 'grant', 'heartbeat', 'relinquishment', 'deregistration'] as const;
export type SasMethod = (typeof SAS_METHODS)[number];

export interface RequestCtx {
  transport: 'http' | 'https' | 'internal';
  remoteAddr: string;
  cert: CertSummary | null;
  certAuthorized: boolean;
  certError: string | null;
  version: string;
}

export type Resp = Record<string, any> & { response: ResponseObj };

export const LIVE_STATES = ['GRANTED', 'AUTHORIZED'];

export class Engine {
  readonly db: Db;
  readonly settings: SettingsStore;
  readonly bus: Bus;
  readonly policy: Policy;
  /** Harness trigger: include measReportConfig in registration responses. */
  measInRegistration = false;
  /** Harness trigger: include measReportConfig in heartbeat responses. */
  measInHeartbeat = false;
  /** Optional terrain model for the Category A HAAT rule. */
  terrain: Terrain | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(db: Db, settings: SettingsStore, bus: Bus) {
    this.db = db;
    this.settings = settings;
    this.bus = bus;
    this.policy = new Policy(db, () => settings.get());
  }

  get s(): Settings {
    return this.settings.get();
  }

  // ===================================================================== dispatch

  handle(method: SasMethod, items: any[], ctx: RequestCtx): Resp[] {
    const s = this.s;
    const versionOk = s.supportedVersions.includes(ctx.version);
    let changed = false;
    const out = this.db.tx(() => items.map((raw) => {
      const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      if (!versionOk) return this.versionError(method, item);
      changed = true;
      switch (method) {
        case 'registration': return processRegistration(this, item, ctx);
        case 'spectrumInquiry': return this.spectrumInquiry(item, ctx);
        case 'grant': return this.grant(item, ctx);
        case 'heartbeat': return this.heartbeat(item, ctx);
        case 'relinquishment': return this.relinquishment(item, ctx);
        case 'deregistration': return this.deregistration(item, ctx);
      }
    }));
    if (changed) this.bus.changed(method === 'registration' || method === 'deregistration' ? 'cbsds' : 'grants');
    return out;
  }

  // ===================================================================== helpers

  rc(code: number, data?: unknown, message?: string): ResponseObj {
    const r: ResponseObj = { responseCode: code };
    if (this.s.includeResponseMessage) r.responseMessage = message ?? RC_NAME[code] ?? 'UNKNOWN';
    if (data !== undefined) r.responseData = data;
    return r;
  }

  private versionError(method: SasMethod, item: any): Resp {
    const out: Resp = { response: this.rc(RC.VERSION, this.s.supportedVersions, 'Protocol version not supported') };
    if (method !== 'registration' && typeof item.cbsdId === 'string') out.cbsdId = item.cbsdId;
    if ((method === 'heartbeat' || method === 'relinquishment') && typeof item.grantId === 'string') out.grantId = item.grantId;
    if (method === 'heartbeat') out.transmitExpireTime = toRfc3339(floorSec(Date.now()) - 1000);
    return out;
  }

  cbsdRow(cbsdId: string): Row | undefined {
    return this.db.get("SELECT * FROM cbsds WHERE cbsd_id = ? AND state = 'REGISTERED'", cbsdId);
  }

  isBlacklisted(fccId: string, serial: string): boolean {
    return !!this.db.get('SELECT 1 FROM blacklist WHERE fcc_id = ? AND (serial IS NULL OR serial = ?)', fccId, serial);
  }

  /** Identity derived from a client certificate: WInnForum FCCID/SERIAL otherNames, else CN "fccId:serial". */
  static certIdentity(c: CertSummary | null): { fccId: string; serial: string } | null {
    if (!c) return null;
    if (c.fccId && c.cbsdSerial) return { fccId: c.fccId, serial: c.cbsdSerial };
    // CN "fccId:serialNumber" (WInnForum example profile) only for CBSD-role certificates.
    if (!c.roles.includes('CBSD') || c.roles.includes('OPERATOR')) return null;
    const cn = c.commonName ?? '';
    const i = cn.indexOf(':');
    if (i > 0 && i < cn.length - 1) return { fccId: cn.slice(0, i), serial: cn.slice(i + 1) };
    return null;
  }

  /**
   * WINNF-TS-0065 role check for CBSD-protocol requests. Returns a problem description when the
   * client certificate must be answered with responseCode 104 (CERT_ERROR), else null.
   *  lenient: reject certificates carrying non-CBSD WInnForum policies (ROLE_SAS, ZONE, FREQUENCY, ...),
   *           or WInnForum policies without ROLE_CBSD/ROLE_OPERATOR; generic certificates pass.
   *  strict:  additionally require ROLE_CBSD or ROLE_OPERATOR (and a certificate at all on HTTPS).
   */
  certRoleProblem(ctx: RequestCtx): string | null {
    const mode = this.s.certRoleCheck;
    if (mode === 'off' || ctx.transport !== 'https') return null;
    const c = ctx.cert;
    if (!c) return mode === 'strict' ? 'No client certificate presented' : null;
    const winnf = c.policies.filter((o) => o.startsWith(WINNF_OID.ARC));
    const allowed = [WINNF_OID_ROLE.CBSD, WINNF_OID_ROLE.OPERATOR, WINNF_OID.TEST];
    const foreign = winnf.filter((o) => !allowed.includes(o));
    if (foreign.length) return `Client certificate carries policies not permitted for CBSD/Domain Proxy use (${foreign.map(policyName).join(', ')})`;
    const hasRole = winnf.includes(WINNF_OID_ROLE.CBSD) || winnf.includes(WINNF_OID_ROLE.OPERATOR);
    if (!hasRole && (mode === 'strict' || winnf.length)) return 'Client certificate has neither the ROLE_CBSD nor the ROLE_OPERATOR policy';
    return null;
  }

  /** Per-element 104 responses for a request rejected by the certificate role check. */
  certErrorResponses(method: SasMethod, items: any[], problem: string): Resp[] {
    this.bus.event('error', 'security', `${method} request rejected with 104 CERT_ERROR: ${problem}`);
    return items.map(() => {
      const r: Resp = { response: this.rc(RC.CERT_ERROR, undefined, problem) };
      if (method === 'heartbeat') r.transmitExpireTime = toRfc3339(floorSec(Date.now()) - 1000);
      return r;
    });
  }

  /** WINNF.FT.S.GRA.4: a cbsdId may only be used over the TLS identity that registered it. */
  identityOk(cbsd: Row, ctx: RequestCtx): boolean {
    const mode = this.s.certIdentityCheck;
    if (mode === 'off' || !ctx.cert || !cbsd.cert_fingerprint) return true;
    if (ctx.cert.fingerprint256 === cbsd.cert_fingerprint) return true;
    const id = Engine.certIdentity(ctx.cert);
    if (id && id.fccId === cbsd.fcc_id && id.serial === cbsd.serial) return true;
    if (mode === 'warn') {
      this.bus.event('warn', 'security', `cbsdId ${cbsd.cbsd_id} used over a different TLS identity (${ctx.cert.subject})`, cbsd.cbsd_id);
      return true;
    }
    this.bus.event('warn', 'security', `Rejected cbsdId ${cbsd.cbsd_id}: request authenticated as ${ctx.cert.subject}, registered by another identity`, cbsd.cbsd_id);
    return false;
  }

  /**
   * Common cbsdId validation for all post-registration procedures.
   * Returns the CBSD row, or a ready-made error response.
   */
  private lookup(item: any, ctx: RequestCtx): { cbsd: Row } | { err: Resp } {
    if (item.cbsdId === undefined || item.cbsdId === null) return { err: { response: this.rc(RC.MISSING_PARAM, ['cbsdId']) } };
    if (typeof item.cbsdId !== 'string') return { err: { response: this.rc(RC.INVALID_VALUE, ['cbsdId']) } };
    const cbsd = this.cbsdRow(item.cbsdId);
    if (!cbsd) return { err: { response: this.rc(RC.INVALID_VALUE, ['cbsdId'], 'Unknown or unregistered cbsdId') } };
    if (!this.identityOk(cbsd, ctx)) return { err: { response: this.rc(RC.INVALID_VALUE, ['cbsdId'], 'cbsdId does not belong to the authenticated client') } };
    this.touch(cbsd, ctx);
    if (this.isBlacklisted(cbsd.fcc_id, cbsd.serial)) {
      this.terminateAll(cbsd.cbsd_id, 'blacklisted');
      return { err: { cbsdId: cbsd.cbsd_id, response: this.rc(RC.BLACKLISTED) } };
    }
    if (cbsd.pending_deregister) {
      this.deregister(cbsd.cbsd_id, 'SAS-initiated deregistration (105)');
      this.bus.event('warn', 'cbsd', `Sent DEREGISTER (105) to ${cbsd.cbsd_id}`, cbsd.cbsd_id);
      return { err: { cbsdId: cbsd.cbsd_id, response: this.rc(RC.DEREGISTER, undefined, 'Deregistered by the SAS administrator; the CBSD must register again') } };
    }
    return { cbsd };
  }

  private touch(cbsd: Row, ctx: RequestCtx) {
    this.db.run('UPDATE cbsds SET last_seen = ?, transport = ?, remote_addr = ? WHERE cbsd_id = ?', Date.now(), ctx.transport, ctx.remoteAddr, cbsd.cbsd_id);
  }

  view(cbsd: Row): CbsdView {
    return cbsdViewFromRow(cbsd);
  }

  liveGrants(cbsdId: string): Row[] {
    return this.db.all("SELECT * FROM grants WHERE cbsd_id = ? AND state IN ('GRANTED','AUTHORIZED')", cbsdId);
  }

  endGrant(grantId: string, state: 'TERMINATED' | 'RELINQUISHED' | 'EXPIRED' | 'DELETED', reason: string) {
    this.db.run('UPDATE grants SET state = ?, end_reason = ?, ended_at = ?, transmit_expire_time = NULL WHERE grant_id = ?',
      state, reason, Date.now(), grantId);
  }

  terminateAll(cbsdId: string, reason: string, silentState: 'TERMINATED' | 'RELINQUISHED' = 'TERMINATED') {
    const live = this.liveGrants(cbsdId);
    for (const g of live) this.endGrant(g.grant_id, silentState, reason);
    if (live.length) this.bus.event('warn', 'grant', `${live.length} grant(s) of ${cbsdId} ended (${reason})`, cbsdId);
  }

  /**
   * Remove every grant of a CBSD (deregistration / re-registration). Removed grants are kept
   * for the UI as DELETED and are unknown to the protocol afterwards (heartbeat → 103).
   * Returns the number of live grants that were removed.
   */
  deleteAllGrants(cbsdId: string, reason: string): number {
    const live = this.liveGrants(cbsdId).length;
    this.db.run(`UPDATE grants SET state = 'DELETED', end_reason = COALESCE(end_reason || '; ', '') || ?, ended_at = COALESCE(ended_at, ?),
      transmit_expire_time = NULL WHERE cbsd_id = ? AND state IN ('GRANTED','AUTHORIZED','TERMINATED','EXPIRED')`, reason, Date.now(), cbsdId);
    return live;
  }

  deregister(cbsdId: string, reason: string) {
    const n = this.deleteAllGrants(cbsdId, reason);
    if (n) this.bus.event('warn', 'grant', `${n} grant(s) of ${cbsdId} removed (${reason})`, cbsdId);
    this.db.run("UPDATE cbsds SET state = 'UNREGISTERED', pending_deregister = 0, updated_at = ?, meas_required = NULL WHERE cbsd_id = ?", Date.now(), cbsdId);
  }

  static makeCbsdId(fccId: string, serial: string): string {
    return `${fccId}/${crypto.createHash('sha1').update(serial).digest('hex')}`;
  }

  private newGrantId(): string {
    for (;;) {
      const id = String(crypto.randomInt(1e9, 9.9e9)) + String(crypto.randomInt(1e5, 9.9e5));
      if (!this.db.get('SELECT 1 FROM grants WHERE grant_id = ?', id)) return id;
    }
  }

  /**
   * RECEIVED_POWER_WITHOUT_GRANT reports requested in the registration response must accompany
   * spectrum inquiries / grants until a complete (full-band) report has been received.
   */
  private checkMeas(cbsd: Row, item: any, via: 'siq' | 'grant'): Resp | null {
    const req = jparse<any>(cbsd.meas_required, {});
    const s = this.s;
    const owed = !!req.withoutGrant;
    if (item.measReport === undefined) {
      if (!owed) return null;
      return { cbsdId: cbsd.cbsd_id, response: this.rc(RC.MISSING_PARAM, ['measReport'], 'Measurement report (RECEIVED_POWER_WITHOUT_GRANT) requested in the registration response') };
    }
    const v = validateMeasReport(item.measReport, { fullBand: owed, bandLow: s.bandLowHz, bandHigh: s.bandHighHz });
    if (!v.ok) return { cbsdId: cbsd.cbsd_id, response: this.rc(v.code, v.params, v.message) };
    this.db.run('UPDATE cbsds SET last_meas_report = ? WHERE cbsd_id = ?', JSON.stringify({ ts: Date.now(), via, report: item.measReport }), cbsd.cbsd_id);
    if (owed) {
      req.withoutGrant = false;
      this.db.run('UPDATE cbsds SET meas_required = ? WHERE cbsd_id = ?', JSON.stringify(req), cbsd.cbsd_id);
      this.bus.event('info', 'cbsd', `Received requested measurement report from ${cbsd.cbsd_id}`, cbsd.cbsd_id);
    }
    return null;
  }

  // ===================================================================== spectrum inquiry (§8.4)

  spectrumInquiry(item: any, ctx: RequestCtx): Resp {
    const l = this.lookup(item, ctx);
    if ('err' in l) return l.err;
    const cbsd = l.cbsd;
    const out = (code: number, data?: unknown, msg?: string): Resp => ({ cbsdId: cbsd.cbsd_id, response: this.rc(code, data, msg) });
    const s = this.s;

    if (item.inquiredSpectrum === undefined) return out(RC.MISSING_PARAM, ['inquiredSpectrum']);
    if (!Array.isArray(item.inquiredSpectrum)) return out(RC.INVALID_VALUE, ['inquiredSpectrum']);
    const ranges: Range[] = [];
    for (const fr of item.inquiredSpectrum) {
      if (!fr || typeof fr !== 'object') return out(RC.INVALID_VALUE, ['inquiredSpectrum']);
      const miss = ['lowFrequency', 'highFrequency'].filter((k) => fr[k] === undefined);
      if (miss.length) return out(RC.MISSING_PARAM, miss.map((k) => `inquiredSpectrum.${k}`));
      if (typeof fr.lowFrequency !== 'number' || typeof fr.highFrequency !== 'number' || fr.lowFrequency < 0 || fr.highFrequency < 0) {
        return out(RC.INVALID_VALUE, ['inquiredSpectrum']);
      }
      if (fr.lowFrequency >= fr.highFrequency) return out(RC.INVALID_VALUE, ['inquiredSpectrum']);
      ranges.push({ low: fr.lowFrequency, high: fr.highFrequency });
    }
    for (const r of ranges) {
      if (r.low < s.bandLowHz || r.high > s.bandHighHz) return out(RC.UNSUPPORTED_SPECTRUM, undefined, 'Inquired spectrum outside the CBRS band');
    }
    const m = this.checkMeas(cbsd, item, 'siq');
    if (m) return m;

    // Channels are built for each inquired range independently (never merged across entries).
    const view = this.view(cbsd);
    const channels: any[] = [];
    for (const r of ranges) {
      for (const ch of this.policy.siqChannels(view, r)) {
        const pieces = ch.channelType === 'PAL' ? [[ch.low, ch.high] as [number, number]] : channelize(ch.low, ch.high, s.siqChannelization);
        for (const [lo, hi] of pieces) {
          channels.push({
            frequencyRange: { lowFrequency: lo, highFrequency: hi },
            channelType: ch.channelType,
            ruleApplied: 'FCC_PART_96',
            maxEirp: ch.maxEirp,
          });
        }
      }
    }
    return { cbsdId: cbsd.cbsd_id, availableChannel: channels, response: this.rc(RC.SUCCESS) };
  }

  // ===================================================================== grant (§8.5)

  grant(item: any, ctx: RequestCtx): Resp {
    const l = this.lookup(item, ctx);
    if ('err' in l) return l.err;
    const cbsd = l.cbsd;
    const s = this.s;
    const out = (code: number, data?: unknown, msg?: string, extra: Record<string, any> = {}): Resp => {
      const r: Resp = { cbsdId: cbsd.cbsd_id, response: this.rc(code, data, msg), ...extra };
      if (code !== 0) this.bus.event('warn', 'grant', `Grant request from ${cbsd.cbsd_id} rejected: ${code} ${RC_NAME[code] ?? ''}${msg ? ' — ' + msg : ''}`, cbsd.cbsd_id);
      return r;
    };

    const op = item.operationParam;
    if (op === undefined) return out(RC.MISSING_PARAM, ['operationParam']);
    if (!op || typeof op !== 'object' || Array.isArray(op)) return out(RC.INVALID_VALUE, ['operationParam']);
    const missing: string[] = [];
    if (op.maxEirp === undefined) missing.push('operationParam.maxEirp');
    const fr = op.operationFrequencyRange;
    if (fr === undefined) missing.push('operationParam.operationFrequencyRange');
    else if (fr && typeof fr === 'object') {
      if (fr.lowFrequency === undefined) missing.push('operationParam.operationFrequencyRange.lowFrequency');
      if (fr.highFrequency === undefined) missing.push('operationParam.operationFrequencyRange.highFrequency');
    }
    if (missing.length) return out(RC.MISSING_PARAM, missing);
    if (!fr || typeof fr !== 'object' || typeof fr.lowFrequency !== 'number' || typeof fr.highFrequency !== 'number'
      || !Number.isFinite(fr.lowFrequency) || !Number.isFinite(fr.highFrequency) || fr.lowFrequency < 0 || fr.highFrequency < 0) {
      return out(RC.INVALID_VALUE, ['operationParam.operationFrequencyRange']);
    }
    if (typeof op.maxEirp !== 'number' || !Number.isFinite(op.maxEirp)) return out(RC.INVALID_VALUE, ['operationParam.maxEirp']);
    const range: Range = { low: fr.lowFrequency, high: fr.highFrequency };
    if (range.low >= range.high) return out(RC.INVALID_VALUE, ['operationParam.operationFrequencyRange'], 'lowFrequency must be less than highFrequency');
    if (range.low < s.bandLowHz || range.high > s.bandHighHz) return out(RC.UNSUPPORTED_SPECTRUM, undefined, 'Requested frequency range is outside the CBRS band');
    if (op.maxEirp < -137 || op.maxEirp > 37) return out(RC.INVALID_VALUE, ['operationParam.maxEirp'], 'maxEirp must be within -137..37 dBm/MHz');

    if (s.grantFrequencyStepHz > 0 && (range.low % s.grantFrequencyStepHz !== 0 || range.high % s.grantFrequencyStepHz !== 0)) {
      return out(RC.INVALID_VALUE, ['operationParam.operationFrequencyRange'], `Grant edges must be multiples of ${s.grantFrequencyStepHz / 1e6} MHz`);
    }

    const m = this.checkMeas(cbsd, item, 'grant');
    if (m) return m;

    const view = this.view(cbsd);
    const lim10 = this.policy.maxEirpPer10MHz(view);
    if (op.maxEirp + 10 > lim10) {
      return out(RC.INVALID_VALUE, ['operationParam.maxEirp'], `maxEirp exceeds ${lim10 - 10} dBm/MHz (min of FCC certified, eirpCapability and Category ${view.category} limit)`);
    }

    // Peer-SAS duplicate (CBSD already holds a grant from another SAS) — WINNF.FT.S.GRA.5
    if (this.hasPeerSasGrant(cbsd)) return out(RC.GRANT_CONFLICT, undefined, 'CBSD already holds a grant from another SAS');

    // Same-CBSD conflicts, including earlier objects in this batch
    const live = this.liveGrants(cbsd.cbsd_id);
    const conflicts = live.filter((g) => overlaps({ low: g.low_freq, high: g.high_freq }, range));
    if (conflicts.length) return out(RC.GRANT_CONFLICT, conflicts.map((g) => g.grant_id), 'Overlaps an existing grant of this CBSD');
    if (live.length >= s.maxGrantsPerCbsd) return out(RC.INTERFERENCE, undefined, `CBSD already holds the maximum of ${s.maxGrantsPerCbsd} grants`);

    // PAL / PPA rules
    const { memberPpas, excludingPpas } = this.policy.palContext(view, range);
    let channelType: 'PAL' | 'GAA' = 'GAA';
    let palExpiry: number | null = null;
    if (memberPpas.length) {
      const palSegs = merge(memberPpas.flatMap((p) => p.channels.map((c) => ({ low: c.low, high: c.high }))));
      if (palSegs.some((seg) => contains(seg, range))) {
        channelType = 'PAL';
        for (const p of memberPpas) {
          for (const c of p.channels) {
            if (!overlaps(c, range)) continue;
            const exp = Math.min(c.licenseExpiration ?? Infinity, p.expiration ?? Infinity);
            if (Number.isFinite(exp)) palExpiry = Math.min(palExpiry ?? Infinity, exp);
          }
        }
      } else {
        return out(RC.INVALID_VALUE, ['operationParam.operationFrequencyRange'], 'Requested range mixes PAL and GAA spectrum');
      }
    }
    if (excludingPpas.length && channelType === 'GAA') {
      return out(RC.INTERFERENCE, undefined, `Overlaps PAL channel of PPA ${excludingPpas[0].name}`,
        this.suggestion(view, range));
    }
    if (channelType === 'GAA' && !this.policy.inGaaPlan(range)) {
      return out(RC.INTERFERENCE, undefined, 'Requested spectrum is not available for GAA in this SAS', this.suggestion(view, range));
    }
    const hits = this.policy.protectionHits(view, range);
    if (hits.length) {
      return out(RC.INTERFERENCE, undefined, `Requested spectrum is protected: ${hits.map((h) => `${h.kind} ${h.name}`).join(', ')}`,
        this.suggestion(view, range));
    }
    if (range.high - range.low > s.maxGrantBandwidthHz) {
      return out(RC.INTERFERENCE, undefined, `Bandwidth exceeds the configured maximum of ${s.maxGrantBandwidthHz / 1e6} MHz`,
        this.suggestion(view, { low: range.low, high: range.low + s.maxGrantBandwidthHz }));
    }
    const capMhz = view.eirpCapDbmMhz;
    if (capMhz != null && op.maxEirp > capMhz) {
      return out(RC.INTERFERENCE, undefined, `maxEirp exceeds the administrative limit of ${capMhz} dBm/MHz for this CBSD`,
        { operationParam: { maxEirp: capMhz, operationFrequencyRange: { lowFrequency: range.low, highFrequency: range.high } } });
    }

    // Approved
    const now = floorSec(Date.now());
    let expire = now + s.grantExpireSec * 1000;
    if (palExpiry != null) expire = Math.min(expire, floorSec(palExpiry));
    const grantId = this.newGrantId();
    this.db.run(
      `INSERT INTO grants(grant_id, cbsd_id, state, low_freq, high_freq, max_eirp, channel_type, grant_expire_time,
        heartbeat_interval, created_at, request) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      grantId, cbsd.cbsd_id, 'GRANTED', range.low, range.high, op.maxEirp, channelType, expire, s.heartbeatIntervalSec,
      Date.now(), JSON.stringify(item));
    this.bus.event('success', 'grant', `Grant ${grantId} issued to ${cbsd.cbsd_id}: ${fmtRange(range)} @ ${op.maxEirp} dBm/MHz (${channelType})`, cbsd.cbsd_id, grantId);
    const resp: Resp = {
      cbsdId: cbsd.cbsd_id,
      grantId,
      grantExpireTime: toRfc3339(expire),
      heartbeatInterval: Math.max(1, Math.round(s.heartbeatIntervalSec)),
      channelType,
      response: this.rc(RC.SUCCESS),
    };
    const caps = jparse<string[]>(cbsd.meas_capability, []);
    if (this.measInHeartbeat && caps.includes('RECEIVED_POWER_WITH_GRANT')) resp.measReportConfig = ['RECEIVED_POWER_WITH_GRANT'];
    return resp;
  }

  private suggestion(view: CbsdView, range: Range): Record<string, any> {
    if (!this.s.suggestOperationParam) return {};
    const avoid = this.liveGrants(view.cbsdId).map((g) => ({ low: g.low_freq, high: g.high_freq }));
    const sug = this.policy.suggest(view, range, avoid);
    return sug ? { operationParam: sug } : {};
  }

  hasPeerSasGrant(cbsd: Row): boolean {
    const ref = `cbsd/${cbsd.fcc_id}/${crypto.createHash('sha1').update(cbsd.serial).digest('hex')}`;
    const r = this.db.get("SELECT data FROM harness_data WHERE kind = 'fad_cbsd' AND id = ?", ref);
    if (!r) return false;
    const d = jparse<any>(r.data, {});
    return (d.grants ?? []).some((g: any) => !g.terminated);
  }

  // ===================================================================== heartbeat (§8.6)

  heartbeat(item: any, ctx: RequestCtx): Resp {
    const r = this.heartbeatInner(item, ctx);
    if (r.response.responseCode !== RC.SUCCESS && !r.transmitExpireTime) {
      r.transmitExpireTime = toRfc3339(floorSec(Date.now()) - 1000);
    }
    // keep the conventional key order: cbsdId, grantId, transmitExpireTime, ...
    const { cbsdId, grantId, transmitExpireTime, ...rest } = r;
    const ordered: any = {};
    if (cbsdId !== undefined) ordered.cbsdId = cbsdId;
    if (grantId !== undefined) ordered.grantId = grantId;
    ordered.transmitExpireTime = transmitExpireTime;
    return Object.assign(ordered, rest);
  }

  private heartbeatInner(item: any, ctx: RequestCtx): Resp {
    const l = this.lookup(item, ctx);
    if ('err' in l) return l.err;
    const cbsd = l.cbsd;
    const s = this.s;
    const now = floorSec(Date.now());
    const base = { cbsdId: cbsd.cbsd_id };

    if (item.grantId === undefined || item.grantId === null) return { ...base, response: this.rc(RC.MISSING_PARAM, ['grantId']) };
    const g = typeof item.grantId === 'string'
      ? this.db.get('SELECT * FROM grants WHERE grant_id = ? AND cbsd_id = ?', item.grantId, cbsd.cbsd_id)
      : undefined;
    const gidEcho = g && g.state !== 'DELETED' ? { grantId: g.grant_id } : {};
    if (item.operationState === undefined || item.operationState === null) {
      return { ...base, ...gidEcho, response: this.rc(RC.MISSING_PARAM, ['operationState']) };
    }
    if (!g) return { ...base, response: this.rc(RC.INVALID_VALUE, ['grantId'], 'Unknown grantId for this CBSD') };
    if (item.operationState !== 'AUTHORIZED' && item.operationState !== 'GRANTED') {
      return { ...base, grantId: g.grant_id, response: this.rc(RC.INVALID_VALUE, ['operationState']) };
    }
    if (item.grantRenew !== undefined && typeof item.grantRenew !== 'boolean') {
      return { ...base, grantId: g.grant_id, response: this.rc(RC.INVALID_VALUE, ['grantRenew']) };
    }

    // Dead grants
    if (g.state === 'RELINQUISHED') return { ...base, response: this.rc(RC.INVALID_VALUE, ['grantId'], 'Grant was relinquished') };
    if (g.state === 'DELETED') return { ...base, response: this.rc(RC.INVALID_VALUE, ['grantId'], 'Unknown grantId for this CBSD (grants are removed on registration/deregistration)') };
    if (g.state === 'TERMINATED') return { ...base, grantId: g.grant_id, response: this.rc(RC.TERMINATED_GRANT, undefined, g.end_reason ? `Grant terminated: ${g.end_reason}` : undefined) };
    if (g.state === 'EXPIRED' || g.grant_expire_time <= now) {
      if (g.state !== 'EXPIRED') {
        this.endGrant(g.grant_id, 'EXPIRED', 'grantExpireTime reached');
        this.bus.event('warn', 'grant', `Grant ${g.grant_id} expired`, cbsd.cbsd_id, g.grant_id);
      }
      return { ...base, grantId: g.grant_id, response: this.rc(RC.TERMINATED_GRANT, undefined, 'Grant expired') };
    }

    // Optional measurement report
    if (item.measReport !== undefined) {
      const v = validateMeasReport(item.measReport, { fullBand: false, bandLow: s.bandLowHz, bandHigh: s.bandHighHz });
      if (!v.ok) return { ...base, grantId: g.grant_id, response: this.rc(v.code, v.params, v.message) };
      this.db.run('UPDATE cbsds SET last_meas_report = ? WHERE cbsd_id = ?', JSON.stringify({ ts: Date.now(), via: 'heartbeat', grantId: g.grant_id, report: item.measReport }), cbsd.cbsd_id);
    }

    const view = this.view(cbsd);
    const range: Range = { low: g.low_freq, high: g.high_freq };
    const renew = item.grantRenew === true;
    let newExpire = g.grant_expire_time;
    if (renew) {
      newExpire = Math.max(g.grant_expire_time, now + s.grantExpireSec * 1000);
      const pal = g.channel_type === 'PAL' ? this.palExpiryFor(cbsd.cbsd_id, range) : null;
      if (pal != null) newExpire = Math.max(g.grant_expire_time, Math.min(newExpire, floorSec(pal)));
    }
    const renewExtra = renew ? { grantExpireTime: toRfc3339(newExpire) } : {};

    // SAS-initiated termination (protection with action "terminate", PPA exclusion)
    const hits = this.policy.protectionHits(view, range);
    const term = hits.find((h) => h.action === 'terminate');
    if (term) {
      this.endGrant(g.grant_id, 'TERMINATED', `${term.kind} ${term.name}`);
      this.bus.event('warn', 'grant', `Grant ${g.grant_id} TERMINATED (500): ${term.kind} ${term.name} active`, cbsd.cbsd_id, g.grant_id);
      return { ...base, grantId: g.grant_id, ...this.suggestion(view, range), response: this.rc(RC.TERMINATED_GRANT, undefined, `Protection active: ${term.kind} ${term.name}`) };
    }

    // Out of sync: CBSD believes it is AUTHORIZED but SAS has it GRANTED.
    if (item.operationState === 'AUTHORIZED' && g.state === 'GRANTED' && (g.heartbeat_count === 0 || s.strictOperationState)) {
      this.endGrant(g.grant_id, 'TERMINATED', 'UNSYNC_OP_PARAM');
      this.bus.event('warn', 'grant', `Grant ${g.grant_id}: CBSD reported AUTHORIZED while SAS state is GRANTED → 502 UNSYNC_OP_PARAM`, cbsd.cbsd_id, g.grant_id);
      return { ...base, grantId: g.grant_id, response: this.rc(RC.UNSYNC_OP_PARAM) };
    }

    // Suspension: admin, protection or spectrum no longer available
    let suspendWhy: string | null = null;
    if (g.suspended) suspendWhy = 'Suspended by SAS administrator';
    else if (hits.length) suspendWhy = `Protection active: ${hits.map((h) => `${h.kind} ${h.name}`).join(', ')}`;
    else if (g.channel_type === 'GAA' && !this.policy.inGaaPlan(range)) suspendWhy = 'Spectrum no longer available for GAA';
    else if (g.channel_type === 'GAA' && this.policy.palContext(view, range).excludingPpas.length) suspendWhy = 'Overlaps a PAL Protection Area channel';
    if (suspendWhy) {
      const wasAuth = g.state === 'AUTHORIZED';
      this.db.run("UPDATE grants SET state = 'GRANTED', transmit_expire_time = NULL, last_heartbeat = ?, heartbeat_count = heartbeat_count + 1, grant_expire_time = ? WHERE grant_id = ?",
        Date.now(), newExpire, g.grant_id);
      if (wasAuth) this.bus.event('warn', 'grant', `Grant ${g.grant_id} SUSPENDED (501): ${suspendWhy}`, cbsd.cbsd_id, g.grant_id);
      return {
        ...base, grantId: g.grant_id, transmitExpireTime: toRfc3339(now - 1000), ...renewExtra,
        ...this.suggestion(view, range), response: this.rc(RC.SUSPENDED_GRANT, undefined, suspendWhy),
      };
    }

    // Success: authorize until transmitExpireTime (strictly before grantExpireTime)
    const tx = Math.min(now + s.transmitExpireSec * 1000, newExpire - 1000);
    const wasState = g.state;
    let hbInterval: number | null = null;
    if (g.pending_hb_interval) hbInterval = g.pending_hb_interval;
    this.db.run(
      `UPDATE grants SET state = 'AUTHORIZED', transmit_expire_time = ?, last_heartbeat = ?, heartbeat_count = heartbeat_count + 1,
        grant_expire_time = ?, pending_hb_interval = NULL, heartbeat_interval = COALESCE(?, heartbeat_interval) WHERE grant_id = ?`,
      tx, Date.now(), newExpire, hbInterval, g.grant_id);
    this.db.run('UPDATE cbsds SET last_heartbeat_ok = ? WHERE cbsd_id = ?', Date.now(), cbsd.cbsd_id);
    if (wasState !== 'AUTHORIZED') this.bus.event('success', 'grant', `Grant ${g.grant_id} AUTHORIZED (${fmtRange(range)})`, cbsd.cbsd_id, g.grant_id);
    if (renew) this.bus.event('info', 'grant', `Grant ${g.grant_id} renewed until ${toRfc3339(newExpire)}`, cbsd.cbsd_id, g.grant_id);

    const resp: Resp = { ...base, grantId: g.grant_id, transmitExpireTime: toRfc3339(tx), ...renewExtra, response: this.rc(RC.SUCCESS) };
    if (hbInterval) resp.heartbeatInterval = hbInterval;
    const sug = jparse<any>(g.suggested_op_param, null);
    if (sug) resp.operationParam = sug;
    const caps = jparse<string[]>(cbsd.meas_capability, []);
    const pendingCfg = jparse<string[] | null>(cbsd.meas_report_config, null);
    if (this.measInHeartbeat && caps.includes('RECEIVED_POWER_WITH_GRANT')) resp.measReportConfig = ['RECEIVED_POWER_WITH_GRANT'];
    else if (pendingCfg?.length) {
      const ok = pendingCfg.filter((c) => caps.includes(c));
      if (ok.length) resp.measReportConfig = ok;
      this.db.run('UPDATE cbsds SET meas_report_config = NULL WHERE cbsd_id = ?', cbsd.cbsd_id);
    }
    return resp;
  }

  palExpiryFor(cbsdId: string, range: Range): number | null {
    let exp: number | null = null;
    for (const p of this.policy.ppas()) {
      if (!p.members.includes(cbsdId)) continue;
      for (const c of p.channels) {
        if (!overlaps(c, range)) continue;
        const e = Math.min(c.licenseExpiration ?? Infinity, p.expiration ?? Infinity);
        if (Number.isFinite(e)) exp = Math.min(exp ?? Infinity, e);
      }
    }
    return exp;
  }

  // ===================================================================== relinquishment (§8.7)

  relinquishment(item: any, ctx: RequestCtx): Resp {
    const l = this.lookup(item, ctx);
    if ('err' in l) return l.err;
    const cbsd = l.cbsd;
    const base = { cbsdId: cbsd.cbsd_id };
    if (item.grantId === undefined || item.grantId === null) return { ...base, response: this.rc(RC.MISSING_PARAM, ['grantId']) };
    const g = typeof item.grantId === 'string'
      ? this.db.get("SELECT * FROM grants WHERE grant_id = ? AND cbsd_id = ? AND state IN ('GRANTED','AUTHORIZED','TERMINATED')", item.grantId, cbsd.cbsd_id)
      : undefined;
    if (!g) return { ...base, response: this.rc(RC.INVALID_VALUE, ['grantId'], 'Unknown grantId for this CBSD') };
    this.endGrant(g.grant_id, 'RELINQUISHED', 'relinquished by CBSD');
    this.bus.event('info', 'grant', `Grant ${g.grant_id} relinquished by ${cbsd.cbsd_id}`, cbsd.cbsd_id, g.grant_id);
    return { ...base, grantId: g.grant_id, response: this.rc(RC.SUCCESS) };
  }

  // ===================================================================== deregistration (§8.8)

  deregistration(item: any, ctx: RequestCtx): Resp {
    if (item.cbsdId === undefined || item.cbsdId === null) return { response: this.rc(RC.MISSING_PARAM, ['cbsdId']) };
    if (typeof item.cbsdId !== 'string') return { response: this.rc(RC.INVALID_VALUE, ['cbsdId']) };
    const cbsd = this.cbsdRow(item.cbsdId);
    if (!cbsd) return { response: this.rc(RC.INVALID_VALUE, ['cbsdId'], 'Unknown or unregistered cbsdId') };
    if (!this.identityOk(cbsd, ctx)) return { response: this.rc(RC.INVALID_VALUE, ['cbsdId'], 'cbsdId does not belong to the authenticated client') };
    this.touch(cbsd, ctx);
    this.deregister(cbsd.cbsd_id, 'deregistered by CBSD');
    this.bus.event('info', 'cbsd', `CBSD ${cbsd.cbsd_id} deregistered`, cbsd.cbsd_id);
    return { cbsdId: cbsd.cbsd_id, response: this.rc(RC.SUCCESS) };
  }

  // ===================================================================== timers

  startSweeper() {
    this.sweepTimer = setInterval(() => {
      try {
        this.sweep();
      } catch (e: any) {
        this.bus.event('error', 'engine', `Sweeper error: ${e.message}`);
      }
    }, 1000);
    this.sweepTimer.unref();
  }

  stopSweeper() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Time-driven state transitions (WINNF-TS-0016 §7, §8.6). */
  sweep() {
    const now = Date.now();
    let changed = false;
    for (const g of this.db.all("SELECT grant_id, cbsd_id FROM grants WHERE state = 'AUTHORIZED' AND transmit_expire_time IS NOT NULL AND transmit_expire_time < ?", now)) {
      this.db.run("UPDATE grants SET state = 'GRANTED' WHERE grant_id = ?", g.grant_id);
      this.bus.event('warn', 'grant', `Grant ${g.grant_id}: transmitExpireTime passed without heartbeat → GRANTED (CBSD must stop transmitting)`, g.cbsd_id, g.grant_id);
      changed = true;
    }
    for (const g of this.db.all("SELECT grant_id, cbsd_id FROM grants WHERE state IN ('GRANTED','AUTHORIZED') AND grant_expire_time <= ?", now)) {
      this.endGrant(g.grant_id, 'EXPIRED', 'grantExpireTime reached');
      this.bus.event('warn', 'grant', `Grant ${g.grant_id} expired`, g.cbsd_id, g.grant_id);
      changed = true;
    }
    const lostBefore = now - this.s.connectivityLostSec * 1000;
    for (const c of this.db.all(
      `SELECT DISTINCT g.cbsd_id FROM grants g JOIN cbsds c ON c.cbsd_id = g.cbsd_id WHERE g.state IN ('GRANTED','AUTHORIZED')
        AND COALESCE(c.last_heartbeat_ok, g.created_at) < ? AND g.created_at < ?`, lostBefore, lostBefore)) {
      this.terminateAll(c.cbsd_id, 'SAS-CBSD connectivity lost (no successful heartbeat)');
      changed = true;
    }
    if (changed) this.bus.changed('grants');
  }

  // ===================================================================== admin actions

  adminSuspend(grantId: string, suspended: boolean) {
    const g = this.db.get('SELECT * FROM grants WHERE grant_id = ?', grantId);
    if (!g) throw new Error('Grant not found');
    this.db.run('UPDATE grants SET suspended = ? WHERE grant_id = ?', suspended ? 1 : 0, grantId);
    this.bus.event('warn', 'admin', `Grant ${grantId} ${suspended ? 'suspended' : 'resumed'} by administrator (effective at next heartbeat)`, g.cbsd_id, grantId);
    this.bus.changed('grants');
  }

  adminTerminate(grantId: string, reason = 'terminated by administrator') {
    const g = this.db.get('SELECT * FROM grants WHERE grant_id = ?', grantId);
    if (!g) throw new Error('Grant not found');
    this.endGrant(grantId, 'TERMINATED', reason);
    this.bus.event('warn', 'admin', `Grant ${grantId} terminated by administrator (500 at next heartbeat)`, g.cbsd_id, grantId);
    this.bus.changed('grants');
  }
}

const WINNF_OID_ROLE = {
  SAS: '1.3.6.1.4.1.46609.1.1.1',
  CBSD: '1.3.6.1.4.1.46609.1.1.3',
  OPERATOR: '1.3.6.1.4.1.46609.1.1.4',
};

function policyName(oid: string): string {
  if (WINNF_OID.ROLE[oid]) return `ROLE_${WINNF_OID.ROLE[oid]}`;
  if (oid === WINNF_OID.ZONE) return 'ZONE';
  if (oid === WINNF_OID.FREQUENCY) return 'FREQUENCY';
  return oid;
}

export function fmtRange(r: Range): string {
  return `${(r.low / 1e6).toFixed(1).replace(/\.0$/, '')}–${(r.high / 1e6).toFixed(1).replace(/\.0$/, '')} MHz`;
}

export function channelize(low: number, high: number, mode: string): Array<[number, number]> {
  const step = mode === '5MHz' ? 5e6 : mode === '10MHz' ? 10e6 : 0;
  if (!step) return [[low, high]];
  const out: Array<[number, number]> = [];
  let lo = low;
  while (lo < high) {
    const next = Math.min(high, (Math.floor(lo / step) + 1) * step);
    out.push([lo, next]);
    lo = next;
  }
  return out;
}
