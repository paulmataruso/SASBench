import { DEFAULT_SETTINGS, LISTENER_KEYS, type Settings } from '../../settings.ts';
import { S, type Schema } from './schema.ts';

// Description of every runtime setting: group, JSON schema (type, allowed values, range) and
// meaning. Drives validation of settings changes made through the API, GET /settings/schema and
// the generated reference. A test fails when a setting exists without an entry here.

export interface SettingMeta {
  group: 'Listeners' | 'TLS' | 'Protocol' | 'Registration policy' | 'Spectrum policy' | 'Administration' | 'Map';
  schema: Schema;
  description: string;
  unit?: string;
}

const port = S.int({ minimum: 1, maximum: 65535 });
const dbm = (lo: number, hi: number) => S.num({ minimum: lo, maximum: hi });

export const SETTINGS_META: Record<keyof Settings, SettingMeta> = {
  sasHttpEnabled: { group: 'Listeners', schema: S.bool(), description: 'Serve the SAS–CBSD protocol over plain HTTP.' },
  sasHttpPort: { group: 'Listeners', schema: port, description: 'Plain-HTTP listener port. While the SAS_HTTP_PORT environment variable is set, it sets the port instead and this setting cannot be changed.' },
  sasHttpsEnabled: { group: 'Listeners', schema: S.bool(), description: 'Serve the SAS–CBSD protocol over HTTPS (WINNF-TS-0065).' },
  sasHttpsPort: { group: 'Listeners', schema: port, description: 'HTTPS listener port. While the SAS_HTTPS_PORT environment variable is set, it sets the port instead and this setting cannot be changed.' },
  tlsClientAuth: {
    group: 'TLS', schema: S.enum(['require', 'optional', 'none']),
    description: '`require`: WInnForum mutual TLS, the handshake fails without a trusted client certificate. `optional`: a certificate is requested but not required. `none`: no certificate is requested.',
  },
  tlsMinVersion: { group: 'TLS', schema: S.enum(['TLSv1.2', 'TLSv1.3']), description: 'Lowest TLS version accepted. WINNF-TS-0065 requires TLS 1.2.' },
  tlsMaxVersion: { group: 'TLS', schema: S.enum(['TLSv1.2', 'TLSv1.3']), description: 'Highest TLS version offered.' },
  tlsCipherPolicy: {
    group: 'TLS', schema: S.enum(['winnforum', 'extended', 'nodejs-default']),
    description: '`winnforum`: only the five WINNF-TS-0065 suites. `extended`: those plus common legacy suites. `nodejs-default`: whatever Node.js offers.',
  },
  serverCertIds: { group: 'TLS', schema: S.arr(S.str({ minLength: 1 })), description: 'Certificates (ids from /certs, each with a private key) presented by the HTTPS listener: at most one per key type, typically one RSA and one ECDSA. Cannot be emptied while the HTTPS listener is enabled; empty at first start, when the lab PKI fills it.' },
  trustedClientCaIds: { group: 'TLS', schema: S.arr(S.str({ minLength: 1 })), description: 'CA certificates trusted for client authentication. Empty: every CA certificate in the store.' },
  tlsCheckCrl: { group: 'TLS', schema: S.bool(), description: 'Check every certificate of the client chain against local revocations and imported CRLs (HTTP 403 when revoked).' },
  certRoleCheck: {
    group: 'TLS', schema: S.enum(['off', 'lenient', 'strict']),
    description: 'WINNF-TS-0065 role check (responseCode 104). `lenient` rejects certificates with non-CBSD WInnForum policies; `strict` also requires ROLE_CBSD or ROLE_OPERATOR.',
  },
  rejectUnverifiedClientCert: { group: 'TLS', schema: S.bool(), description: 'With optional client authentication: answer HTTP 403 when a presented client certificate does not verify.' },

  supportedVersions: { group: 'Protocol', schema: S.arr(S.str({ pattern: '^v\\d+\\.\\d+$' }), { minItems: 1 }), description: 'SAS protocol versions accepted in the URL path, e.g. ["v1.2"]. The first is the default.' },
  acceptVersionlessPaths: { group: 'Protocol', schema: S.bool(), description: 'Accept paths without a /vX.Y/ segment (e.g. /sas-api/registration) as the first supported version.' },
  heartbeatIntervalSec: { group: 'Protocol', schema: S.int({ minimum: 1 }), unit: 's', description: 'heartbeatInterval returned in grant responses.' },
  transmitExpireSec: { group: 'Protocol', schema: S.int({ minimum: 1, maximum: 240 }), unit: 's', description: 'transmitExpireTime = heartbeat time + this many seconds (capped at grantExpireTime). WINNF-TS-0016 allows at most 240 s.' },
  grantExpireSec: { group: 'Protocol', schema: S.int({ minimum: 60 }), unit: 's', description: 'Grant lifetime from issue (or renewal).' },
  connectivityLostSec: { group: 'Protocol', schema: S.int({ minimum: 1 }), unit: 's', description: 'Time without a successful heartbeat after which the SAS terminates a CBSD\'s grants (specification: 7 days).' },
  versionErrorAsResponseCode: { group: 'Protocol', schema: S.bool(), description: 'Answer unknown versions with HTTP 200 and responseCode 100 per object instead of HTTP 404.' },
  siqChannelization: { group: 'Protocol', schema: S.enum(['none', '5MHz', '10MHz']), description: 'Split spectrum-inquiry ranges into channels of this width. `none`: maximal contiguous ranges.' },
  siqIncludeDpa: { group: 'Protocol', schema: S.bool(), description: 'Also remove spectrum blocked by active DPAs from spectrum-inquiry answers (the WInnForum tests expect DPAs to be ignored).' },
  strictOperationState: { group: 'Protocol', schema: S.bool(), description: 'Answer 502 whenever a CBSD reports AUTHORIZED for a grant the SAS holds as GRANTED, not only before the first heartbeat.' },
  responseDelayMs: { group: 'Protocol', schema: S.int({ minimum: 0, maximum: 600000 }), unit: 'ms', description: 'Delay added to every SAS–CBSD response.' },
  includeResponseMessage: { group: 'Protocol', schema: S.bool(), description: 'Include responseMessage in response objects.' },

  requireKnownFccId: { group: 'Registration policy', schema: S.bool(), description: 'Reject (103) FCC IDs that are not in the registry.' },
  requireKnownUserId: { group: 'Registration policy', schema: S.bool(), description: 'Reject (103) user IDs that are not in the registry.' },
  registrationPolicy: {
    group: 'Registration policy', schema: S.enum(['strict', 'lenient']),
    description: '`strict`: WInnForum rules (Category B installation data must be CPI-signed or preloaded, CPI must be known and its signature valid). `lenient`: accept and log warnings.',
  },
  missingInstallParams: {
    group: 'Registration policy', schema: S.enum(['pending', 'register']),
    description: 'A registration without location data and nothing preloaded. `pending`: 200 REG_PENDING until the data is provided (WINNF-TS-0016). `register`: accept it with an unknown location.',
  },
  certIdentityCheck: { group: 'Registration policy', schema: S.enum(['off', 'warn', 'enforce']), description: 'Compare the FCC ID and serial number in the client certificate with the request, and bind the cbsdId to the registering certificate.' },
  defaultFccMaxEirp: { group: 'Registration policy', schema: dbm(-137, 100), unit: 'dBm/10 MHz', description: 'Certified maximum EIRP used for FCC IDs without a registry value.' },
  manualApproval: { group: 'Registration policy', schema: S.bool(), description: 'Hold every new registration at REG_PENDING until approved (POST /cbsds/{cbsdId}/approve).' },
  haatCheck: { group: 'Registration policy', schema: S.bool(), description: 'Category A outdoor HAAT ≤ 6 m check (needs terrain tiles).' },
  rejectIndoorCatB: { group: 'Registration policy', schema: S.bool(), description: 'Reject Category B registrations with indoorDeployment=true (FCC Part 96.45).' },
  acceptMicrodegrees: {
    group: 'Registration policy', schema: S.bool(),
    description: 'Read a latitude or longitude sent in millionths of a degree (e.g. 43375246 for 43.375246, as some Sercomm LTE radios send it) as degrees, with a warning event. Only whole numbers of magnitude 1000 or more are read that way; any other out-of-range value still gets responseCode 103.',
  },

  bandLowHz: { group: 'Spectrum policy', schema: S.hz(), unit: 'Hz', description: 'Lower edge of the band the SAS manages.' },
  bandHighHz: { group: 'Spectrum policy', schema: S.hz(), unit: 'Hz', description: 'Upper edge of the band the SAS manages.' },
  gaaRanges: {
    group: 'Spectrum policy', schema: S.arr(S.obj({ low: S.hz(), high: S.hz() }, ['low', 'high'])),
    unit: 'Hz', description: 'Ranges available for GAA. Spectrum outside them is unavailable for GAA grants.',
  },
  maxEirpCatA: { group: 'Spectrum policy', schema: dbm(-137, 100), unit: 'dBm/MHz', description: 'Category A EIRP limit.' },
  maxEirpCatB: { group: 'Spectrum policy', schema: dbm(-137, 100), unit: 'dBm/MHz', description: 'Category B EIRP limit.' },
  maxGrantBandwidthHz: { group: 'Spectrum policy', schema: S.int({ minimum: 1 }), unit: 'Hz', description: 'Widest grant allowed (400 INTERFERENCE with a suggestion above it).' },
  maxGrantsPerCbsd: { group: 'Spectrum policy', schema: S.int({ minimum: 1 }), description: 'Live grants a CBSD may hold.' },
  grantFrequencyStepHz: { group: 'Spectrum policy', schema: S.int({ minimum: 0 }), unit: 'Hz', description: 'Grant edges must be multiples of this. 0: any frequency.' },
  suggestOperationParam: { group: 'Spectrum policy', schema: S.bool(), description: 'Suggest an alternative operationParam with 400 and 501 answers.' },

  harnessAdminEnabled: { group: 'Administration', schema: S.bool(), description: 'Serve the WInnForum test-harness admin API under /admin/ on the SAS listeners. The /api/v1/harness endpoints work either way.' },
  msgLogLimit: { group: 'Administration', schema: S.int({ minimum: 100 }), description: 'Wire-log entries kept; older ones are pruned.' },
  eventLogLimit: { group: 'Administration', schema: S.int({ minimum: 100 }), description: 'Events kept; older ones are pruned.' },

  mapSource: { group: 'Map', schema: S.enum(['builtin', 'local', 'url']), description: '`builtin`: bundled offline basemap. `local`: the offline tile store. `url`: an online tile server.' },
  mapLocalTiles: { group: 'Map', schema: S.str({ maxLength: 200 }), description: 'Tile set in the offline tile store (file or folder name). Empty: the first usable one.' },
  mapTileUrl: { group: 'Map', schema: S.str({ maxLength: 2000 }), description: '{z}/{x}/{y} tile URL template for mapSource=url.' },
  mapTileAttribution: { group: 'Map', schema: S.str({ maxLength: 500 }), description: 'Attribution shown on the map.' },
  mapTileMaxZoom: { group: 'Map', schema: S.int({ minimum: 1, maximum: 22 }), description: 'Highest zoom level the tile source serves.' },
  mapDarkenTiles: { group: 'Map', schema: S.bool(), description: 'Invert raster tiles in the dark theme.' },
};

export const settingKeys = Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>;

/** Body schema for a partial settings update. */
export const settingsPatchSchema: Schema = S.obj(
  Object.fromEntries(settingKeys.map((k) => [k, { ...SETTINGS_META[k].schema, description: SETTINGS_META[k].description }])),
);

/** Settings as returned by the API. */
export const settingsSchema: Schema = {
  type: 'object',
  properties: Object.fromEntries(settingKeys.map((k) => [k, { ...SETTINGS_META[k].schema, description: SETTINGS_META[k].description }])),
  required: settingKeys,
  additionalProperties: false,
};

export function describeSettings(current: Settings, fromEnv: Partial<Record<keyof Settings, string>> = {}) {
  return settingKeys.map((key) => ({
    key, group: SETTINGS_META[key].group, description: SETTINGS_META[key].description, unit: SETTINGS_META[key].unit ?? null,
    schema: SETTINGS_META[key].schema, default: DEFAULT_SETTINGS[key], value: current[key],
    restartsListeners: LISTENER_KEYS.includes(key), fromEnv: fromEnv[key] ?? null,
  }));
}
