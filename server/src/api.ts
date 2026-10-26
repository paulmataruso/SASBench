import crypto from 'node:crypto';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db, Row } from './db.ts';
import { jparse } from './db.ts';
import type { SettingsStore, Settings } from './settings.ts';
import { DEFAULT_SETTINGS } from './settings.ts';
import type { Bus } from './bus.ts';
import type { Pki, KeyType, CaRole, DnInput } from './pki/pki.ts';
import type { Engine, RequestCtx, SasMethod } from './sas/engine.ts';
import { SAS_METHODS } from './sas/engine.ts';
import type { SasServer } from './net/sasServer.ts';
import type { SasAdmin } from './sas/admin.ts';
import { NotFound } from './sas/admin.ts';
import { HttpError, Router, readBody, sendBuffer, sendJson } from './net/http.ts';
import { PRESETS } from './presets.ts';
import { signCpiData } from './sas/cpi.ts';
import { RC_NAME } from './sas/codes.ts';
import { cbsdViewFromRow } from './sas/policy.ts';
import { toRfc3339 } from './util/time.ts';

// REST API for the web UI (/api/...) and the WInnForum harness admin hook (/admin/... on the SAS listeners).

export interface ApiDeps {
  db: Db;
  settings: SettingsStore;
  bus: Bus;
  pki: Pki;
  engine: Engine;
  sas: SasServer;
  admin: SasAdmin;
  startedAt: number;
  version: string;
  uiPort: number;
  hostnames: string[];
}

const GRANT_STATES = ['GRANTED', 'AUTHORIZED', 'TERMINATED', 'RELINQUISHED', 'EXPIRED', 'DELETED'];

export function buildApi(d: ApiDeps): Router {
  const { db, settings, bus, pki, engine, sas, admin } = d;
  const r = new Router();
  const need = (v: any, name: string) => {
    if (v === undefined || v === null || v === '') throw new HttpError(400, `${name} is required`);
    return v;
  };

  // ------------------------------------------------------------------ status

  r.get('/api/status', () => {
    const s = settings.get();
    const count = (q: string, ...p: any[]) => db.get(q, ...p)?.n ?? 0;
    const grantsByState: Record<string, number> = {};
    for (const g of db.all('SELECT state, COUNT(*) AS n FROM grants GROUP BY state')) grantsByState[g.state] = g.n;
    const since = Date.now() - 3600e3;
    return {
      version: d.version, startedAt: d.startedAt, now: Date.now(), hostname: os.hostname(),
      listeners: sas.getStatus(), urls: sasUrls(s, d.hostnames),
      counts: {
        cbsdsRegistered: count("SELECT COUNT(*) AS n FROM cbsds WHERE state = 'REGISTERED'"),
        cbsdsPending: count("SELECT COUNT(*) AS n FROM cbsds WHERE state = 'PENDING'"),
        cbsdsTotal: count('SELECT COUNT(*) AS n FROM cbsds'),
        grantsByState,
        authorizedMHz: (db.get("SELECT COALESCE(SUM(high_freq - low_freq), 0) AS n FROM grants WHERE state = 'AUTHORIZED'")?.n ?? 0) / 1e6,
        messagesLastHour: count('SELECT COUNT(*) AS n FROM msg_log WHERE ts > ?', since),
        errorsLastHour: count('SELECT COUNT(*) AS n FROM msg_log WHERE ts > ? AND (error IS NOT NULL OR http_status >= 400)', since),
        activeProtections: count('SELECT COUNT(*) AS n FROM protections WHERE active = 1'),
        ppas: count('SELECT COUNT(*) AS n FROM ppas'),
        faultRules: count('SELECT COUNT(*) AS n FROM fault_rules WHERE enabled = 1'),
      },
      triggers: { measInRegistration: engine.measInRegistration, measInHeartbeat: engine.measInHeartbeat },
      daily: admin.daily, flags: admin.flags,
      terrain: { directory: engine.terrain?.directory ?? null, tiles: engine.terrain?.tileCount ?? 0 },
      profile: detectProfile(s),
    };
  });

  r.get('/api/activity', ({ query }) => {
    const minutes = Math.min(1440, Number(query.get('minutes') ?? 60));
    const bucket = minutes <= 60 ? 60e3 : 5 * 60e3;
    const since = Date.now() - minutes * 60e3;
    const rows = db.all(`SELECT (ts / ?) * ? AS b, method, COUNT(*) AS n,
      SUM(CASE WHEN error IS NOT NULL OR http_status >= 400 OR (codes IS NOT NULL AND codes != '0' AND codes NOT LIKE '0,%') THEN 1 ELSE 0 END) AS e
      FROM msg_log WHERE ts > ? GROUP BY b, method ORDER BY b`, bucket, bucket, since);
    return { bucketMs: bucket, since, rows };
  });

  // ------------------------------------------------------------------ settings

  r.get('/api/settings', () => ({ settings: redact(settings.get()), defaults: redact(DEFAULT_SETTINGS), presets: PRESETS, profile: detectProfile(settings.get()) }));
  r.put('/api/settings', async ({ body }) => {
    const patch = await body();
    validateSettings(patch);
    const changed = settings.update(patch);
    if (changed.length) bus.event('info', 'settings', `Settings changed: ${changed.join(', ')}`);
    bus.changed('settings');
    return { changed, settings: redact(settings.get()) };
  });
  r.post('/api/settings/preset/:name', ({ params }) => {
    const p = PRESETS[params.name];
    if (!p) throw new HttpError(404, 'Unknown preset');
    const changed = settings.update(p.patch);
    bus.event('info', 'settings', `Applied settings profile "${p.label}"`);
    bus.changed('settings');
    return { changed, settings: redact(settings.get()) };
  });
  r.post('/api/settings/defaults', () => {
    settings.resetToDefaults(['serverCertIds', 'trustedClientCaIds', 'uiPassword', 'sasHttpPort', 'sasHttpsPort']);
    bus.event('warn', 'settings', 'Settings restored to defaults');
    bus.changed('settings');
    return { settings: redact(settings.get()) };
  });

  // ------------------------------------------------------------------ CBSDs

  r.get('/api/cbsds', ({ query }) => {
    const state = query.get('state');
    const rows = state ? db.all('SELECT * FROM cbsds WHERE state = ? ORDER BY updated_at DESC', state) : db.all('SELECT * FROM cbsds ORDER BY updated_at DESC');
    const gcount = new Map<string, Record<string, number>>();
    for (const g of db.all('SELECT cbsd_id, state, COUNT(*) AS n FROM grants GROUP BY cbsd_id, state')) {
      const m = gcount.get(g.cbsd_id) ?? {};
      m[g.state] = g.n;
      gcount.set(g.cbsd_id, m);
    }
    return rows.map((c) => cbsdOut(c, gcount.get(c.cbsd_id) ?? {}));
  });
  r.get('/api/cbsds/:id', ({ params }) => {
    const c = db.get('SELECT * FROM cbsds WHERE cbsd_id = ?', params.id);
    if (!c) throw new HttpError(404, 'CBSD not found');
    const grants = db.all('SELECT * FROM grants WHERE cbsd_id = ? ORDER BY created_at DESC LIMIT 200', params.id).map(grantOut);
    const events = db.all('SELECT * FROM events WHERE cbsd_id = ? ORDER BY id DESC LIMIT 100', params.id);
    const messages = db.all(`SELECT id, ts, transport, method, http_status, codes, error FROM msg_log WHERE ',' || cbsd_ids || ',' LIKE ?
      ORDER BY id DESC LIMIT 100`, `%,${params.id},%`);
    const view = cbsdViewFromRow(c);
    const pre = db.get('SELECT data FROM conditional_reg WHERE fcc_id = ? AND serial = ?', c.fcc_id, c.serial);
    return {
      ...cbsdOut(c, {}), grants, events, messages, conditional: jparse(pre?.data, null),
      limits: { maxEirpPer10MHz: engine.policy.maxEirpPer10MHz(view), maxEirpDbmMhz: engine.policy.maxEirpDbmMhz(view) },
      availability: engine.policy.availability(view),
      protections: engine.policy.protections().filter((p) => engine.policy.affects(p, view)).map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
    };
  });
  r.patch('/api/cbsds/:id', async ({ params, body }) => {
    const b = await body();
    const c = db.get('SELECT * FROM cbsds WHERE cbsd_id = ?', params.id);
    if (!c) throw new HttpError(404, 'CBSD not found');
    if ('notes' in b) db.run('UPDATE cbsds SET notes = ? WHERE cbsd_id = ?', b.notes ?? null, params.id);
    if ('eirpCapDbmMhz' in b) db.run('UPDATE cbsds SET eirp_cap_dbm_mhz = ? WHERE cbsd_id = ?', b.eirpCapDbmMhz === null || b.eirpCapDbmMhz === '' ? null : Number(b.eirpCapDbmMhz), params.id);
    if ('regMeasConfig' in b) db.run('UPDATE cbsds SET reg_meas_config = ? WHERE cbsd_id = ?', JSON.stringify(b.regMeasConfig ?? []), params.id);
    if ('hbMeasConfig' in b) db.run('UPDATE cbsds SET meas_report_config = ? WHERE cbsd_id = ?', b.hbMeasConfig?.length ? JSON.stringify(b.hbMeasConfig) : null, params.id);
    bus.changed('cbsds');
    return { ok: true };
  });
  r.post('/api/cbsds/:id/approve', ({ params }) => {
    const c = db.get('SELECT * FROM cbsds WHERE cbsd_id = ?', params.id);
    if (!c) throw new HttpError(404, 'CBSD not found');
    db.run('UPDATE cbsds SET approved = 1 WHERE cbsd_id = ?', params.id);
    bus.event('success', 'admin', `Registration of ${params.id} approved (completes on the CBSD's next registration request)`, params.id);
    bus.changed('cbsds');
    return { ok: true };
  });
  r.post('/api/cbsds/:id/deregister', ({ params }) => {
    const c = db.get("SELECT * FROM cbsds WHERE cbsd_id = ? AND state = 'REGISTERED'", params.id);
    if (!c) throw new HttpError(404, 'Registered CBSD not found');
    db.run('UPDATE cbsds SET pending_deregister = 1 WHERE cbsd_id = ?', params.id);
    bus.event('warn', 'admin', `CBSD ${params.id} will receive DEREGISTER (105) on its next request`, params.id);
    bus.changed('cbsds');
    return { ok: true };
  });
  r.post('/api/cbsds/:id/force-deregister', ({ params }) => {
    engine.deregister(params.id, 'deregistered by administrator');
    bus.event('warn', 'admin', `CBSD ${params.id} deregistered by administrator`, params.id);
    bus.changed('cbsds');
    return { ok: true };
  });
  r.delete('/api/cbsds/:id', ({ params }) => {
    db.tx(() => {
      db.run('DELETE FROM grants WHERE cbsd_id = ?', params.id);
      db.run('DELETE FROM cbsds WHERE cbsd_id = ?', params.id);
    });
    bus.event('warn', 'admin', `CBSD ${params.id} and its grants deleted`, params.id);
    bus.changed('cbsds');
    return { ok: true };
  });

  // ------------------------------------------------------------------ grants

  r.get('/api/grants', ({ query }) => {
    const states = (query.get('state') ?? '').split(',').filter((x) => GRANT_STATES.includes(x));
    const cbsd = query.get('cbsdId');
    const where: string[] = [];
    const p: any[] = [];
    if (states.length) where.push(`g.state IN (${states.map(() => '?').join(',')})`), p.push(...states);
    if (cbsd) where.push('g.cbsd_id = ?'), p.push(cbsd);
    const limit = Math.min(5000, Number(query.get('limit') ?? 1000));
    return db.all(`SELECT g.*, c.fcc_id, c.serial, c.category FROM grants g LEFT JOIN cbsds c ON c.cbsd_id = g.cbsd_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY g.created_at DESC LIMIT ?`, ...p, limit).map(grantOut);
  });
  r.post('/api/grants/:id/suspend', async ({ params, body }) => {
    const b = await body();
    engine.adminSuspend(params.id, b.suspended !== false);
    return { ok: true };
  });
  r.post('/api/grants/:id/terminate', async ({ params, body }) => {
    const b = await body();
    engine.adminTerminate(params.id, b.reason || 'terminated by administrator');
    return { ok: true };
  });
  r.patch('/api/grants/:id', async ({ params, body }) => {
    const b = await body();
    const g = db.get('SELECT * FROM grants WHERE grant_id = ?', params.id);
    if (!g) throw new HttpError(404, 'Grant not found');
    if ('heartbeatInterval' in b) {
      const v = b.heartbeatInterval === null || b.heartbeatInterval === '' ? null : Math.max(1, Math.round(Number(b.heartbeatInterval)));
      db.run('UPDATE grants SET pending_hb_interval = ? WHERE grant_id = ?', v, params.id);
    }
    if ('suggestedOperationParam' in b) db.run('UPDATE grants SET suggested_op_param = ? WHERE grant_id = ?', b.suggestedOperationParam ? JSON.stringify(b.suggestedOperationParam) : null, params.id);
    if ('grantExpireTime' in b) {
      const t = Date.parse(b.grantExpireTime);
      if (!Number.isFinite(t)) throw new HttpError(400, 'Invalid grantExpireTime');
      db.run('UPDATE grants SET grant_expire_time = ? WHERE grant_id = ?', Math.floor(t / 1000) * 1000, params.id);
    }
    bus.event('info', 'admin', `Grant ${params.id} updated (${Object.keys(b).join(', ')})`, g.cbsd_id, params.id);
    bus.changed('grants');
    return { ok: true };
  });
  r.delete('/api/grants/ended', () => {
    const n = db.run("DELETE FROM grants WHERE state IN ('TERMINATED','RELINQUISHED','EXPIRED','DELETED')").changes;
    bus.changed('grants');
    return { deleted: n };
  });

  // ------------------------------------------------------------------ registry

  r.get('/api/registry', () => ({
    fccIds: db.all('SELECT * FROM fcc_ids ORDER BY fcc_id'),
    userIds: db.all('SELECT * FROM user_ids ORDER BY user_id'),
    blacklist: db.all('SELECT * FROM blacklist ORDER BY id DESC'),
    conditional: db.all('SELECT * FROM conditional_reg ORDER BY created_at DESC').map((x) => ({ ...x, data: jparse(x.data, {}) })),
    cpiUsers: db.all('SELECT * FROM cpi_users ORDER BY cpi_id'),
  }));
  r.post('/api/registry/fcc-ids', async ({ body }) => {
    const b = await body();
    admin.injectFccId(need(b.fccId, 'fccId'), b.maxEirp === '' || b.maxEirp == null ? 47 : Number(b.maxEirp));
    return { ok: true };
  });
  r.delete('/api/registry/fcc-ids/:id', ({ params }) => {
    db.run('DELETE FROM fcc_ids WHERE fcc_id = ?', params.id);
    bus.changed('registry');
    return { ok: true };
  });
  r.post('/api/registry/user-ids', async ({ body }) => {
    admin.injectUserId(need((await body()).userId, 'userId'));
    return { ok: true };
  });
  r.delete('/api/registry/user-ids/:id', ({ params }) => {
    db.run('DELETE FROM user_ids WHERE user_id = ?', params.id);
    bus.changed('registry');
    return { ok: true };
  });
  r.post('/api/registry/blacklist', async ({ body }) => {
    const b = await body();
    admin.blacklist(need(b.fccId, 'fccId'), b.serial || null, b.reason || 'blacklisted by administrator');
    return { ok: true };
  });
  r.delete('/api/registry/blacklist/:id', ({ params }) => {
    db.run('DELETE FROM blacklist WHERE id = ?', Number(params.id));
    bus.event('info', 'admin', 'Blacklist entry removed');
    bus.changed('registry');
    return { ok: true };
  });
  r.post('/api/registry/conditional', async ({ body }) => {
    const b = await body();
    admin.preloadRegistration(Array.isArray(b) ? b : Array.isArray(b.registrationData) ? b.registrationData : [b], 'ui');
    return { ok: true };
  });
  r.delete('/api/registry/conditional/:fcc/:serial', ({ params }) => {
    db.run('DELETE FROM conditional_reg WHERE fcc_id = ? AND serial = ?', params.fcc, params.serial);
    bus.changed('registry');
    return { ok: true };
  });
  r.post('/api/registry/cpi-users', async ({ body }) => {
    const b = await body();
    let key: string = b.publicKey ?? '';
    if (b.certId) key = crypto.createPublicKey(new crypto.X509Certificate(pki.getRow(b.certId)?.cert_pem ?? '').publicKey).export({ type: 'spki', format: 'pem' }) as string;
    else if (key.includes('BEGIN CERTIFICATE')) key = new crypto.X509Certificate(key).publicKey.export({ type: 'spki', format: 'pem' }) as string;
    admin.injectCpiUser(need(b.cpiId, 'cpiId'), b.name ?? '', need(key, 'publicKey'), 'ui');
    return { ok: true };
  });
  r.delete('/api/registry/cpi-users/:id', ({ params }) => {
    db.run('DELETE FROM cpi_users WHERE cpi_id = ?', params.id);
    bus.changed('registry');
    return { ok: true };
  });

  // ------------------------------------------------------------------ spectrum: protections, DPAs, PPAs, incumbents

  r.get('/api/spectrum', () => {
    const s = settings.get();
    return {
      band: { low: s.bandLowHz, high: s.bandHighHz }, gaaRanges: s.gaaRanges,
      protections: db.all('SELECT * FROM protections ORDER BY kind, name').map(protectionOut),
      ppas: db.all('SELECT * FROM ppas ORDER BY created_at').map(ppaOut),
      grants: db.all(`SELECT g.grant_id, g.cbsd_id, g.state, g.suspended, g.low_freq, g.high_freq, g.max_eirp, g.channel_type,
        c.effective FROM grants g JOIN cbsds c ON c.cbsd_id = g.cbsd_id WHERE g.state IN ('GRANTED','AUTHORIZED')`).map((g) => {
        const ip = jparse<any>(g.effective, {}).installationParam ?? {};
        return { grantId: g.grant_id, cbsdId: g.cbsd_id, state: g.state, suspended: !!g.suspended, low: g.low_freq, high: g.high_freq,
          maxEirp: g.max_eirp, channelType: g.channel_type, lat: ip.latitude ?? null, lon: ip.longitude ?? null };
      }),
      cbsds: db.all("SELECT cbsd_id, fcc_id, serial, category, effective, state FROM cbsds WHERE state = 'REGISTERED'").map((c) => {
        const v = cbsdViewFromRow(c);
        return { cbsdId: c.cbsd_id, fccId: c.fcc_id, serial: c.serial, category: v.category, lat: v.lat, lon: v.lon, indoor: v.indoor };
      }),
      incumbents: { fss: admin.data('fss'), wisp: admin.data('wisp'), pal: admin.data('pal'), escSensors: admin.data('esc_sensor'), peerSas: admin.data('peer_sas') },
    };
  });
  r.post('/api/protections', async ({ body }) => {
    const b = await body();
    const id = b.id || `ui:${crypto.randomUUID()}`;
    upsertProtection(db, id, b);
    bus.event('info', 'admin', `Protection "${b.name}" saved (${b.kind}, ${b.active ? 'active' : 'inactive'})`);
    bus.changed('spectrum');
    return { id };
  });
  r.put('/api/protections/:id', async ({ params, body }) => {
    const b = await body();
    upsertProtection(db, params.id, b);
    bus.event('info', 'admin', `Protection "${b.name}" updated (${b.active ? 'active' : 'inactive'})`);
    bus.changed('spectrum');
    return { ok: true };
  });
  r.post('/api/protections/:id/active', async ({ params, body }) => {
    const b = await body();
    const p = db.get('SELECT * FROM protections WHERE id = ?', params.id);
    if (!p) throw new HttpError(404, 'Protection not found');
    db.run('UPDATE protections SET active = ?, channels = ?, updated_at = ? WHERE id = ?', b.active ? 1 : 0,
      Array.isArray(b.channels) && b.channels.length ? JSON.stringify(b.channels) : null, Date.now(), params.id);
    bus.event('warn', 'admin', `${p.kind} ${p.name} ${b.active ? 'ACTIVATED' : 'deactivated'}${Array.isArray(b.channels) && b.channels.length ? ' on ' + b.channels.map((c: number[]) => `${c[0] / 1e6}–${c[1] / 1e6}`).join(', ') + ' MHz' : ''}`);
    bus.changed('spectrum');
    return { ok: true };
  });
  r.delete('/api/protections/:id', ({ params }) => {
    db.run('DELETE FROM protections WHERE id = ?', params.id);
    bus.changed('spectrum');
    return { ok: true };
  });
  r.post('/api/dpas/load', async ({ body }) => {
    const b = await body();
    return { loaded: admin.loadDpas(b.file === 'P-DPAs.kml' ? 'P-DPAs.kml' : 'E-DPAs.kml', !!b.activate) };
  });
  r.post('/api/dpas/bulk', async ({ body }) => {
    admin.bulkDpaActivation(!!(await body()).activate);
    return { ok: true };
  });
  r.post('/api/dpas/clear', () => {
    db.run("DELETE FROM protections WHERE kind = 'DPA'");
    bus.changed('spectrum');
    return { ok: true };
  });
  r.post('/api/ppas', async ({ body }) => {
    const b = await body();
    const id = b.id || `zone/ppa/ui/${crypto.randomUUID()}`;
    upsertPpa(db, id, b);
    bus.event('info', 'admin', `PPA "${b.name}" saved`);
    bus.changed('spectrum');
    return { id };
  });
  r.put('/api/ppas/:id', async ({ params, body }) => {
    upsertPpa(db, params.id, await body());
    bus.changed('spectrum');
    return { ok: true };
  });
  r.delete('/api/ppas/:id', ({ params }) => {
    db.run('DELETE FROM ppas WHERE id = ?', params.id);
    db.run("DELETE FROM harness_data WHERE kind = 'zone' AND id = ?", params.id);
    bus.changed('spectrum');
    return { ok: true };
  });
  r.post('/api/incumbents/:kind', async ({ params, body }) => {
    const b = await body();
    switch (params.kind) {
      case 'fss': admin.injectFss(b); break;
      case 'wisp': admin.injectWisp(b); break;
      case 'pal': admin.injectPal(b); break;
      case 'zone': return { id: admin.injectZone(b) };
      case 'exclusion_zone': return { id: admin.injectExclusionZone(b) };
      case 'peer_sas': admin.putData('peer_sas', need(b.url, 'url'), b); break;
      default: throw new HttpError(404, 'Unknown incumbent kind');
    }
    return { ok: true };
  });
  r.delete('/api/incumbents/:kind/:id', ({ params }) => {
    db.run('DELETE FROM harness_data WHERE kind = ? AND id = ?', params.kind, params.id);
    admin.rebuildDerived();
    return { ok: true };
  });

  // ------------------------------------------------------------------ operations

  r.post('/api/daily-activities', async () => {
    await admin.triggerDailyActivities();
    return admin.daily;
  });
  r.post('/api/triggers', async ({ body }) => {
    const b = await body();
    if ('measInRegistration' in b) engine.measInRegistration = !!b.measInRegistration;
    if ('measInHeartbeat' in b) engine.measInHeartbeat = !!b.measInHeartbeat;
    bus.event('info', 'admin', `Measurement report triggers: registration=${engine.measInRegistration}, heartbeat=${engine.measInHeartbeat}`);
    bus.changed('status');
    return { measInRegistration: engine.measInRegistration, measInHeartbeat: engine.measInHeartbeat };
  });
  r.post('/api/reset', async ({ body }) => {
    const b = await body();
    if (b.confirm !== 'RESET') throw new HttpError(400, 'Confirmation required');
    admin.reset('administrator');
    if (b.logs) {
      db.run('DELETE FROM msg_log');
      db.run('DELETE FROM events');
    }
    return { ok: true };
  });
  r.post('/api/listeners/restart', async () => {
    await sas.restart();
    return sas.getStatus();
  });

  // ------------------------------------------------------------------ fault injection

  r.get('/api/faults', () => db.all('SELECT * FROM fault_rules ORDER BY id').map((f) => ({ ...f, enabled: !!f.enabled, response_data: jparse(f.response_data, null) })));
  r.post('/api/faults', async ({ body }) => {
    const b = await body();
    const info = db.run(`INSERT INTO fault_rules(enabled, name, method, match_cbsd, action, response_code, response_data, response_message,
      http_status, delay_ms, remaining, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, ...faultVals(b), Date.now());
    bus.event('warn', 'fault', `Fault rule "${b.name || b.action}" created`);
    bus.changed('faults');
    return { id: Number(info.lastInsertRowid) };
  });
  r.put('/api/faults/:id', async ({ params, body }) => {
    const b = await body();
    db.run(`UPDATE fault_rules SET enabled = ?, name = ?, method = ?, match_cbsd = ?, action = ?, response_code = ?, response_data = ?,
      response_message = ?, http_status = ?, delay_ms = ?, remaining = ? WHERE id = ?`, ...faultVals(b), Number(params.id));
    bus.changed('faults');
    return { ok: true };
  });
  r.delete('/api/faults/:id', ({ params }) => {
    db.run('DELETE FROM fault_rules WHERE id = ?', Number(params.id));
    bus.changed('faults');
    return { ok: true };
  });

  // ------------------------------------------------------------------ logs

  r.get('/api/messages', ({ query }) => {
    const where: string[] = [];
    const p: any[] = [];
    const before = query.get('before');
    if (before) where.push('id < ?'), p.push(Number(before));
    const method = query.get('method');
    if (method) where.push('method = ?'), p.push(method);
    const cbsd = query.get('cbsdId');
    if (cbsd) where.push("',' || cbsd_ids || ',' LIKE ?"), p.push(`%,${cbsd},%`);
    if (query.get('errors') === '1') where.push("(error IS NOT NULL OR http_status >= 400 OR (codes IS NOT NULL AND codes GLOB '*[1-9]*'))");
    const q = query.get('q');
    if (q) where.push('(request LIKE ? OR response LIKE ? OR error LIKE ? OR remote_addr LIKE ?)'), p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    const limit = Math.min(1000, Number(query.get('limit') ?? 200));
    return db.all(`SELECT id, ts, transport, remote_addr, path, method, version, http_status, duration_ms, cbsd_ids, codes, cert_subject, error
      FROM msg_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`, ...p, limit);
  });
  r.get('/api/messages/:id', ({ params }) => {
    const m = db.get('SELECT * FROM msg_log WHERE id = ?', Number(params.id));
    if (!m) throw new HttpError(404, 'Message not found');
    return { ...m, request: jparse(m.request, m.request), response: jparse(m.response, m.response) };
  });
  r.delete('/api/messages', () => {
    db.run('DELETE FROM msg_log');
    bus.changed('messages');
    return { ok: true };
  });
  r.get('/api/messages-export', ({ res, query }) => {
    const limit = Math.min(100000, Number(query.get('limit') ?? 20000));
    const rows = db.all('SELECT * FROM msg_log ORDER BY id DESC LIMIT ?', limit).reverse()
      .map((m) => JSON.stringify({ ...m, request: jparse(m.request, m.request), response: jparse(m.response, m.response) }));
    sendBuffer(res, 200, rows.join('\n') + '\n', 'application/x-ndjson', `sas-messages-${Date.now()}.ndjson`);
  });
  r.get('/api/events', ({ query }) => {
    const limit = Math.min(2000, Number(query.get('limit') ?? 300));
    const before = query.get('before');
    const level = query.get('level');
    const where: string[] = [];
    const p: any[] = [];
    if (before) where.push('id < ?'), p.push(Number(before));
    if (level) where.push('level = ?'), p.push(level);
    return db.all(`SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`, ...p, limit);
  });
  r.delete('/api/events', () => {
    db.run('DELETE FROM events');
    bus.changed('events');
    return { ok: true };
  });

  // ------------------------------------------------------------------ request console

  r.post('/api/console', async ({ body }) => {
    const b = await body();
    const method = b.method as SasMethod;
    if (!SAS_METHODS.includes(method)) throw new HttpError(400, 'Unknown method');
    const payload = typeof b.payload === 'string' ? JSON.parse(b.payload) : b.payload;
    const items = payload?.[`${method}Request`];
    if (!Array.isArray(items)) throw new HttpError(400, `Payload must contain a "${method}Request" array`);
    const ctx: RequestCtx = { transport: 'internal', remoteAddr: 'ui-console', cert: null, certAuthorized: false, certError: null, version: b.version || settings.get().supportedVersions[0] || 'v1.2' };
    const started = Date.now();
    const responses = engine.handle(method, items, ctx);
    const out = { [`${method}Response`]: responses };
    bus.message({
      ts: started, transport: 'internal', remoteAddr: 'ui-console', path: `/${ctx.version}/${method}`, method, version: ctx.version, httpStatus: 200,
      durationMs: Date.now() - started, request: payload, response: out,
      codes: responses.map((x) => x.response.responseCode),
      cbsdIds: [...new Set(responses.map((x) => x.cbsdId).filter(Boolean))] as string[],
    });
    return out;
  });
  r.get('/api/response-codes', () => RC_NAME);

  // ------------------------------------------------------------------ certificates

  r.get('/api/certs', () => ({
    certs: pki.list(),
    serverCertIds: settings.get().serverCertIds,
    trustedClientCaIds: settings.get().trustedClientCaIds,
    crls: pki.listCrls().map((c) => ({ ...c, revokedCount: c.revoked.length, revoked: c.revoked.slice(0, 200) })),
  }));
  r.get('/api/certs/:id', ({ params }) => {
    const c = pki.get(params.id);
    if (!c) throw new HttpError(404, 'Certificate not found');
    return { ...c, pem: pki.getRow(params.id)!.cert_pem, chain: pki.chainOf(params.id).map((x) => ({ id: x.id, name: x.name, kind: x.kind })) };
  });
  r.post('/api/certs/root', async ({ body }) => {
    const b = await body();
    return pki.createRoot({ dn: dn(b), keyType: kt(b.keyType, 'rsa4096'), days: num(b.days), name: b.name });
  });
  r.post('/api/certs/sub-ca', async ({ body }) => {
    const b = await body();
    return pki.createSubCa({ parentId: need(b.parentId, 'parentId'), role: need(b.role, 'role') as CaRole, dn: dn(b), keyType: kt(b.keyType, 'rsa4096'), days: num(b.days), name: b.name });
  });
  r.post('/api/certs/server', async ({ body }) => {
    const b = await body();
    const sans: string[] = (Array.isArray(b.sans) ? b.sans : String(b.sans ?? '').split(/[\s,]+/)).map((x: string) => x.trim()).filter(Boolean);
    const c = pki.issueServer({ parentId: need(b.parentId, 'parentId'), dn: dn(b), sans: sans.length ? sans : [b.CN], keyType: kt(b.keyType, 'rsa2048'), days: num(b.days), name: b.name, frn: b.frn || undefined });
    if (b.use) {
      const ids = b.use === 'replace' ? [c.id] : [...settings.get().serverCertIds, c.id];
      settings.update({ serverCertIds: ids });
    }
    bus.changed('certs');
    return c;
  });
  r.post('/api/certs/cbsd', async ({ body }) => {
    const b = await body();
    const c = pki.issueCbsd({ parentId: need(b.parentId, 'parentId'), fccId: need(b.fccId, 'fccId'), serial: need(b.serial, 'serial'),
      dn: { CN: b.CN || undefined, O: b.O || undefined, OU: b.OU || undefined }, keyType: kt(b.keyType, 'rsa2048'), days: num(b.days), name: b.name });
    if (b.registerFccId) admin.injectFccId(b.fccId, 47);
    bus.changed('certs');
    return c;
  });
  r.post('/api/certs/cbsd-batch', async ({ body, res }) => {
    const b = await body();
    const lines: string[] = String(b.devices ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new HttpError(400, 'No devices given (one "fccId,serial" per line)');
    const { zipSync, strToU8 } = await import('fflate');
    const files: Record<string, Uint8Array> = {};
    for (const line of lines) {
      const [fccId, serial] = line.split(/[,;\t ]+/);
      if (!fccId || !serial) throw new HttpError(400, `Bad line: ${line}`);
      const c = pki.issueCbsd({ parentId: need(b.parentId, 'parentId'), fccId, serial, keyType: kt(b.keyType, 'rsa2048'), days: num(b.days) });
      const zip = pki.radioBundle(c.id, { password: b.password || 'cbrs', serverCertId: settings.get().serverCertIds[0] ?? null, sasUrls: sasUrls(settings.get(), d.hostnames) });
      files[`${safe(fccId)}_${safe(serial)}.zip`] = zip;
    }
    files['devices.txt'] = strToU8(lines.join('\n') + '\n');
    bus.changed('certs');
    sendBuffer(res, 200, Buffer.from(zipSync(files)), 'application/zip', `cbsd-certificates-${lines.length}.zip`);
  });
  r.post('/api/certs/domain-proxy', async ({ body }) => {
    const b = await body();
    const c = pki.issueDomainProxy({ parentId: need(b.parentId, 'parentId'), dn: dn(b), frn: b.frn || undefined, keyType: kt(b.keyType, 'rsa2048'), days: num(b.days), name: b.name });
    bus.changed('certs');
    return c;
  });
  r.post('/api/certs/installer', async ({ body }) => {
    const b = await body();
    const c = pki.issueInstaller({ parentId: need(b.parentId, 'parentId'), cpiId: need(b.cpiId, 'cpiId'), cpiName: need(b.cpiName, 'cpiName'), keyType: kt(b.keyType, 'rsa2048'), days: num(b.days) });
    if (b.registerCpi !== false) {
      const pub = new crypto.X509Certificate(pki.getRow(c.id)!.cert_pem).publicKey.export({ type: 'spki', format: 'pem' }) as string;
      admin.injectCpiUser(b.cpiId, b.cpiName, pub, 'ui');
    }
    bus.changed('certs');
    return c;
  });
  r.post('/api/certs/import', async ({ body }) => {
    const b = await body();
    const out = pki.importPem({ pem: need(b.pem, 'pem'), keyPem: b.keyPem || undefined, name: b.name || undefined, passphrase: b.passphrase || undefined });
    bus.event('info', 'certs', `Imported ${out.length} certificate(s)`);
    bus.changed('certs');
    return out;
  });
  r.post('/api/certs/import-p12', async ({ body }) => {
    const b = await body();
    const out = importP12(pki, Buffer.from(need(b.data, 'data'), 'base64'), b.password ?? '', b.name);
    bus.event('info', 'certs', `Imported ${out.length} certificate(s) from PKCS#12`);
    bus.changed('certs');
    return out;
  });
  r.post('/api/certs/use-as-server', async ({ body }) => {
    const b = await body();
    const ids: string[] = Array.isArray(b.ids) ? b.ids : [];
    for (const id of ids) if (!pki.getRow(id)?.key_pem) throw new HttpError(400, 'Every server certificate needs a private key');
    settings.update({ serverCertIds: ids });
    bus.event('info', 'certs', `SAS HTTPS server certificate(s) set to ${ids.map((i) => pki.getRow(i)?.name).join(', ')}`);
    return { ok: true };
  });
  r.post('/api/certs/trusted-cas', async ({ body }) => {
    const b = await body();
    settings.update({ trustedClientCaIds: Array.isArray(b.ids) ? b.ids : [] });
    return { ok: true };
  });
  r.post('/api/certs/:id/revoke', async ({ params, body }) => {
    const b = await body();
    pki.revoke(params.id, b.revoked !== false);
    bus.event('warn', 'certs', `Certificate ${pki.getRow(params.id)?.name} ${b.revoked !== false ? 'revoked' : 'un-revoked'}`);
    bus.changed('certs');
    return { ok: true };
  });
  r.patch('/api/certs/:id', async ({ params, body }) => {
    const b = await body();
    if (b.name) pki.rename(params.id, b.name);
    bus.changed('certs');
    return { ok: true };
  });
  r.delete('/api/certs/:id', ({ params }) => {
    const s = settings.get();
    pki.delete(params.id);
    if (s.serverCertIds.includes(params.id)) settings.update({ serverCertIds: s.serverCertIds.filter((x) => x !== params.id) });
    if (s.trustedClientCaIds.includes(params.id)) settings.update({ trustedClientCaIds: s.trustedClientCaIds.filter((x) => x !== params.id) });
    bus.changed('certs');
    return { ok: true };
  });
  r.get('/api/certs/:id/download', ({ params, query, res }) => {
    const row = pki.getRow(params.id);
    if (!row) throw new HttpError(404, 'Certificate not found');
    const base = safe(row.name);
    const fmt = query.get('format') ?? 'pem';
    const password = query.get('password') ?? 'cbrs';
    switch (fmt) {
      case 'pem': return sendBuffer(res, 200, row.cert_pem, 'application/x-pem-file', `${base}.pem`);
      case 'crt': return sendBuffer(res, 200, row.cert_pem, 'application/x-x509-ca-cert', `${base}.crt`);
      case 'der': return sendBuffer(res, 200, pki.der(params.id), 'application/pkix-cert', `${base}.der`);
      case 'chain': return sendBuffer(res, 200, row.cert_pem + pki.pemChain(params.id, false), 'application/x-pem-file', `${base}-chain.pem`);
      case 'fullchain': return sendBuffer(res, 200, row.cert_pem + pki.pemChain(params.id, true), 'application/x-pem-file', `${base}-fullchain.pem`);
      case 'key': return sendBuffer(res, 200, pki.keyPem(params.id, 'pkcs8'), 'application/x-pem-file', `${base}-key.pem`);
      case 'key-traditional': return sendBuffer(res, 200, pki.keyPem(params.id, 'traditional'), 'application/x-pem-file', `${base}-key-traditional.pem`);
      case 'p12': return sendBuffer(res, 200, pki.pkcs12(params.id, password, false), 'application/x-pkcs12', `${base}.p12`);
      case 'p12-legacy': return sendBuffer(res, 200, pki.pkcs12(params.id, password, true), 'application/x-pkcs12', `${base}-legacy.p12`);
      case 'bundle': return sendBuffer(res, 200, pki.radioBundle(params.id, { password, serverCertId: settings.get().serverCertIds[0] ?? null, sasUrls: sasUrls(settings.get(), d.hostnames) }), 'application/zip', `${base}-bundle.zip`);
      case 'crl': {
        const crl = pki.crlFor(params.id);
        if (!crl) throw new HttpError(400, 'CRLs can only be generated for CAs with a private key');
        return sendBuffer(res, 200, crl, 'application/x-pem-file', `${base}.crl.pem`);
      }
      default: throw new HttpError(400, 'Unknown format');
    }
  });
  r.get('/api/trust-bundle', ({ res, query }) => {
    // All CA certificates (for loading into a CBSD / harness trust store)
    const which = query.get('which') ?? 'all';
    const rows = pki.caCerts().filter((c) => which === 'all' || (which === 'roots' ? c.kind === 'root' || (c.kind === 'trusted' && new crypto.X509Certificate(c.cert_pem).subject === new crypto.X509Certificate(c.cert_pem).issuer) : true));
    sendBuffer(res, 200, rows.map((c) => c.cert_pem).join(''), 'application/x-pem-file', `sas-ca-bundle.pem`);
  });
  r.post('/api/crls', async ({ body }) => {
    const b = await body();
    const files: Array<{ name?: string; data: string }> = Array.isArray(b.files) ? b.files : [b];
    const out = files.map((f) => pki.importCrl(Buffer.from(need(f.data, 'data'), 'base64'), f.name));
    bus.event('info', 'certs', `Imported ${out.length} CRL(s)`);
    bus.changed('certs');
    return out;
  });
  r.delete('/api/crls/:id', ({ params }) => {
    pki.deleteCrl(params.id);
    bus.changed('certs');
    return { ok: true };
  });

  // ------------------------------------------------------------------ CPI signing tool

  r.post('/api/cpi/sign', async ({ body }) => {
    const b = await body();
    let keyPem: string = b.privateKeyPem ?? '';
    let cpiId = b.cpiId;
    let cpiName = b.cpiName;
    if (b.installerCertId) {
      const row = pki.getRow(b.installerCertId);
      if (!row?.key_pem) throw new HttpError(400, 'Installer certificate has no private key');
      keyPem = row.key_pem;
      const meta = jparse<any>(row.meta, {});
      cpiId ||= meta.cpiId;
      cpiName ||= meta.cpiName;
    }
    need(keyPem, 'privateKeyPem or installerCertId');
    const data = {
      fccId: need(b.fccId, 'fccId'), cbsdSerialNumber: need(b.cbsdSerialNumber, 'cbsdSerialNumber'),
      installationParam: need(b.installationParam, 'installationParam'),
      professionalInstallerData: { cpiId: need(cpiId, 'cpiId'), cpiName: need(cpiName, 'cpiName'), installCertificationTime: toRfc3339(Date.now()) },
    };
    return { cpiSignatureData: signCpiData(data, keyPem), signedData: data };
  });

  // ------------------------------------------------------------------ backup / harness helpers

  r.get('/api/export', ({ res }) => {
    const dump = {
      exportedAt: new Date().toISOString(), version: d.version, settings: redact(settings.get()),
      fccIds: db.all('SELECT * FROM fcc_ids'), userIds: db.all('SELECT * FROM user_ids'), blacklist: db.all('SELECT * FROM blacklist'),
      conditional: db.all('SELECT * FROM conditional_reg'), cpiUsers: db.all('SELECT * FROM cpi_users'),
      protections: db.all("SELECT * FROM protections WHERE source = 'ui'"), ppas: db.all("SELECT * FROM ppas WHERE source != 'harness'"),
      faults: db.all('SELECT * FROM fault_rules'),
    };
    sendBuffer(res, 200, JSON.stringify(dump, null, 2), 'application/json', `sas-config-${new Date().toISOString().slice(0, 10)}.json`);
  });
  r.post('/api/import', async ({ body }) => {
    const b = await body();
    db.tx(() => {
      if (b.settings) {
        const { uiPassword: _pw, serverCertIds: _a, trustedClientCaIds: _b, ...rest } = b.settings;
        settings.update(rest);
      }
      const ins = (table: string, rows: Row[] | undefined) => {
        for (const row of rows ?? []) {
          const keys = Object.keys(row);
          db.run(`INSERT OR REPLACE INTO ${table}(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => row[k]));
        }
      };
      ins('fcc_ids', b.fccIds); ins('user_ids', b.userIds); ins('blacklist', b.blacklist); ins('conditional_reg', b.conditional);
      ins('cpi_users', b.cpiUsers); ins('protections', b.protections); ins('ppas', b.ppas); ins('fault_rules', b.faults);
    });
    bus.event('info', 'admin', 'Configuration imported');
    bus.changed('all');
    return { ok: true };
  });
  r.get('/api/harness/sas.cfg', ({ res, query }) => {
    const host = query.get('host') || d.hostnames[0] || 'localhost';
    const s = settings.get();
    const hp = `${host}:${s.sasHttpsPort}`;
    const cfg = `[SasConfig]
AdminApiBaseUrl: ${hp}
CbsdSasRsaBaseUrl: ${hp}
CbsdSasEcBaseUrl: ${hp}
SasSasRsaBaseUrl: ${hp}
SasSasEcBaseUrl: ${hp}
CbsdSasVersion: ${s.supportedVersions[0] ?? 'v1.2'}
SasSasVersion: v1.3
AdminId: sas_admin_id
MaximumBatchSize: 100
`;
    sendBuffer(res, 200, cfg, 'text/plain', 'sas.cfg');
  });

  return r;
}

// ====================================================================== harness hook

/** WInnForum harness admin API on the SAS listeners: POST <base>/admin/<method>. */
export function harnessHook(admin: SasAdmin, bus: Bus) {
  return async (req: IncomingMessage, res: ServerResponse, pathname: string, ctx: RequestCtx): Promise<boolean> => {
    const i = pathname.indexOf('/admin/');
    const sub = pathname.slice(i + 7).replace(/\/+$/, '');
    const started = Date.now();
    const raw = await readBody(req);
    let body: any = {};
    if (raw.length) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return true;
      }
    }
    let status = 200;
    let out: unknown;
    let error: string | undefined;
    try {
      out = await admin.harness(sub, body);
    } catch (e: any) {
      status = e instanceof NotFound ? 404 : 400;
      error = e.message;
      out = { error: e.message };
    }
    bus.message({ ts: started, transport: ctx.transport, remoteAddr: ctx.remoteAddr, path: pathname, method: `admin/${sub}`, httpStatus: status,
      durationMs: Date.now() - started, certSubject: ctx.cert?.subject, request: raw.length ? body : undefined, response: out, error });
    if (out === undefined) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 0 });
      res.end();
    } else sendJson(res, status, out);
    return true;
  };
}

// ====================================================================== helpers

function sasUrls(s: Settings, hosts: string[]): string[] {
  const out: string[] = [];
  const v = s.supportedVersions[0] ?? 'v1.2';
  for (const h of hosts.length ? hosts : ['localhost']) {
    if (s.sasHttpsEnabled) out.push(`https://${h}:${s.sasHttpsPort}/${v}/`);
    if (s.sasHttpEnabled) out.push(`http://${h}:${s.sasHttpPort}/${v}/`);
  }
  return out;
}

function detectProfile(s: Settings): string | null {
  for (const [k, p] of Object.entries(PRESETS)) {
    if (Object.entries(p.patch).every(([key, v]) => JSON.stringify((s as any)[key]) === JSON.stringify(v))) return k;
  }
  return null;
}

function redact(s: Settings): Settings {
  return { ...s, uiPassword: s.uiPassword ? '********' : '' };
}

function validateSettings(p: any) {
  if (p.uiPassword === '********') delete p.uiPassword;
  const port = (k: string) => {
    if (k in p && (!Number.isInteger(p[k]) || p[k] < 1 || p[k] > 65535)) throw new HttpError(400, `${k} must be a TCP port`);
  };
  port('sasHttpPort');
  port('sasHttpsPort');
  if (p.sasHttpPort && p.sasHttpsPort && p.sasHttpPort === p.sasHttpsPort) throw new HttpError(400, 'HTTP and HTTPS ports must differ');
  if ('transmitExpireSec' in p && (p.transmitExpireSec < 1 || p.transmitExpireSec > 240)) throw new HttpError(400, 'transmitExpireSec must be 1–240 s (WINNF-TS-0016 limit)');
  if ('heartbeatIntervalSec' in p && p.heartbeatIntervalSec < 1) throw new HttpError(400, 'heartbeatIntervalSec must be ≥ 1');
  if ('grantExpireSec' in p && p.grantExpireSec < 60) throw new HttpError(400, 'grantExpireSec must be ≥ 60');
  if ('supportedVersions' in p && (!Array.isArray(p.supportedVersions) || !p.supportedVersions.every((v: any) => /^v\d+\.\d+$/.test(v)))) {
    throw new HttpError(400, 'supportedVersions must look like ["v1.2"]');
  }
  if ('gaaRanges' in p && (!Array.isArray(p.gaaRanges) || p.gaaRanges.some((r: any) => !(r.low < r.high)))) throw new HttpError(400, 'Invalid GAA ranges');
}

function cbsdOut(c: Row, grants: Record<string, number>) {
  const eff = jparse<any>(c.effective, {});
  const ip = eff.installationParam ?? {};
  return {
    cbsdId: c.cbsd_id, fccId: c.fcc_id, serial: c.serial, userId: c.user_id, category: eff.cbsdCategory ?? c.category, state: c.state,
    callSign: eff.callSign ?? null, radioTechnology: eff.airInterface?.radioTechnology ?? null,
    latitude: ip.latitude ?? null, longitude: ip.longitude ?? null, height: ip.height ?? null, heightType: ip.heightType ?? null,
    indoor: ip.indoorDeployment ?? null, eirpCapability: ip.eirpCapability ?? null, antennaGain: ip.antennaGain ?? null,
    measCapability: jparse(c.meas_capability, []), registration: jparse(c.registration, {}), effective: eff,
    certInfo: jparse(c.cert_info, null), approved: !!c.approved, transport: c.transport, remoteAddr: c.remote_addr,
    eirpCapDbmMhz: c.eirp_cap_dbm_mhz, pendingDeregister: !!c.pending_deregister, notes: c.notes,
    regMeasConfig: jparse(c.reg_meas_config, []), hbMeasConfig: jparse(c.meas_report_config, []), measRequired: jparse(c.meas_required, {}),
    lastMeasReport: jparse(c.last_meas_report, null),
    createdAt: c.created_at, registeredAt: c.registered_at, updatedAt: c.updated_at, lastSeen: c.last_seen, lastHeartbeatOk: c.last_heartbeat_ok,
    grants,
  };
}

function grantOut(g: Row) {
  return {
    grantId: g.grant_id, cbsdId: g.cbsd_id, fccId: g.fcc_id, serial: g.serial, category: g.category, state: g.state, suspended: !!g.suspended,
    low: g.low_freq, high: g.high_freq, maxEirp: g.max_eirp, channelType: g.channel_type,
    grantExpireTime: g.grant_expire_time, transmitExpireTime: g.transmit_expire_time, heartbeatInterval: g.heartbeat_interval,
    heartbeatCount: g.heartbeat_count, lastHeartbeat: g.last_heartbeat, pendingHeartbeatInterval: g.pending_hb_interval,
    suggestedOperationParam: jparse(g.suggested_op_param, null), endReason: g.end_reason, endedAt: g.ended_at, createdAt: g.created_at,
  };
}

function protectionOut(p: Row) {
  return {
    id: p.id, name: p.name, kind: p.kind, source: p.source, low: p.low_freq, high: p.high_freq, active: !!p.active,
    channels: jparse(p.channels, null), action: p.action, geometry: jparse(p.geometry, null), latitude: p.latitude, longitude: p.longitude,
    radiusKm: p.radius_km, neighborhood: jparse(p.neighborhood, null), notes: p.notes, updatedAt: p.updated_at,
  };
}

function ppaOut(p: Row) {
  return { id: p.id, name: p.name, channels: jparse(p.channels, []), members: jparse(p.members, []), geometry: jparse(p.geometry, null), expiration: p.expiration, source: p.source };
}

function upsertProtection(db: Db, id: string, b: any) {
  if (!b.name) throw new HttpError(400, 'name is required');
  const low = Number(b.low), high = Number(b.high);
  if (!(low < high)) throw new HttpError(400, 'low must be below high');
  const now = Date.now();
  db.run(`INSERT INTO protections(id, name, kind, source, low_freq, high_freq, active, channels, action, geometry, latitude, longitude, radius_km,
      neighborhood, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, low_freq=excluded.low_freq, high_freq=excluded.high_freq,
      active=excluded.active, channels=excluded.channels, action=excluded.action, geometry=excluded.geometry, latitude=excluded.latitude,
      longitude=excluded.longitude, radius_km=excluded.radius_km, neighborhood=excluded.neighborhood, notes=excluded.notes, updated_at=excluded.updated_at`,
    id, b.name, b.kind || 'ADMIN', b.source || 'ui', low, high, b.active ? 1 : 0, b.channels?.length ? JSON.stringify(b.channels) : null,
    b.action === 'terminate' ? 'terminate' : 'suspend', b.geometry ? JSON.stringify(b.geometry) : null,
    numOrNull(b.latitude), numOrNull(b.longitude), numOrNull(b.radiusKm), b.neighborhood ? JSON.stringify(b.neighborhood) : null, b.notes ?? null, now, now);
}

function upsertPpa(db: Db, id: string, b: any) {
  if (!b.name) throw new HttpError(400, 'name is required');
  const channels = (b.channels ?? []).map((c: any) => ({ low: Number(c.low), high: Number(c.high), palId: c.palId ?? null, licenseExpiration: c.licenseExpiration ?? null }));
  if (!channels.length || channels.some((c: any) => !(c.low < c.high))) throw new HttpError(400, 'At least one valid PAL channel is required');
  db.run(`INSERT INTO ppas(id, name, channels, members, geometry, expiration, source, data, created_at) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, channels=excluded.channels, members=excluded.members, geometry=excluded.geometry, expiration=excluded.expiration`,
    id, b.name, JSON.stringify(channels), JSON.stringify(b.members ?? []), b.geometry ? JSON.stringify(b.geometry) : null,
    b.expiration ? Number(b.expiration) : null, 'ui', null, Date.now());
}

function faultVals(b: any): any[] {
  return [
    b.enabled === false ? 0 : 1, b.name ?? null, b.method || '*', b.match_cbsd || null, need2(b.action),
    b.response_code === '' || b.response_code == null ? null : Number(b.response_code),
    b.response_data === undefined || b.response_data === null || b.response_data === '' ? null : typeof b.response_data === 'string' ? b.response_data : JSON.stringify(b.response_data),
    b.response_message || null, b.http_status ? Number(b.http_status) : null, b.delay_ms ? Number(b.delay_ms) : null,
    b.remaining === '' || b.remaining == null ? null : Number(b.remaining),
  ];
}

function need2(a: any): string {
  if (!['response_code', 'patch', 'http_status', 'delay', 'drop', 'malformed'].includes(a)) throw new HttpError(400, 'Invalid fault action');
  return a;
}

function dn(b: any): DnInput {
  if (!b.CN) throw new HttpError(400, 'Common name (CN) is required');
  return { CN: b.CN, O: b.O || undefined, OU: b.OU || undefined, L: b.L || undefined, ST: b.ST || undefined, C: b.C || undefined };
}

function kt(v: any, def: KeyType): KeyType {
  return ['rsa2048', 'rsa3072', 'rsa4096', 'ec256', 'ec384'].includes(v) ? v : def;
}

function num(v: any): number | undefined {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n) ? undefined : n;
}

function numOrNull(v: any): number | null {
  return num(v) ?? null;
}

function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'file';
}

function importP12(pki: Pki, data: Buffer, password: string, name?: string) {
  return pki.importPkcs12(data, password, name);
}
