import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Db } from '../db.ts';
import { jparse } from '../db.ts';
import type { Bus } from '../bus.ts';
import type { SettingsStore } from '../settings.ts';
import type { Pki } from '../pki/pki.ts';
import type { Engine } from './engine.ts';
import { cbsdViewFromRow, overlaps } from './policy.ts';
import { distanceKm, parseKmlPlacemarks } from './geo.ts';
import { parseRfc3339Strict } from '../util/time.ts';

// SAS administration: the WInnForum test-harness "SAS testing interface" (src/harness/sas_interface.py
// SasAdminInterface, POST /admin/...) plus the same operations for the web UI. Injected incumbent
// data is turned into protections / PPAs immediately; the daily activities (CPAS) additionally
// pull peer-SAS full activity dumps and purge grants that conflict with protections.

const FSS_GWBL_RANGE = { low: 3650e6, high: 3700e6 };
const FSS_GWBL_KM = 150;

export interface DailyStatus {
  completed: boolean;
  running: boolean;
  lastStarted: number | null;
  lastCompleted: number | null;
  log: string[];
}

export class SasAdmin {
  private db: Db;
  private engine: Engine;
  private bus: Bus;
  private settings: SettingsStore;
  private pki: Pki;
  private dataDir: string;
  daily: DailyStatus = { completed: true, running: false, lastStarted: null, lastCompleted: null, log: [] };
  ppaStatus = { completed: true, withError: false };
  flags = { ntiaExclusionZones: false, scheduledDailyActivities: false, escConnected: true };
  private scheduleTimer: NodeJS.Timeout | null = null;

  constructor(db: Db, engine: Engine, bus: Bus, settings: SettingsStore, pki: Pki, dataDir: string) {
    this.db = db;
    this.engine = engine;
    this.bus = bus;
    this.settings = settings;
    this.pki = pki;
    this.dataDir = dataDir;
  }

  // =============================================================== reset

  /** Return the SAS to its initial state (harness Reset): everything except settings, certificates and fault rules. */
  reset(source = 'harness') {
    this.db.tx(() => {
      for (const t of ['grants', 'cbsds', 'fcc_ids', 'user_ids', 'blacklist', 'conditional_reg', 'harness_data', 'cpi_users', 'ppas', 'protections']) {
        this.db.run(`DELETE FROM ${t}`);
      }
    });
    this.engine.measInRegistration = false;
    this.engine.measInHeartbeat = false;
    this.daily = { completed: true, running: false, lastStarted: null, lastCompleted: null, log: [] };
    this.ppaStatus = { completed: true, withError: false };
    this.flags = { ntiaExclusionZones: false, scheduledDailyActivities: false, escConnected: true };
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.scheduleTimer = null;
    this.bus.event('warn', 'admin', `SAS state reset (${source})`);
    this.bus.changed('all');
  }

  // =============================================================== registry

  injectFccId(fccId: string, maxEirp: number | null) {
    if (typeof fccId !== 'string' || !fccId) throw new Error('fccId required');
    this.db.run(`INSERT INTO fcc_ids(fcc_id, max_eirp, created_at) VALUES (?,?,?)
      ON CONFLICT(fcc_id) DO UPDATE SET max_eirp = excluded.max_eirp`, fccId, typeof maxEirp === 'number' ? maxEirp : 47, Date.now());
    this.bus.changed('registry');
  }

  injectUserId(userId: string) {
    if (typeof userId !== 'string' || !userId) throw new Error('userId required');
    this.db.run('INSERT OR IGNORE INTO user_ids(user_id, created_at) VALUES (?,?)', userId, Date.now());
    this.bus.changed('registry');
  }

  blacklist(fccId: string, serial: string | null, reason = 'blacklisted by administrator') {
    if (typeof fccId !== 'string' || !fccId) throw new Error('fccId required');
    if (!this.db.get('SELECT 1 FROM blacklist WHERE fcc_id = ? AND serial IS ?', fccId, serial)) {
      this.db.run('INSERT INTO blacklist(fcc_id, serial, reason, created_at) VALUES (?,?,?,?)', fccId, serial, reason, Date.now());
    }
    const affected = this.db.all(serial ? 'SELECT cbsd_id FROM cbsds WHERE fcc_id = ? AND serial = ?' : 'SELECT cbsd_id FROM cbsds WHERE fcc_id = ?',
      ...(serial ? [fccId, serial] : [fccId]));
    this.bus.event('warn', 'admin', `Blacklisted ${fccId}${serial ? ' / ' + serial : ' (all serials)'}; ${affected.length} registered CBSD(s) affected`);
    this.bus.changed('registry');
  }

  preloadRegistration(records: any[], source = 'harness') {
    if (!Array.isArray(records)) throw new Error('registrationData must be an array');
    for (const r of records) {
      if (!r || typeof r.fccId !== 'string' || typeof r.cbsdSerialNumber !== 'string') throw new Error('Each record needs fccId and cbsdSerialNumber');
      this.db.run(`INSERT INTO conditional_reg(fcc_id, serial, data, source, created_at) VALUES (?,?,?,?,?)
        ON CONFLICT(fcc_id, serial) DO UPDATE SET data = excluded.data, source = excluded.source`,
        r.fccId, r.cbsdSerialNumber, JSON.stringify(r), source, Date.now());
    }
    this.bus.changed('registry');
  }

  injectCpiUser(cpiId: string, name: string, publicKey: string, source = 'harness') {
    if (typeof cpiId !== 'string' || !cpiId) throw new Error('cpiId required');
    crypto.createPublicKey(publicKey); // validate
    this.db.run(`INSERT INTO cpi_users(cpi_id, name, public_key, source, created_at) VALUES (?,?,?,?,?)
      ON CONFLICT(cpi_id) DO UPDATE SET name = excluded.name, public_key = excluded.public_key`, cpiId, name ?? null, publicKey, source, Date.now());
    this.bus.changed('registry');
  }

  // =============================================================== incumbent / zone data

  putData(kind: string, id: string, data: unknown) {
    this.db.run(`INSERT INTO harness_data(kind, id, data, created_at) VALUES (?,?,?,?)
      ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data`, kind, id, JSON.stringify(data), Date.now());
  }

  data(kind: string): Array<{ id: string; data: any }> {
    return this.db.all('SELECT id, data FROM harness_data WHERE kind = ? ORDER BY created_at', kind).map((r) => ({ id: r.id, data: jparse(r.data, {}) }));
  }

  injectFss(body: any) {
    const rec = body?.record;
    if (!rec?.id) throw new Error('record.id required');
    this.putData('fss', rec.id, { record: rec, ttc: !!body.ttc });
    this.rebuildDerived();
  }

  injectWisp(body: any) {
    const rec = body?.record;
    if (!rec?.id) throw new Error('record.id required');
    this.putData('wisp', rec.id, { record: rec, zone: body.zone ?? null });
    this.rebuildDerived();
  }

  injectPal(rec: any) {
    if (!rec?.palId) throw new Error('palId required');
    this.putData('pal', rec.palId, rec);
    this.rebuildDerived();
  }

  injectZone(body: any): string {
    const rec = body?.record;
    if (!rec || typeof rec !== 'object') throw new Error('record required');
    const id = typeof rec.id === 'string' && rec.id ? rec.id : `zone/${(rec.usage ?? 'ppa').toLowerCase()}/lab/${crypto.randomUUID()}`;
    this.putData('zone', id, { ...rec, id });
    this.rebuildDerived();
    return id;
  }

  injectExclusionZone(body: any): string {
    if (!body?.zone) throw new Error('zone required');
    const id = `exclusion/${crypto.randomUUID()}`;
    this.putData('exclusion_zone', id, body);
    this.rebuildDerived();
    return id;
  }

  /**
   * Turn injected data into enforcement objects:
   *  - PPA zone records + PAL records → ppas (cluster list, polygon, PAL primary assignment)
   *  - WISP records with a zone (GWPZ) → polygon protection on the WISP frequency range
   *  - FSS (low < 3700 MHz) with a GWBL within 150 km → 3650–3700 MHz exclusion within 150 km of the FSS
   *  - Exclusion zones → polygon protection on the listed ranges
   */
  rebuildDerived() {
    const now = Date.now();
    const pals = new Map(this.data('pal').map((p) => [p.id, p.data]));
    this.db.run("DELETE FROM ppas WHERE source = 'harness'");
    for (const { id, data: z } of this.data('zone')) {
      if ((z.usage ?? 'PPA') !== 'PPA' || z.terminated) continue;
      const info = z.ppaInfo ?? {};
      const begin = parseRfc3339Strict(info.ppaBeginDate);
      const exp = parseRfc3339Strict(info.ppaExpirationDate);
      const channels: any[] = [];
      if (begin == null || begin <= now) {
        for (const palId of info.palId ?? []) {
          const pal = pals.get(palId);
          const pa = pal?.channelAssignment?.primaryAssignment;
          if (!pa || (pal.licenseStatus && pal.licenseStatus !== 'VALID')) continue;
          channels.push({ low: pa.lowFrequency, high: pa.highFrequency, palId, licenseExpiration: parseRfc3339Strict(pal.license?.licenseExpiration) });
        }
      }
      this.db.run(`INSERT OR REPLACE INTO ppas(id, name, channels, members, geometry, expiration, source, data, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`, id, z.name ?? id, JSON.stringify(channels), JSON.stringify(info.cbsdReferenceId ?? []),
        z.zone ? JSON.stringify(z.zone) : null, exp, 'harness', JSON.stringify(z), now);
    }

    this.db.run("DELETE FROM protections WHERE source = 'harness'");
    const insert = (p: Record<string, any>) => this.db.run(
      `INSERT OR REPLACE INTO protections(id, name, kind, source, low_freq, high_freq, active, channels, action, geometry, latitude, longitude,
        radius_km, neighborhood, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      p.id, p.name, p.kind, 'harness', p.low, p.high, 1, p.channels ? JSON.stringify(p.channels) : null, p.action,
      p.geometry ? JSON.stringify(p.geometry) : null, p.latitude ?? null, p.longitude ?? null, p.radiusKm ?? null, null, p.notes ?? null, now, now);

    const wisps = this.data('wisp');
    const gwbls = wisps.filter((w) => !w.data.zone).map((w) => w.data.record.deploymentParam?.[0]?.installationParam).filter((ip) => ip && typeof ip.latitude === 'number');
    for (const { id, data: w } of wisps) {
      if (!w.zone) continue;
      const ranges = (w.record.deploymentParam ?? []).map((d: any) => d.operationParam?.operationFrequencyRange).filter(Boolean);
      for (const [i, fr] of ranges.entries()) {
        insert({ id: `gwpz:${id}:${i}`, name: `GWPZ ${id}`, kind: 'GWPZ', low: fr.lowFrequency, high: fr.highFrequency, action: 'terminate', geometry: w.zone, radiusKm: 0 });
      }
    }
    for (const { id, data: f } of this.data('fss')) {
      const dp = f.record.deploymentParam?.[0];
      const ip = dp?.installationParam;
      const fr = dp?.operationParam?.operationFrequencyRange;
      if (!ip || !fr || typeof ip.latitude !== 'number' || fr.lowFrequency >= 3700e6) continue;
      const near = gwbls.some((g) => distanceKm(ip.latitude, ip.longitude, g.latitude, g.longitude) <= FSS_GWBL_KM);
      if (!near) continue;
      insert({
        id: `fss_gwbl:${id}`, name: `FSS ${id} + GWBL`, kind: 'FSS_GWBL', low: FSS_GWBL_RANGE.low, high: FSS_GWBL_RANGE.high, action: 'terminate',
        latitude: ip.latitude, longitude: ip.longitude, radiusKm: FSS_GWBL_KM, notes: 'FSS with a grandfathered wireless broadband licensee within 150 km',
      });
    }
    for (const { id, data: z } of this.data('exclusion_zone')) {
      const ranges = (z.frequencyRanges ?? []).map((r: any) => [r.lowFrequency, r.highFrequency]);
      const low = Math.min(...ranges.map((r: number[]) => r[0]), 3550e6);
      const high = Math.max(...ranges.map((r: number[]) => r[1]), 3700e6);
      insert({ id, name: 'Exclusion zone', kind: 'EXCLUSION_ZONE', low, high, channels: ranges.length ? ranges : null, action: 'terminate', geometry: z.zone, radiusKm: 0 });
    }
    this.bus.changed('spectrum');
  }

  // =============================================================== DPAs (ESC-monitored E-DPAs from the NTIA KML)

  loadDpas(file = 'E-DPAs.kml', activate = true): number {
    const kmlPath = path.join(this.dataDir, 'ntia', file);
    const kml = fs.readFileSync(kmlPath, 'utf8');
    const now = Date.now();
    const source = file.startsWith('P-') ? 'ntia-p-dpa' : 'ntia-e-dpa';
    let n = 0;
    for (const pm of parseKmlPlacemarks(kml)) {
      const fr = /([\d.]+)\s*-\s*([\d.]+)/.exec(pm.data.freqRangeMHz ?? '3550-3650');
      const low = fr ? Math.round(Number(fr[1]) * 1e6) : 3550e6;
      const high = fr ? Math.round(Number(fr[2]) * 1e6) : 3650e6;
      const hood: Record<string, number> = {};
      for (const [k, v] of Object.entries(pm.data)) if (/NeighborhoodDistanceKm$/.test(k) && Number.isFinite(Number(v))) hood[k] = Number(v);
      const id = `dpa:${pm.name}`;
      const existing = this.db.get('SELECT id FROM protections WHERE id = ?', id);
      if (existing) {
        if (activate) this.db.run('UPDATE protections SET active = 1, channels = NULL, updated_at = ? WHERE id = ?', now, id);
      } else {
        this.db.run(
          `INSERT INTO protections(id, name, kind, source, low_freq, high_freq, active, channels, action, geometry, neighborhood, notes, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          id, pm.name, 'DPA', source, low, high, activate ? 1 : 0, null, 'suspend', JSON.stringify(pm.geometry), JSON.stringify(hood),
          `NTIA ${source === 'ntia-p-dpa' ? 'portal' : 'ESC'} DPA (${pm.data.freqRangeMHz ?? ''} MHz)`, now, now);
      }
      n++;
    }
    this.bus.event('info', 'admin', `Loaded ${n} DPAs from ${file}${activate ? ' (all channels active)' : ''}`);
    this.bus.changed('spectrum');
    return n;
  }

  bulkDpaActivation(activate: boolean) {
    this.db.run("UPDATE protections SET active = ?, channels = NULL, updated_at = ? WHERE kind = 'DPA'", activate ? 1 : 0, Date.now());
    this.bus.event('warn', 'admin', `All DPAs ${activate ? 'activated' : 'deactivated'} on all channels`);
    this.bus.changed('spectrum');
  }

  dpaActivation(dpaId: string, fr: { lowFrequency: number; highFrequency: number }, activate: boolean) {
    const p = this.db.get("SELECT * FROM protections WHERE kind = 'DPA' AND (id = ? OR name = ?)", dpaId, dpaId) ??
      this.db.get("SELECT * FROM protections WHERE kind = 'DPA' AND id = ?", `dpa:${dpaId}`);
    if (!p) throw new Error(`Unknown DPA ${dpaId} (load DPAs first)`);
    if (!fr || typeof fr.lowFrequency !== 'number' || typeof fr.highFrequency !== 'number') throw new Error('frequencyRange required');
    let ch: Array<[number, number]> = jparse(p.channels, null) ?? (p.active ? [[p.low_freq, p.high_freq]] : []);
    if (activate) {
      if (!ch.some(([l, h]) => l === fr.lowFrequency && h === fr.highFrequency)) ch.push([fr.lowFrequency, fr.highFrequency]);
    } else {
      // remove the channel (splitting a wider active range if needed)
      const next: Array<[number, number]> = [];
      for (const [l, h] of ch) {
        if (h <= fr.lowFrequency || l >= fr.highFrequency) next.push([l, h]);
        else {
          if (l < fr.lowFrequency) next.push([l, fr.lowFrequency]);
          if (h > fr.highFrequency) next.push([fr.highFrequency, h]);
        }
      }
      ch = next;
    }
    this.db.run('UPDATE protections SET channels = ?, active = ?, updated_at = ? WHERE id = ?', JSON.stringify(ch), ch.length ? 1 : 0, Date.now(), p.id);
    this.bus.event('warn', 'admin', `DPA ${p.name} ${activate ? 'activated' : 'deactivated'} on ${fr.lowFrequency / 1e6}–${fr.highFrequency / 1e6} MHz`);
    this.bus.changed('spectrum');
  }

  // =============================================================== PPA creation (simplified)

  createPpa(body: any): string {
    const cbsdIds: string[] = body?.cbsdIds ?? [];
    const palIds: string[] = body?.palIds ?? [];
    if (!cbsdIds.length || !palIds.length) throw new Error('cbsdIds and palIds required');
    const pals = new Map(this.data('pal').map((p) => [p.id, p.data]));
    for (const pid of palIds) if (!pals.has(pid)) throw new Error(`Unknown PAL ${pid}`);
    const cbsds = cbsdIds.map((id) => this.db.get("SELECT * FROM cbsds WHERE cbsd_id = ? AND state = 'REGISTERED'", id));
    if (cbsds.some((c) => !c)) throw new Error('All cbsdIds must be registered CBSDs');
    const userIds = new Set(palIds.map((p) => pals.get(p).userId));
    if (cbsds.some((c) => !userIds.has(c!.user_id))) throw new Error('CBSD userId does not match the PAL holder');
    let zone = body.providedContour;
    if (!zone) {
      // Approximate contour: union of 8 km circles around the cluster CBSDs (no propagation model).
      const polys = cbsds.map((c) => circle(cbsdViewFromRow(c!).lat ?? 0, cbsdViewFromRow(c!).lon ?? 0, 8));
      zone = { type: 'FeatureCollection', features: polys.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [p] } })) };
    }
    const id = `zone/ppa/lab/${palIds[0]}/${crypto.randomUUID().replace(/-/g, '')}`;
    const now = Date.now();
    this.injectZone({
      record: {
        id, name: `PPA ${palIds.join(',')}`, creator: 'lab-sas', usage: 'PPA', terminated: false, zone,
        ppaInfo: { palId: palIds, cbsdReferenceId: cbsdIds, ppaBeginDate: new Date(now).toISOString().slice(0, 19) + 'Z',
          ppaExpirationDate: new Date(now + 365 * 86400e3).toISOString().slice(0, 19) + 'Z' },
      },
    });
    this.ppaStatus = { completed: true, withError: false };
    return id;
  }

  // =============================================================== daily activities (CPAS)

  triggerDailyActivities(): Promise<void> {
    if (this.daily.running) return Promise.resolve();
    this.daily = { ...this.daily, completed: false, running: true, lastStarted: Date.now(), log: [] };
    this.bus.changed('daily');
    return this.runDailyActivities()
      .catch((e) => {
        this.daily.log.push(`error: ${e.message}`);
        this.bus.event('error', 'cpas', `Daily activities failed: ${e.message}`);
      })
      .finally(() => {
        this.daily.running = false;
        this.daily.completed = true;
        this.daily.lastCompleted = Date.now();
        this.bus.changed('daily');
      });
  }

  enableScheduledDailyActivities() {
    this.flags.scheduledDailyActivities = true;
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.scheduleTimer = setInterval(() => void this.triggerDailyActivities(), 24 * 3600e3);
    this.scheduleTimer.unref();
  }

  private async runDailyActivities() {
    const log = (m: string) => this.daily.log.push(m);
    this.bus.event('info', 'cpas', 'Daily activities started');

    // 1. Peer SAS full activity dumps
    for (const { id, data: peer } of this.data('peer_sas')) {
      try {
        const n = await this.pullPeerDump(peer.url, peer.certificateHash);
        log(`peer ${id}: ${n} CBSD records`);
      } catch (e: any) {
        log(`peer ${id}: ${e.message}`);
        this.bus.event('warn', 'cpas', `Peer SAS ${peer.url}: ${e.message}`);
      }
    }

    // 2. Recompute derived protections / PPAs
    this.rebuildDerived();

    // 3. Purge
    let terminated = 0;
    this.db.tx(() => {
      const live = this.db.all(`SELECT g.*, c.cbsd_id AS cid FROM grants g JOIN cbsds c ON c.cbsd_id = g.cbsd_id
        WHERE g.state IN ('GRANTED','AUTHORIZED') AND c.state = 'REGISTERED'`);
      for (const g of live) {
        const cbsd = this.db.get('SELECT * FROM cbsds WHERE cbsd_id = ?', g.cbsd_id)!;
        const view = cbsdViewFromRow(cbsd);
        const range = { low: g.low_freq, high: g.high_freq };
        let why: string | null = null;
        if (this.engine.hasPeerSasGrant(cbsd)) why = 'CBSD holds a grant from another SAS';
        if (!why) {
          const hit = this.engine.policy.protectionHits(view, range).find((h) => h.action === 'terminate');
          if (hit) why = `${hit.kind} ${hit.name}`;
        }
        if (!why && g.channel_type === 'GAA') {
          const ex = this.engine.policy.palContext(view, range).excludingPpas;
          if (ex.length) why = `inside PPA ${ex[0].name} on its PAL channel`;
        }
        if (!why && g.channel_type === 'PAL') {
          const member = this.engine.policy.ppas().some((p) => p.members.includes(g.cbsd_id) && p.channels.some((c) => overlaps(c, range)));
          if (!member) why = 'PAL protection no longer valid';
        }
        if (why) {
          this.engine.endGrant(g.grant_id, 'TERMINATED', why);
          this.bus.event('warn', 'cpas', `Grant ${g.grant_id} terminated: ${why}`, g.cbsd_id, g.grant_id);
          terminated++;
        }
      }
    });
    log(`${terminated} grant(s) terminated`);
    this.bus.event('info', 'cpas', `Daily activities completed (${terminated} grant(s) terminated)`);
    this.bus.changed('grants');
  }

  /** Pull a peer SAS full activity dump (WINNF-TS-0096): GET <url>/dump, then each CBSD file. */
  private async pullPeerDump(url: string, certificateHash?: string): Promise<number> {
    const dump = await this.sasGet(`${url.replace(/\/$/, '')}/dump`, certificateHash);
    let n = 0;
    for (const f of dump?.files ?? []) {
      if (f.recordType && f.recordType !== 'cbsd') continue;
      const file = await this.sasGet(f.url, certificateHash);
      for (const rec of file?.recordData ?? []) {
        if (!rec?.id) continue;
        this.putData('fad_cbsd', rec.id, rec);
        n++;
      }
    }
    return n;
  }

  private sasGet(url: string, certificateHash?: string): Promise<any> {
    const s = this.settings.get();
    const id = s.serverCertIds.map((i) => this.pki.getRow(i)).find((r) => r?.key_pem && !/EC/.test(r.key_type));
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        cert: id ? id.cert_pem + this.pki.pemChain(id.id, false) : undefined, key: id?.key_pem,
        rejectUnauthorized: false, minVersion: 'TLSv1.2', timeout: 30_000,
      }, (res) => {
        const peer = (res.socket as any).getPeerCertificate?.();
        if (certificateHash && peer?.fingerprint && peer.fingerprint.toUpperCase() !== certificateHash.toUpperCase()) {
          this.bus.event('warn', 'cpas', `Peer certificate SHA-1 ${peer.fingerprint} does not match injected hash ${certificateHash}`);
        }
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 300) return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error(`Invalid JSON from ${url}`));
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
  }

  // =============================================================== harness HTTP surface

  /**
   * Dispatch a harness admin call (path after "/admin/"). Returns the JSON body to send
   * (undefined → empty 200), or throws for HTTP 400.
   */
  async harness(sub: string, body: any): Promise<unknown> {
    const b = body ?? {};
    switch (sub) {
      case 'reset': this.reset(); return undefined;
      case 'injectdata/fcc_id': this.injectFccId(b.fccId, b.fccMaxEirp ?? 47); return undefined;
      case 'injectdata/user_id': this.injectUserId(b.userId); return undefined;
      case 'injectdata/blacklist_fcc_id': this.blacklist(b.fccId, null, 'harness BlacklistByFccId'); return undefined;
      case 'injectdata/blacklist_fcc_id_and_serial_number': this.blacklist(b.fccId, b.serialNumber, 'harness BlacklistByFccIdAndSerialNumber'); return undefined;
      case 'injectdata/conditional_registration': this.preloadRegistration(b.registrationData ?? []); return undefined;
      case 'injectdata/cpi_user': this.injectCpiUser(b.cpiId, b.cpiName, b.cpiPublicKey); return undefined;
      case 'injectdata/exclusion_zone': return this.injectExclusionZone(b);
      case 'injectdata/zone': return this.injectZone(b);
      case 'injectdata/pal_database_record': this.injectPal(b); return undefined;
      case 'injectdata/fss': this.injectFss(b); return undefined;
      case 'injectdata/wisp': this.injectWisp(b); return undefined;
      case 'injectdata/sas_admin': this.putData('sas_admin', b.record?.id ?? crypto.randomUUID(), b); return undefined;
      case 'injectdata/esc_sensor': this.putData('esc_sensor', b.record?.id ?? crypto.randomUUID(), b); return undefined;
      case 'injectdata/peer_sas': this.putData('peer_sas', b.url ?? crypto.randomUUID(), b); return undefined;
      case 'injectdata/database_url': this.putData('database_url', `${b.type}:${b.url}`, b); return undefined;
      case 'injectdata/esc_zone':
      case 'injectdata/cluster_list':
      case 'injectdata/sas_impl':
        this.putData(sub.split('/')[1], crypto.randomUUID(), b);
        return undefined;
      case 'trigger/meas_report_in_registration_response':
        this.engine.measInRegistration = true;
        this.bus.event('info', 'admin', 'Measurement report requested in registration responses (RECEIVED_POWER_WITHOUT_GRANT)');
        return undefined;
      case 'trigger/meas_report_in_heartbeat_response':
        this.engine.measInHeartbeat = true;
        this.bus.event('info', 'admin', 'Measurement report requested in heartbeat responses (RECEIVED_POWER_WITH_GRANT)');
        return undefined;
      case 'trigger/create_ppa':
        this.ppaStatus = { completed: false, withError: false };
        try {
          return this.createPpa(b);
        } catch (e) {
          this.ppaStatus = { completed: true, withError: true };
          throw e;
        }
      case 'get_ppa_status': return this.ppaStatus;
      case 'trigger/daily_activities_immediately': await this.triggerDailyActivities(); return undefined;
      case 'get_daily_activities_status': return { completed: this.daily.completed };
      case 'trigger/enable_scheduled_daily_activities': this.enableScheduledDailyActivities(); return undefined;
      case 'trigger/enable_ntia_15_517': this.flags.ntiaExclusionZones = true; return undefined;
      case 'trigger/load_dpas': this.loadDpas('E-DPAs.kml', true); return undefined;
      case 'trigger/bulk_dpa_activation': this.bulkDpaActivation(!!b.activate); return undefined;
      case 'trigger/dpa_activation': this.dpaActivation(b.dpaId, b.frequencyRange, true); return undefined;
      case 'trigger/dpa_deactivation': this.dpaActivation(b.dpaId, b.frequencyRange, false); return undefined;
      case 'trigger/disconnect_esc': this.flags.escConnected = false; return undefined;
      case 'trigger/esc_detection':
      case 'trigger/esc_reset':
        return undefined;
      case 'trigger/create_full_activity_dump': return undefined;
      case 'query/propagation_and_antenna_model':
        throw new Error('Propagation and antenna model queries are not implemented by this SAS');
      default:
        throw new NotFound(`Unknown admin method ${sub}`);
    }
  }
}

export class NotFound extends Error {}

function circle(lat: number, lon: number, km: number): number[][] {
  const pts: number[][] = [];
  for (let i = 0; i <= 32; i++) {
    const a = (i / 32) * 2 * Math.PI;
    const dLat = (km / 110.574) * Math.cos(a);
    const dLon = (km / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.sin(a);
    pts.push([lon + dLon, lat + dLat]);
  }
  return pts;
}
