import type { Row } from '../db.ts';
import { jparse } from '../db.ts';
import { RC, RC_NAME } from './codes.ts';
import { decodeCpi, verifyJws, cpiKeysFor, type CpiDecoded } from './cpi.ts';
import { Engine, type RequestCtx, type Resp } from './engine.ts';

// Registration procedure (WINNF-TS-0016 §8.3, §10.1/10.2). Validation runs in a fixed order
// so that every outcome matches the WInnForum test harness (WINNF-TS-0061 REG.1–REG.13):
//
//   required ids (102) → cpiSignatureData structure (102) → id format / FCC & user ID (103)
//   → blacklist (101) → CPI identity & signature (103) → plaintext vs CPI installation data (103)
//   → merge preload / CPI / request → value ranges (103) → EIRP & deployment rules (103)
//   → Category A outdoor HAAT (103) → REG-conditional completeness (200) → success (0)
//
// A cbsdId is returned if and only if the response code is 0.

export const RADIO_TECHNOLOGIES = [
  'E_UTRA', 'CAMBIUM_NETWORKS', '4G_BBW_SAA_1', 'NR', 'DOODLE_CBRS', 'CW', 'REDLINE', 'TARANA_WIRELESS', 'FAROS',
];
export const MEAS_CAPABILITIES = ['RECEIVED_POWER_WITHOUT_GRANT', 'RECEIVED_POWER_WITH_GRANT', 'INDOOR_LOSS_USING_GNSS'];

const RANGES: Record<string, [number, number]> = {
  latitude: [-90, 90],
  longitude: [-180, 180],
  antennaAzimuth: [0, 359],
  antennaDowntilt: [-90, 90],
  antennaGain: [-127, 128],
  eirpCapability: [-127, 47],
  antennaBeamwidth: [0, 360],
  horizontalAccuracy: [0, Infinity],
  verticalAccuracy: [0, Infinity],
  height: [-1000, 10000],
};

export function processRegistration(e: Engine, item: any, ctx: RequestCtx): Resp {
  const s = e.s;
  const strict = s.registrationPolicy === 'strict';
  const label = `${item.fccId ?? '?'}/${item.cbsdSerialNumber ?? '?'}`;
  const fail = (code: number, data?: unknown, msg?: string): Resp => {
    e.bus.event(code === RC.REG_PENDING ? 'warn' : 'error', 'registration',
      `Registration of ${label} rejected: ${code} ${RC_NAME[code] ?? ''}${msg ? ' — ' + msg : ''}`);
    return { response: e.rc(code, data, msg) };
  };
  const warn = (msg: string) => e.bus.event('warn', 'registration', `Registration of ${label}: ${msg}`);

  // 1. Required identifiers
  const missing = ['userId', 'fccId', 'cbsdSerialNumber'].filter((k) => item[k] === undefined || item[k] === null);
  if (missing.length) return fail(RC.MISSING_PARAM, missing, `Missing required parameter(s): ${missing.join(', ')}`);
  const badType = ['userId', 'fccId', 'cbsdSerialNumber'].filter((k) => typeof item[k] !== 'string' || item[k] === '');
  if (badType.length) return fail(RC.INVALID_VALUE, badType, 'Identifiers must be non-empty strings');
  const fccId: string = item.fccId;
  const serial: string = item.cbsdSerialNumber;
  const userId: string = item.userId;

  // 2. cpiSignatureData structure (before any lookup, even if preloaded data exists)
  let cpi: CpiDecoded | null = null;
  let pid: any = null;
  if (item.cpiSignatureData !== undefined) {
    const d = decodeCpi(item.cpiSignatureData);
    if (!d.ok) {
      if (d.missing) return fail(RC.MISSING_PARAM, d.missing.map((k) => `cpiSignatureData.${k}`), 'Incomplete cpiSignatureData');
      return fail(RC.INVALID_VALUE, (d.invalid ?? []).map((k) => k === 'cpiSignatureData' ? k : `cpiSignatureData.${k}`), 'Undecodable cpiSignatureData');
    }
    cpi = d.value;
    pid = cpi.data.professionalInstallerData;
    const miss: string[] = [];
    if (!pid || typeof pid !== 'object') miss.push('professionalInstallerData');
    else for (const k of ['cpiId', 'cpiName', 'installCertificationTime']) if (pid[k] === undefined || pid[k] === null) miss.push(`professionalInstallerData.${k}`);
    if (miss.length) return fail(RC.MISSING_PARAM, miss, 'cpiSignatureData is missing professional installer data');
    if (cpi.data.installationParam !== undefined && (typeof cpi.data.installationParam !== 'object' || Array.isArray(cpi.data.installationParam))) {
      return fail(RC.INVALID_VALUE, ['installationParam'], 'Signed installationParam must be an object');
    }
  }

  // 3. Identifier format and FCC / user ID databases
  if (Buffer.byteLength(serial, 'utf8') > 64) return fail(RC.INVALID_VALUE, ['cbsdSerialNumber'], 'cbsdSerialNumber longer than 64 octets');
  if (fccId.length > 19) return fail(RC.INVALID_VALUE, ['fccId'], 'fccId longer than 19 characters');
  if (userId.length > 253) return fail(RC.INVALID_VALUE, ['userId'], 'userId too long');
  const fccRow = e.db.get('SELECT * FROM fcc_ids WHERE fcc_id = ?', fccId);
  if (!fccRow && s.requireKnownFccId) return fail(RC.INVALID_VALUE, ['fccId'], 'FCC ID not found in the equipment authorization database');
  if (s.requireKnownUserId && !e.db.get('SELECT 1 FROM user_ids WHERE user_id = ?', userId)) {
    return fail(RC.INVALID_VALUE, ['userId'], 'userId is not a known/authorized user');
  }

  // 4. Blacklist
  if (e.isBlacklisted(fccId, serial)) {
    const existing = e.db.get('SELECT cbsd_id FROM cbsds WHERE fcc_id = ? AND serial = ?', fccId, serial);
    if (existing) e.terminateAll(existing.cbsd_id, 'blacklisted');
    return fail(RC.BLACKLISTED, undefined, 'CBSD is blacklisted');
  }

  // 5. CPI identity and signature
  if (cpi) {
    if (typeof pid.cpiId !== 'string') return fail(RC.INVALID_VALUE, ['professionalInstallerData.cpiId']);
    const keys = cpiKeysFor(e.db, pid.cpiId);
    if (!keys.length) {
      if (strict) return fail(RC.INVALID_VALUE, ['professionalInstallerData.cpiId'], `Unknown CPI ${pid.cpiId}`);
      warn(`CPI ${pid.cpiId} is unknown; signature not verified (lenient policy)`);
    } else if (!keys.some((k) => verifyJws(cpi!, k))) {
      if (strict) return fail(RC.INVALID_VALUE, ['cpiSignatureData.digitalSignature'], 'CPI signature verification failed');
      warn(`CPI signature by ${pid.cpiId} does not verify (lenient policy)`);
    }
    if ((cpi.data.fccId !== undefined && cpi.data.fccId !== fccId) || (cpi.data.cbsdSerialNumber !== undefined && cpi.data.cbsdSerialNumber !== serial)) {
      return fail(RC.INVALID_VALUE, ['cpiSignatureData'], 'Signed fccId/cbsdSerialNumber differ from the request');
    }
  }

  // 6. Plaintext versus CPI-signed installation data
  const preRow = e.db.get('SELECT data FROM conditional_reg WHERE fcc_id = ? AND serial = ?', fccId, serial);
  const pre = jparse<any>(preRow?.data, null);
  const category = item.cbsdCategory ?? pre?.cbsdCategory;
  if (cpi && item.installationParam !== undefined) {
    if (strict) return fail(RC.INVALID_VALUE, ['installationParam'], 'installationParam sent both in plaintext and in cpiSignatureData');
    warn('installationParam sent in plaintext and in cpiSignatureData; using the CPI-signed values');
  }
  if (category === 'B' && !cpi && item.installationParam !== undefined) {
    if (strict) return fail(RC.INVALID_VALUE, ['installationParam'], 'Category B installation parameters must be CPI-signed (cpiSignatureData) or provided by the SAS administrator');
    warn('Category B installationParam is not CPI-signed (lenient policy)');
  }

  // 7. Effective registration: preload ← request ← CPI-signed data
  const pickIp = cpi?.data.installationParam ?? item.installationParam;
  const installationParam = pre?.installationParam || pickIp
    ? { ...(isObj(pre?.installationParam) ? pre.installationParam : {}), ...(isObj(pickIp) ? pickIp : {}) }
    : undefined;
  if (pickIp !== undefined && !isObj(pickIp)) return fail(RC.INVALID_VALUE, ['installationParam']);
  const eff: Record<string, any> = {
    userId, fccId, cbsdSerialNumber: serial,
    callSign: item.callSign ?? pre?.callSign,
    cbsdCategory: category,
    airInterface: item.airInterface ?? pre?.airInterface,
    installationParam,
    measCapability: item.measCapability ?? pre?.measCapability,
    groupingParam: item.groupingParam ?? pre?.groupingParam,
    cbsdInfo: item.cbsdInfo ?? pre?.cbsdInfo,
  };
  if (pid) eff.professionalInstallerData = pid;
  if (eff.measCapability === undefined && !strict) eff.measCapability = [];
  for (const k of Object.keys(eff)) if (eff[k] === undefined) delete eff[k];

  // 8. Value validation
  const inv: string[] = [];
  if (eff.cbsdCategory !== undefined && eff.cbsdCategory !== 'A' && eff.cbsdCategory !== 'B') inv.push('cbsdCategory');
  if (eff.callSign !== undefined && typeof eff.callSign !== 'string') inv.push('callSign');
  if (eff.airInterface !== undefined) {
    const rt = eff.airInterface?.radioTechnology;
    if (!isObj(eff.airInterface) || (rt !== undefined && typeof rt !== 'string')) inv.push('airInterface');
    else if (typeof rt === 'string' && !RADIO_TECHNOLOGIES.includes(rt)) {
      if (strict) inv.push('airInterface.radioTechnology');
      else warn(`unrecognised radioTechnology ${rt}`);
    }
  }
  if (eff.measCapability !== undefined) {
    if (!Array.isArray(eff.measCapability) || eff.measCapability.some((m: any) => !MEAS_CAPABILITIES.includes(m))) inv.push('measCapability');
  }
  if (eff.groupingParam !== undefined && !Array.isArray(eff.groupingParam)) inv.push('groupingParam');
  if (eff.cbsdInfo !== undefined && !isObj(eff.cbsdInfo)) inv.push('cbsdInfo');
  const ip = eff.installationParam;
  if (ip && s.acceptMicrodegrees) {
    // Some radios (Sercomm LTE) send their TR-069 location: degrees × 1,000,000. Only whole numbers
    // that cannot be degrees are read that way; anything else out of range still fails below.
    const read: string[] = [];
    for (const [k, max] of [['latitude', 90], ['longitude', 180]] as const) {
      const v = ip[k];
      if (Number.isInteger(v) && Math.abs(v) >= 1000 && Math.abs(v) <= max * 1e6) {
        ip[k] = v / 1e6;
        read.push(`${k} ${v} as ${ip[k]}`);
      }
    }
    if (read.length) warn(`location sent in millionths of a degree; read ${read.join(', ')}`);
  }
  if (ip) {
    for (const [k, [lo, hi]] of Object.entries(RANGES)) {
      if (ip[k] === undefined || ip[k] === null) continue;
      if (typeof ip[k] !== 'number' || !Number.isFinite(ip[k]) || ip[k] < lo || ip[k] > hi) inv.push(`installationParam.${k}`);
    }
    if (ip.heightType !== undefined && ip.heightType !== 'AGL' && ip.heightType !== 'AMSL') inv.push('installationParam.heightType');
    if (ip.indoorDeployment !== undefined && typeof ip.indoorDeployment !== 'boolean') inv.push('installationParam.indoorDeployment');
    if (ip.antennaModel !== undefined && (typeof ip.antennaModel !== 'string' || ip.antennaModel.length > 128)) inv.push('installationParam.antennaModel');
  }
  if (inv.length) return fail(RC.INVALID_VALUE, inv, `Invalid value(s): ${inv.join(', ')}`);

  // 9. EIRP and deployment rules
  if (ip && typeof ip.eirpCapability === 'number') {
    const fccMax = typeof fccRow?.max_eirp === 'number' ? fccRow.max_eirp : s.defaultFccMaxEirp;
    if (ip.eirpCapability > fccMax) return fail(RC.INVALID_VALUE, ['installationParam.eirpCapability'], `eirpCapability exceeds the FCC certified maximum of ${fccMax} dBm/10MHz`);
    if (eff.cbsdCategory === 'A' && ip.eirpCapability > s.maxEirpCatA + 10) {
      return fail(RC.INVALID_VALUE, ['installationParam.eirpCapability'], `Category A eirpCapability exceeds ${s.maxEirpCatA + 10} dBm/10MHz`);
    }
    if (eff.cbsdCategory === 'B' && ip.eirpCapability > s.maxEirpCatB + 10) {
      return fail(RC.INVALID_VALUE, ['installationParam.eirpCapability'], `Category B eirpCapability exceeds ${s.maxEirpCatB + 10} dBm/10MHz`);
    }
    if (ip.indoorDeployment === true && ip.eirpCapability > s.maxEirpCatA + 10) {
      return fail(RC.INVALID_VALUE, ['installationParam.eirpCapability'], `Indoor CBSDs are limited to ${s.maxEirpCatA + 10} dBm/10MHz`);
    }
  }
  if (eff.cbsdCategory === 'B' && ip?.indoorDeployment === true && s.rejectIndoorCatB) {
    return fail(RC.INVALID_VALUE, ['installationParam.indoorDeployment'], 'Category B CBSDs must be deployed outdoors');
  }

  // 10. Category A outdoor: antenna HAAT must not exceed 6 m
  if (s.haatCheck && eff.cbsdCategory === 'A' && ip?.indoorDeployment === false && num(ip.latitude) && num(ip.longitude) && num(ip.height) && ip.heightType) {
    const haat = e.terrain?.haat(ip.latitude, ip.longitude, ip.height, ip.heightType) ?? null;
    if (haat == null) {
      warn(e.terrain?.tileCount
        ? 'HAAT not checked: no terrain tile covers this location'
        : `HAAT not checked: no terrain tiles loaded (add 1-arc-second elevation tiles to ${e.terrain?.directory ?? 'SAS_TERRAIN_DIR, default <data>/terrain'}; see server/src/tools/fetch-terrain.ts)`);
    } else if (haat > 6) {
      return fail(RC.INVALID_VALUE, ['installationParam.height'], `Category A outdoor antenna HAAT ${haat.toFixed(1)} m exceeds 6 m`);
    }
  }

  // 11. REG-conditional completeness
  const need: string[] = [];
  if (eff.cbsdCategory === undefined) need.push('cbsdCategory');
  if (!eff.airInterface?.radioTechnology) need.push('airInterface.radioTechnology');
  if (eff.measCapability === undefined) need.push('measCapability');
  const ipNeed = ['latitude', 'longitude', 'height', 'heightType', 'indoorDeployment', 'antennaGain'];
  if (eff.cbsdCategory === 'B') ipNeed.push('antennaAzimuth', 'antennaDowntilt', 'antennaBeamwidth');
  const ipMissing = ipNeed.filter((k) => ip?.[k] === undefined || ip?.[k] === null).map((k) => `installationParam.${k}`);
  if (s.missingInstallParams === 'register' && ipMissing.length && !need.length) {
    warn(`registered without installation data (${ipMissing.map((k) => k.slice('installationParam.'.length)).join(', ')})${ip?.latitude == null || ip?.longitude == null ? '; location unknown, so every active protection area applies to it' : ''}`);
  } else {
    need.push(...ipMissing);
  }
  if (need.length) return fail(RC.REG_PENDING, need, `Missing REG-conditional parameter(s): ${need.join(', ')}`);

  // Client certificate identity (WINNF-TS-0065): a CBSD certificate must name this device.
  const certId = Engine.certIdentity(ctx.cert);
  if (certId && (certId.fccId !== fccId || certId.serial !== serial) && s.certIdentityCheck !== 'off') {
    const msg = `client certificate identifies ${certId.fccId}:${certId.serial}, request is for ${fccId}:${serial}`;
    if (s.certIdentityCheck === 'enforce') return fail(RC.CERT_ERROR, undefined, msg);
    warn(msg);
  }

  const cbsdId = Engine.makeCbsdId(fccId, serial);
  const now = Date.now();
  const existing = e.db.get('SELECT * FROM cbsds WHERE cbsd_id = ?', cbsdId) as Row | undefined;

  // Manual approval hold
  if (s.manualApproval && !existing?.approved) {
    upsert(e, cbsdId, existing, item, eff, ctx, 'PENDING', now);
    e.bus.changed('cbsds');
    return fail(RC.REG_PENDING, undefined, 'Registration awaiting approval by the SAS administrator');
  }

  // 12. Success — same cbsdId on re-registration; all previous grants are removed.
  if (existing) {
    const n = e.deleteAllGrants(cbsdId, existing.state === 'REGISTERED' ? 're-registration' : 'registration');
    if (n) e.bus.event('warn', 'grant', `${n} grant(s) of ${cbsdId} removed by re-registration`, cbsdId);
  }
  upsert(e, cbsdId, existing, item, eff, ctx, 'REGISTERED', now);
  const resp: Resp = { cbsdId, response: e.rc(RC.SUCCESS) };

  const caps: string[] = eff.measCapability ?? [];
  const configured = new Set<string>(jparse<string[]>(existing?.reg_meas_config, []));
  if (e.measInRegistration) configured.add('RECEIVED_POWER_WITHOUT_GRANT');
  const measCfg = [...configured].filter((c) => caps.includes(c) && c !== 'RECEIVED_POWER_WITH_GRANT');
  e.db.run('UPDATE cbsds SET meas_required = ? WHERE cbsd_id = ?',
    JSON.stringify({ withoutGrant: measCfg.includes('RECEIVED_POWER_WITHOUT_GRANT') }), cbsdId);
  if (measCfg.length) resp.measReportConfig = measCfg;

  e.bus.event('success', 'registration',
    `${existing?.state === 'REGISTERED' ? 'Re-registered' : 'Registered'} ${cbsdId} (Category ${eff.cbsdCategory}, ${ctx.transport.toUpperCase()}${ctx.cert ? ', cert ' + (ctx.cert.commonName ?? ctx.cert.subject) : ''})`, cbsdId);
  return resp;
}

function upsert(e: Engine, cbsdId: string, existing: Row | undefined, item: any, eff: Record<string, any>, ctx: RequestCtx, state: string, now: number) {
  const certInfo = ctx.cert ? JSON.stringify({
    subject: ctx.cert.subject, issuer: ctx.cert.issuer, fingerprint: ctx.cert.fingerprint256, roles: ctx.cert.roles,
    notAfter: ctx.cert.notAfter, authorized: ctx.certAuthorized,
  }) : null;
  const vals = [
    eff.userId, eff.cbsdCategory ?? null, state, JSON.stringify(item), JSON.stringify(eff), JSON.stringify(eff.measCapability ?? []),
    certInfo, ctx.cert?.fingerprint256 ?? null, ctx.transport, ctx.remoteAddr, now,
  ];
  if (existing) {
    e.db.run(
      `UPDATE cbsds SET user_id = ?, category = ?, state = ?, registration = ?, effective = ?, meas_capability = ?, cert_info = ?,
        cert_fingerprint = ?, transport = ?, remote_addr = ?, updated_at = ?, last_seen = ?, pending_deregister = 0,
        registered_at = CASE WHEN ? = 'REGISTERED' THEN ? ELSE registered_at END, last_meas_report = NULL
       WHERE cbsd_id = ?`,
      ...vals, now, state, now, cbsdId);
  } else {
    e.db.run(
      `INSERT INTO cbsds(user_id, category, state, registration, effective, meas_capability, cert_info, cert_fingerprint, transport,
        remote_addr, updated_at, last_seen, registered_at, cbsd_id, fcc_id, serial, created_at, approved)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ...vals, now, state === 'REGISTERED' ? now : null, cbsdId, eff.fccId, eff.cbsdSerialNumber, now, state === 'REGISTERED' ? 1 : 0);
  }
}

function isObj(v: any): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function num(v: any): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}
