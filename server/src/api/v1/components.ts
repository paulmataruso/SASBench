import { S, ref, type Schema, type SchemaRegistry } from './schema.ts';
import { settingsSchema } from './settingsMeta.ts';

// Named schemas for request and response bodies (OpenAPI components.schemas). Response objects list
// every field and forbid others, so the test suite can check each response against its schema and
// catch documentation drift.

/** Object whose fields are all present unless listed as optional. */
function R(properties: Record<string, Schema>, optional: string[] = [], o: { description?: string } = {}): Schema {
  return S.obj(properties, Object.keys(properties).filter((k) => !optional.includes(k)), o);
}

const str = S.str();
const int = S.int();
const num = S.num();
const bool = S.bool();
const nstr = S.nullable(S.str());
const nint = S.nullable(S.int());
const nnum = S.nullable(S.num());
const strs = S.arr(S.str());
const range = R({ low: S.hz(), high: S.hz() });
const ms = (description: string) => S.int({ description: `${description} (epoch milliseconds).` });
const nms = (description: string) => S.nullable(S.int({ description: `${description} (epoch milliseconds).` }));

const dailyProps = {
  completed: S.bool({ description: 'False while a run is in progress.' }), running: bool,
  lastStarted: nms('Start of the last run'), lastCompleted: nms('End of the last run'), log: S.arr(S.str(), { description: 'Log lines of the last run.' }),
};

export const COMPONENTS: SchemaRegistry = {
  Error: R({
    error: R({
      status: S.int({ description: 'HTTP status.' }),
      code: S.str({ description: 'Stable machine-readable code: bad_request, validation_failed, invalid_json, unauthorized, forbidden, origin_not_allowed, not_found, route_not_found, method_not_allowed, conflict, payload_too_large, operation_failed, internal_error.' }),
      message: S.str({ description: 'Human-readable explanation.' }),
      requestId: S.str({ description: 'Same as the X-Request-Id response header; quote it when reporting a problem.' }),
      details: S.arr(R({ path: str, message: str }), { description: 'With validation_failed: one entry per problem.' }),
    }, ['details']),
  }),

  // ---------------------------------------------------------------- system
  ApiIndex: R({ service: str, version: str, apiVersion: str, openapi: str, links: S.obj({}, [], { additionalProperties: S.str() }) }),
  Health: R({
    status: S.enum(['ok', 'degraded']), version: str, uptimeMs: int,
    listeners: R({ http: S.bool({ description: 'HTTP listener is listening.' }), https: S.bool({ description: 'HTTPS listener is listening.' }) }),
  }),
  Listeners: R({
    http: R({ enabled: bool, listening: bool, port: int, error: nstr }),
    https: R({
      enabled: bool, listening: bool, port: int, error: nstr,
      clientAuth: S.str({ description: 'Client-certificate policy (setting tlsClientAuth).' }),
      serverCerts: S.arr(S.str(), { description: 'Names of the server certificates presented.' }),
      trustAnchors: S.int({ description: 'CA certificates trusted for client certificates.' }), ciphers: str, protocols: str,
    }),
  }),
  MeasurementTriggers: R({
    measInRegistration: S.bool({ description: 'Registration responses request RECEIVED_POWER_WITHOUT_GRANT reports.' }),
    measInHeartbeat: S.bool({ description: 'Heartbeat responses request RECEIVED_POWER_WITH_GRANT reports.' }),
  }),
  DailyStatus: R(dailyProps),
  DailyActivities: R({ ...dailyProps, scheduled: S.bool({ description: 'Runs every 24 hours (until the next reset).' }) }),
  PpaStatus: R({ completed: bool, withError: bool }, [], { description: 'Result of the last PPA creation (harness get_ppa_status).' }),
  Flags: R({ ntiaExclusionZones: bool, scheduledDailyActivities: bool, escConnected: bool }),
  OperationsState: R({ daily: ref('DailyStatus'), ppaStatus: ref('PpaStatus'), flags: ref('Flags'), measurementTriggers: ref('MeasurementTriggers') }),
  Status: R({
    version: str, startedAt: ms('Process start'), now: ms('Server time'), hostname: str, listeners: ref('Listeners'),
    urls: S.arr(S.str(), { description: 'SAS base URLs to configure in CBSDs.' }),
    counts: R({
      cbsdsRegistered: int, cbsdsPending: int, cbsdsTotal: int, grantsByState: S.obj({}, [], { additionalProperties: S.int() }),
      authorizedMHz: num, messagesLastHour: int, errorsLastHour: int, activeProtections: int, ppas: int, faultRules: S.int({ description: 'Enabled fault rules.' }),
    }),
    triggers: ref('MeasurementTriggers'), daily: ref('DailyStatus'), ppaStatus: ref('PpaStatus'), flags: ref('Flags'),
    terrain: R({ directory: nstr, tiles: int }), profile: S.nullable(S.str({ description: 'Settings profile the current settings match.' })),
  }),
  SystemInfo: R({
    version: str, apiVersion: str, node: str, platform: str, arch: str, hostname: str, pid: int, startedAt: int, uptimeMs: int,
    memory: S.obj({}, [], { additionalProperties: S.int() }), uiPort: int, hostnames: strs, dataDir: str,
    database: R({ file: str, sizeBytes: nint, walSizeBytes: nint }), terrainDir: nstr, tilesDir: str,
  }),
  Activity: R({
    bucketMs: int, since: int,
    rows: S.arr(R({ bucket: ms('Bucket start'), method: nstr, count: int, errors: int })),
  }),
  Reference: R({
    responseCodes: S.arr(R({ code: int, name: str })), sasMethods: strs, radioTechnologies: strs, measCapabilities: strs,
    cbsdStates: strs, grantStates: strs, channelTypes: strs, faultActions: strs, protectionKinds: strs, protectionActions: strs,
    incumbentKinds: strs, keyTypes: strs, caRoles: strs,
    downloadFormats: S.arr(R({ format: str, key: bool, description: str })),
    harnessMethods: S.arr(R({ method: str, description: str })), settingsProfiles: strs, tokenScopes: strs,
  }),
  Principal: R({
    method: S.enum(['open', 'password', 'token']), scope: S.enum(['read', 'write']), tokenId: str, tokenName: str,
    passwordSet: S.bool({ description: 'A UI password is set (otherwise the API is open).' }),
  }, ['tokenId', 'tokenName']),
  Token: R({
    id: str, name: str, scope: S.enum(['read', 'write']), prefix: S.str({ description: 'First characters of the secret, to recognise it.' }),
    createdAt: int, expiresAt: nint, lastUsedAt: nms('Last use (updated at most once a minute)'), lastUsedAddr: nstr,
    token: S.str({ description: 'The secret. Returned once, when the token is created.' }),
  }, ['token']),

  // ---------------------------------------------------------------- settings
  Settings: settingsSchema,
  SettingsChange: R({
    changed: S.arr(S.str(), { description: 'Settings whose value changed.' }),
    listenersRestarted: S.bool({ description: 'The SAS listeners were restarted (the call waited for them).' }),
    settings: ref('Settings'), profile: nstr, listeners: ref('Listeners'),
  }),
  SettingDescription: R({
    key: str, group: str, description: str, unit: nstr, schema: S.anyObj({ description: 'JSON Schema of the value.' }),
    default: S.any(), value: S.any(), restartsListeners: bool,
  }),
  SettingsProfile: R({ name: str, label: str, description: str, settings: S.anyObj({ description: 'The settings the profile sets.' }) }),

  // ---------------------------------------------------------------- CBSDs and grants
  Cbsd: R({
    cbsdId: str, fccId: str, serial: str, userId: nstr, category: nstr, state: S.enum(['REGISTERED', 'PENDING', 'UNREGISTERED']),
    callSign: nstr, radioTechnology: nstr, latitude: nnum, longitude: nnum, height: nnum, heightType: nstr, indoor: S.nullable(S.bool()),
    eirpCapability: nnum, antennaGain: nnum, measCapability: strs,
    registration: S.anyObj({ description: 'The registration request as received.' }),
    effective: S.anyObj({ description: 'Registration merged with preloaded (conditional) and CPI-signed parameters: what the SAS uses.' }),
    certInfo: S.nullable(S.anyObj({ description: 'Client certificate the CBSD registered with.' })),
    approved: S.bool({ description: 'With setting manualApproval: an operator approved the registration.' }),
    transport: nstr, remoteAddr: nstr, eirpCapDbmMhz: S.nullable(S.num({ description: 'Operator EIRP cap (dBm/MHz).' })),
    pendingDeregister: S.bool({ description: 'The next request is answered with 105 DEREGISTER.' }), notes: nstr,
    regMeasConfig: strs, hbMeasConfig: strs, measRequired: S.anyObj(), lastMeasReport: S.nullable(S.any()),
    createdAt: int, registeredAt: nint, updatedAt: nint, lastSeen: nint, lastHeartbeatOk: nint,
    grants: S.obj({}, [], { additionalProperties: S.int(), description: 'Grant count by state.' }),
  }),
  CbsdAvailability: R({
    limits: R({ maxEirpPer10MHz: S.num({ description: 'dBm/10 MHz' }), maxEirpDbmMhz: S.num({ description: 'dBm/MHz' }) }),
    availability: S.arr(R({ low: S.hz(), high: S.hz(), channelType: S.enum(['GAA', 'PAL']), maxEirp: S.num({ description: 'dBm/MHz' }) })),
    protections: S.arr(R({ id: str, name: str, kind: str, action: str }), { description: 'Protections that cover this CBSD.' }),
  }),
  Grant: R({
    grantId: str, cbsdId: str, fccId: nstr, serial: nstr, category: nstr,
    state: S.enum(['GRANTED', 'AUTHORIZED', 'TERMINATED', 'RELINQUISHED', 'EXPIRED', 'DELETED']), suspended: bool,
    low: S.hz(), high: S.hz(), maxEirp: S.num({ description: 'dBm/MHz' }), channelType: S.enum(['GAA', 'PAL']),
    grantExpireTime: int, transmitExpireTime: nint, heartbeatInterval: int, heartbeatCount: int, lastHeartbeat: nint,
    pendingHeartbeatInterval: nint, suggestedOperationParam: S.nullable(S.anyObj()), endReason: nstr, endedAt: nint, createdAt: int,
  }),

  // ---------------------------------------------------------------- registry
  FccId: R({ fccId: str, maxEirp: S.nullable(S.num({ description: 'dBm/10 MHz' })), createdAt: int }),
  UserId: R({ userId: str, createdAt: int }),
  BlacklistEntry: R({ id: int, fccId: str, serial: S.nullable(S.str({ description: 'Null: every device of the FCC ID.' })), reason: nstr, createdAt: int }),
  ConditionalRegistration: R({ fccId: str, serial: str, data: S.anyObj({ description: 'The registrationData record.' }), source: nstr, createdAt: int }),
  CpiUser: R({ cpiId: str, name: nstr, publicKey: S.str({ description: 'PEM SubjectPublicKeyInfo.' }), source: str, createdAt: int }),
  Registry: R({
    fccIds: S.arr(ref('FccId')), userIds: S.arr(ref('UserId')), blacklist: S.arr(ref('BlacklistEntry')),
    conditional: S.arr(ref('ConditionalRegistration')), cpiUsers: S.arr(ref('CpiUser')),
  }),

  // ---------------------------------------------------------------- spectrum
  Protection: R({
    id: str, name: str, kind: str, source: S.str({ description: 'ui (operator), harness, ntia-e-dpa or ntia-p-dpa.' }),
    low: S.hz(), high: S.hz(), active: bool, channels: S.nullable(S.arr(S.arr(S.hz()))), action: S.enum(['suspend', 'terminate']),
    geometry: S.nullable(S.anyObj()), latitude: nnum, longitude: nnum, radiusKm: nnum, neighborhood: S.nullable(S.anyObj()), notes: nstr, updatedAt: int,
  }),
  Ppa: R({
    id: str, name: str,
    channels: S.arr(R({ low: S.hz(), high: S.hz(), palId: nstr, licenseExpiration: nint }, ['palId', 'licenseExpiration'])),
    members: strs, geometry: S.nullable(S.anyObj()), expiration: nint, source: str,
  }),
  Incumbent: R({ kind: str, id: str, data: S.any(), createdAt: int }),
  Spectrum: R({
    band: range, gaaRanges: S.arr(range), protections: S.arr(ref('Protection')), ppas: S.arr(ref('Ppa')),
    grants: S.arr(R({
      grantId: str, cbsdId: str, state: str, suspended: bool, low: S.hz(), high: S.hz(), maxEirp: num, channelType: str, lat: nnum, lon: nnum,
    })),
    cbsds: S.arr(R({ cbsdId: str, fccId: str, serial: str, category: nstr, lat: nnum, lon: nnum, indoor: S.nullable(S.bool()) })),
    incumbents: S.obj({}, [], { additionalProperties: S.arr(R({ id: str, data: S.any() })), description: 'Injected records by kind.' }),
  }),

  // ---------------------------------------------------------------- faults and logs
  FaultRule: R({
    id: int, enabled: bool, name: nstr, method: str, matchCbsd: nstr,
    action: S.enum(['response_code', 'patch', 'http_status', 'delay', 'drop', 'malformed']),
    responseCode: nint, responseData: S.any(), responseMessage: nstr, httpStatus: nint, delayMs: nint, remaining: nint,
    hits: S.int({ description: 'Times the rule was applied.' }), createdAt: int,
  }),
  Message: R({
    id: int, ts: int, transport: str, remoteAddr: nstr, path: nstr, method: nstr, version: nstr,
    httpStatus: S.nullable(S.int({ description: '0 when the connection was dropped.' })), durationMs: nint,
    cbsdIds: strs, codes: S.arr(S.int(), { description: 'responseCode of each response object.' }), certSubject: nstr, error: nstr,
  }),
  Event: R({
    id: int, ts: int, level: S.enum(['info', 'warn', 'error', 'success']), category: str, message: str, cbsdId: nstr, grantId: nstr,
  }),
  SasExchange: R({
    transport: S.enum(['internal', 'http', 'https']), method: str, version: str,
    httpStatus: S.nullable(S.int({ description: 'Null when no HTTP response arrived (see error).' })), durationMs: int,
    body: S.any({ description: 'Parsed response body (text when it is not JSON).' }), error: S.nullable(S.str({ description: 'Transport error (connection refused, reset, timeout, TLS failure).' })),
  }),

  // ---------------------------------------------------------------- certificates
  Certificate: R({
    id: str, kind: S.enum(['root', 'sub_ca', 'server', 'cbsd', 'domain_proxy', 'installer', 'trusted', 'imported']), role: nstr, name: str,
    parentId: nstr, subject: str, issuer: str, serial: str, notBefore: int, notAfter: int, fingerprint: S.str({ description: 'SHA-256.' }),
    keyType: str, hasKey: S.bool({ description: 'The store holds the private key.' }), isCa: bool, meta: S.anyObj(), revokedAt: nint, createdAt: int,
    details: S.anyObj({ description: 'Parsed certificate: SANs, WInnForum roles and policy OIDs, FCC ID, serial number, key usage…' }),
    usage: R({ serverCertificate: S.bool({ description: 'Presented by the SAS HTTPS listener.' }), trustedClientCa: S.bool({ description: 'Selected as a trusted client CA.' }) }),
  }),
  CertificateDetail: R({
    id: str, kind: str, role: nstr, name: str, parentId: nstr, subject: str, issuer: str, serial: str, notBefore: int, notAfter: int,
    fingerprint: str, keyType: str, hasKey: bool, isCa: bool, meta: S.anyObj(), revokedAt: nint, createdAt: int, details: S.anyObj(),
    usage: R({ serverCertificate: bool, trustedClientCa: bool }),
    pem: S.str({ description: 'The certificate (PEM).' }),
    chain: S.arr(R({ id: str, name: str, kind: str }), { description: 'The certificate and its issuers up to the root.' }),
    children: S.arr(R({ id: str, name: str, kind: str }), { description: 'Certificates it issued.' }),
  }),
  Crl: R({
    id: str, name: str, issuerHash: S.str({ description: 'OpenSSL subject hash of the issuer.' }), thisUpdate: nint, nextUpdate: nint,
    revokedCount: int, revoked: S.arr(S.str(), { description: 'Revoked serial numbers (hex).' }),
  }),
  Tls: R({
    serverCertIds: strs, trustedClientCaIds: strs,
    serverCerts: S.arr(R({ id: str, name: nstr, kind: nstr, subject: nstr, notAfter: nint, revoked: bool })),
    trustedClientCas: S.arr(R({ id: str, name: nstr, kind: nstr, subject: nstr, notAfter: nint, revoked: bool })),
    clientAuth: str, minVersion: str, maxVersion: str, cipherPolicy: str, checkCrl: bool,
    listener: S.anyObj({ description: 'Live HTTPS listener state (as in Listeners.https).' }),
  }),

  // ---------------------------------------------------------------- map and terrain
  TileSet: R({
    id: str, kind: S.enum(['mbtiles', 'directory']), name: str, format: nstr, minZoom: nint, maxZoom: nint,
    bounds: S.nullable(S.arr(S.num(), { description: '[west, south, east, north]' })), attribution: nstr, sizeBytes: nint,
    usable: S.bool({ description: 'Raster tiles the console map can draw.' }), error: nstr,
  }),
  TileDownloadJob: R({
    state: S.enum(['running', 'done', 'failed', 'cancelled']), file: str, url: str, bounds: S.arr(S.num()), minZoom: int, maxZoom: int,
    total: int, done: int, missing: int, failed: int, bytes: int, startedAt: int, finishedAt: nint, error: nstr,
  }),
  MapConfig: R({
    source: str, url: str, attribution: str, maxZoom: int, darken: bool, local: S.nullable(ref('TileSet')),
    store: R({ dir: str, sets: S.arr(ref('TileSet')) }), download: S.nullable(ref('TileDownloadJob')), maxDownloadTiles: int,
  }),
  TerrainDownloadJob: R({
    state: S.enum(['running', 'done', 'failed', 'cancelled']), directory: str, source: str, force: bool, total: int, finished: int, failed: int, bytes: int,
    tiles: S.arr(R({
      name: str, status: S.enum(['queued', 'downloading', 'downloaded', 'present', 'unavailable', 'failed', 'cancelled']), bytes: nint, error: nstr,
    })),
    startedAt: int, finishedAt: nint,
  }),
  Terrain: R({
    directory: nstr, tileCount: int, files: S.arr(R({ name: str, file: str, sizeBytes: int })),
    source: S.str({ description: 'Download source (USGS or SAS_TERRAIN_SOURCE_URL).' }), download: S.nullable(ref('TerrainDownloadJob')),
  }),
  TerrainTilesNeeded: R({ tiles: strs, present: strs, missing: strs }),
};

// Composite schemas built from the ones above.
const props = (name: string) => COMPONENTS[name].properties!;
COMPONENTS.CbsdDetail = R({
  ...props('Cbsd'),
  conditional: S.nullable(S.anyObj({ description: 'Preloaded registration data for this FCC ID and serial number.' })),
  liveGrants: S.arr(ref('Grant')),
  ...props('CbsdAvailability'),
});
COMPONENTS.TokenCreated = R({ ...props('Token') });
COMPONENTS.GrantDetail = R({ ...props('Grant'), request: S.nullable(S.anyObj({ description: 'The grant request the CBSD sent.' })) });
COMPONENTS.MessageDetail = R({ ...props('Message'), request: S.any(), response: S.any() });
