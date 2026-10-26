import type { Db } from './db.ts';

// Runtime-editable SAS configuration, persisted in the settings table.

export type ClientAuthMode = 'require' | 'optional' | 'none';
export type CipherPolicy = 'winnforum' | 'extended' | 'nodejs-default';
export type IdentityCheck = 'off' | 'warn' | 'enforce';
export type RoleCheck = 'off' | 'lenient' | 'strict';

export interface Settings {
  // --- Listeners -----------------------------------------------------------
  sasHttpEnabled: boolean;
  sasHttpPort: number;
  sasHttpsEnabled: boolean;
  sasHttpsPort: number;
  /** require = WInnForum mutual TLS (handshake fails without a trusted client cert). */
  tlsClientAuth: ClientAuthMode;
  tlsMinVersion: 'TLSv1.2' | 'TLSv1.3';
  tlsMaxVersion: 'TLSv1.2' | 'TLSv1.3';
  tlsCipherPolicy: CipherPolicy;
  /** Certificates (ids in the certs table) presented by the HTTPS listener. */
  serverCertIds: string[];
  /** CA certificates (ids) trusted for client authentication. Empty = all CA certs in the store. */
  trustedClientCaIds: string[];
  /** Check every certificate of the client chain against local and imported CRLs (HTTP 403 if revoked). */
  tlsCheckCrl: boolean;
  /**
   * WINNF-TS-0065 role check on CBSD-protocol requests (responseCode 104): lenient rejects certificates
   * carrying non-CBSD WInnForum policies; strict also requires ROLE_CBSD or ROLE_OPERATOR.
   */
  certRoleCheck: RoleCheck;
  /** Reject (HTTP 403) HTTPS requests whose client certificate did not verify (only relevant when client auth is optional). */
  rejectUnverifiedClientCert: boolean;

  // --- Protocol ------------------------------------------------------------
  supportedVersions: string[];
  /** Accept paths without a /vX.Y/ segment (e.g. /sas-api/registration) as the first supported version. */
  acceptVersionlessPaths: boolean;
  heartbeatIntervalSec: number;
  /** transmitExpireTime = heartbeat time + this many seconds (capped at grantExpireTime). */
  transmitExpireSec: number;
  grantExpireSec: number;
  /** Seconds without a successful heartbeat before SAS-CBSD connectivity is considered lost (spec: 7 days). */
  connectivityLostSec: number;
  /** Respond 200 with per-object responseCode 100 for unknown versions (otherwise HTTP 404). */
  versionErrorAsResponseCode: boolean;
  /** Spectrum inquiry: split available ranges into channels of this width (none = maximal contiguous ranges). */
  siqChannelization: 'none' | '5MHz' | '10MHz';
  /** Spectrum inquiry: also remove spectrum blocked by active DPAs (WInnForum tests expect DPAs to be ignored). */
  siqIncludeDpa: boolean;
  /** Answer 502 whenever a CBSD reports AUTHORIZED for a grant the SAS holds as GRANTED (not only before the first heartbeat). */
  strictOperationState: boolean;
  responseDelayMs: number;
  includeResponseMessage: boolean;

  // --- Registration policy -------------------------------------------------
  requireKnownFccId: boolean;
  requireKnownUserId: boolean;
  /**
   * strict = WInnForum rules: Category B installation data must be CPI-signed or preloaded, CPI must be known
   * and its JWS signature valid, measCapability is REG-conditional. lenient = accept and log warnings instead.
   */
  registrationPolicy: 'strict' | 'lenient';
  /** Compare FCCID/SERIAL in the CBSD client certificate with the registration request. */
  certIdentityCheck: IdentityCheck;
  /** Default certified max EIRP (dBm/10MHz) used when an FCC ID has no injected value. */
  defaultFccMaxEirp: number;
  /** Hold every new registration at REG_PENDING until approved in the UI. */
  manualApproval: boolean;
  /** Category A outdoor HAAT <= 6 m check (needs USGS NED terrain tiles in the terrain directory). */
  haatCheck: boolean;
  /** Category B must be indoorDeployment=false (FCC Part 96.45). */
  rejectIndoorCatB: boolean;

  // --- Spectrum policy -----------------------------------------------------
  bandLowHz: number;
  bandHighHz: number;
  /** GAA availability blocks (Hz ranges) — spectrum outside these is unavailable for GAA. */
  gaaRanges: Array<{ low: number; high: number }>;
  maxEirpCatA: number; // dBm/MHz
  maxEirpCatB: number; // dBm/MHz
  /** Granted EIRP above the computed limit: reject (INTERFERENCE) or reject with suggestion. */
  maxGrantBandwidthHz: number;
  maxGrantsPerCbsd: number;
  /** Frequency granularity requirement for grant edges (Hz); 0 = any. */
  grantFrequencyStepHz: number;
  suggestOperationParam: boolean;

  // --- Admin / harness -----------------------------------------------------
  harnessAdminEnabled: boolean;
  msgLogLimit: number;
  eventLogLimit: number;
  uiPassword: string;

  // --- Map -----------------------------------------------------------------
  /** builtin = bundled offline basemap; local = offline tile store (SAS_TILES_DIR); url = online tile server. */
  mapSource: 'builtin' | 'local' | 'url';
  /** Tile set in the offline tile store (file or folder name); '' = first usable one. */
  mapLocalTiles: string;
  /** {z}/{x}/{y} tile URL template for mapSource = url. */
  mapTileUrl: string;
  mapTileAttribution: string;
  mapTileMaxZoom: number;
  /** Invert raster tiles in the dark theme. */
  mapDarkenTiles: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  sasHttpEnabled: true,
  sasHttpPort: 8000,
  sasHttpsEnabled: true,
  sasHttpsPort: 8443,
  tlsClientAuth: 'optional',
  tlsMinVersion: 'TLSv1.2',
  tlsMaxVersion: 'TLSv1.2',
  tlsCipherPolicy: 'winnforum',
  serverCertIds: [],
  trustedClientCaIds: [],
  tlsCheckCrl: true,
  certRoleCheck: 'lenient',
  rejectUnverifiedClientCert: false,

  supportedVersions: ['v1.2'],
  acceptVersionlessPaths: true,
  heartbeatIntervalSec: 60,
  transmitExpireSec: 240,
  grantExpireSec: 7 * 24 * 3600,
  connectivityLostSec: 7 * 24 * 3600,
  versionErrorAsResponseCode: false,
  siqChannelization: 'none',
  siqIncludeDpa: false,
  strictOperationState: false,
  responseDelayMs: 0,
  includeResponseMessage: true,

  requireKnownFccId: false,
  requireKnownUserId: false,
  registrationPolicy: 'lenient',
  certIdentityCheck: 'warn',
  defaultFccMaxEirp: 47,
  manualApproval: false,
  haatCheck: true,
  rejectIndoorCatB: true,

  bandLowHz: 3550e6,
  bandHighHz: 3700e6,
  gaaRanges: [{ low: 3550e6, high: 3700e6 }],
  maxEirpCatA: 20,
  maxEirpCatB: 37,
  maxGrantBandwidthHz: 150e6,
  maxGrantsPerCbsd: 32,
  grantFrequencyStepHz: 0,
  suggestOperationParam: true,

  harnessAdminEnabled: true,
  msgLogLimit: 20000,
  eventLogLimit: 20000,
  uiPassword: '',

  mapSource: 'builtin',
  mapLocalTiles: '',
  // USGS The National Map: US government work, public domain, no API key.
  mapTileUrl: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
  mapTileAttribution: 'USGS The National Map',
  mapTileMaxZoom: 16,
  mapDarkenTiles: true,
};

/** Keys whose change requires the SAS listeners to be restarted. */
export const LISTENER_KEYS: Array<keyof Settings> = [
  'sasHttpEnabled', 'sasHttpPort', 'sasHttpsEnabled', 'sasHttpsPort', 'tlsClientAuth',
  'tlsMinVersion', 'tlsMaxVersion', 'tlsCipherPolicy', 'serverCertIds', 'trustedClientCaIds', 'tlsCheckCrl',
];

export class SettingsStore {
  private cache: Settings;
  private listeners: Array<(changed: Array<keyof Settings>) => void> = [];

  private db: Db;

  constructor(db: Db) {
    this.db = db;
    const stored: Partial<Settings> = {};
    for (const r of db.all('SELECT key, value FROM settings')) {
      if (!(r.key in DEFAULT_SETTINGS)) continue;
      try {
        (stored as any)[r.key] = JSON.parse(r.value);
      } catch { /* ignore corrupt values */ }
    }
    this.cache = { ...DEFAULT_SETTINGS, ...stored };
  }

  get(): Settings {
    return this.cache;
  }

  onChange(fn: (changed: Array<keyof Settings>) => void) {
    this.listeners.push(fn);
  }

  update(patch: Partial<Settings>): Array<keyof Settings> {
    const changed: Array<keyof Settings> = [];
    const next = { ...this.cache };
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS) || v === undefined) continue;
      const key = k as keyof Settings;
      const def = DEFAULT_SETTINGS[key];
      if (typeof def !== typeof v && !(Array.isArray(def) && Array.isArray(v))) {
        throw new Error(`Invalid type for setting ${k}`);
      }
      if (JSON.stringify(next[key]) !== JSON.stringify(v)) {
        (next as any)[key] = v;
        changed.push(key);
      }
    }
    if (!changed.length) return changed;
    this.cache = next;
    for (const k of changed) {
      this.db.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        k, JSON.stringify(next[k]));
    }
    for (const l of this.listeners) l(changed);
    return changed;
  }

  resetToDefaults(keep: Array<keyof Settings> = []) {
    const patch: Partial<Settings> = {};
    for (const k of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
      if (!keep.includes(k)) (patch as any)[k] = DEFAULT_SETTINGS[k];
    }
    this.update(patch);
  }
}
