// Shapes returned by the server REST API (server/src/api.ts).

export type GrantState = 'GRANTED' | 'AUTHORIZED' | 'TERMINATED' | 'RELINQUISHED' | 'EXPIRED' | 'DELETED';

export interface Listeners {
  http: { enabled: boolean; listening: boolean; port: number; error: string | null };
  https: {
    enabled: boolean; listening: boolean; port: number; error: string | null; clientAuth: string;
    serverCerts: string[]; trustAnchors: number; ciphers: string; protocols: string;
  };
}

export interface Status {
  version: string;
  startedAt: number;
  now: number;
  hostname: string;
  listeners: Listeners;
  urls: string[];
  counts: {
    cbsdsRegistered: number; cbsdsPending: number; cbsdsTotal: number; grantsByState: Record<string, number>;
    authorizedMHz: number; messagesLastHour: number; errorsLastHour: number; activeProtections: number; ppas: number; faultRules: number;
  };
  triggers: { measInRegistration: boolean; measInHeartbeat: boolean };
  daily: { completed: boolean; startedAt?: number; finishedAt?: number; error?: string | null; [k: string]: any };
  flags: Record<string, any>;
  terrain: { directory: string | null; tiles: number };
  profile: string | null;
}

export interface Cbsd {
  cbsdId: string;
  fccId: string;
  serial: string;
  userId: string | null;
  category: 'A' | 'B' | string | null;
  state: 'REGISTERED' | 'UNREGISTERED' | 'PENDING' | string;
  callSign: string | null;
  radioTechnology: string | null;
  latitude: number | null;
  longitude: number | null;
  height: number | null;
  heightType: string | null;
  indoor: boolean | null;
  eirpCapability: number | null;
  antennaGain: number | null;
  measCapability: string[];
  registration: any;
  effective: any;
  certInfo: any;
  approved: boolean;
  transport: string | null;
  remoteAddr: string | null;
  eirpCapDbmMhz: number | null;
  pendingDeregister: boolean;
  notes: string | null;
  regMeasConfig: string[];
  hbMeasConfig: string[];
  measRequired: any;
  lastMeasReport: any;
  createdAt: number;
  registeredAt: number | null;
  updatedAt: number;
  lastSeen: number | null;
  lastHeartbeatOk: number | null;
  grants: Record<string, number>;
}

export interface Grant {
  grantId: string;
  cbsdId: string;
  fccId?: string;
  serial?: string;
  category?: string;
  state: GrantState;
  suspended: boolean;
  low: number;
  high: number;
  maxEirp: number;
  channelType: 'GAA' | 'PAL' | string;
  grantExpireTime: number;
  transmitExpireTime: number | null;
  heartbeatInterval: number;
  heartbeatCount: number;
  lastHeartbeat: number | null;
  pendingHeartbeatInterval: number | null;
  suggestedOperationParam: { maxEirp: number; operationFrequencyRange: { lowFrequency: number; highFrequency: number } } | null;
  endReason: string | null;
  endedAt: number | null;
  createdAt: number;
}

export interface EventRow {
  id: number;
  ts: number;
  level: 'info' | 'warn' | 'error' | 'success';
  category: string;
  message: string;
  cbsd_id?: string | null;
  grant_id?: string | null;
  cbsdId?: string | null;
  grantId?: string | null;
}

export interface MessageRow {
  id: number;
  ts: number;
  transport: string;
  remote_addr?: string | null;
  remoteAddr?: string | null;
  path?: string | null;
  method?: string | null;
  version?: string | null;
  http_status?: number | null;
  httpStatus?: number | null;
  duration_ms?: number | null;
  durationMs?: number | null;
  cbsd_ids?: string | null;
  cbsdIds?: string[];
  codes?: string | number[] | null;
  cert_subject?: string | null;
  certSubject?: string | null;
  error?: string | null;
  request?: any;
  response?: any;
}

export interface Protection {
  id: string;
  name: string;
  kind: string;
  source: string;
  low: number;
  high: number;
  active: boolean;
  channels: number[][] | null;
  action: 'suspend' | 'terminate';
  geometry: any;
  latitude: number | null;
  longitude: number | null;
  radiusKm: number | null;
  neighborhood: any;
  notes: string | null;
  updatedAt: number;
}

export interface Ppa {
  id: string;
  name: string;
  channels: Array<{ low: number; high: number; palId: string | null; licenseExpiration: string | null }>;
  members: string[];
  geometry: any;
  expiration: number | null;
  source: string;
}

export interface CertRecord {
  id: string;
  kind: 'root' | 'sub_ca' | 'server' | 'cbsd' | 'domain_proxy' | 'installer' | 'trusted' | 'imported';
  role: string | null;
  name: string;
  parentId: string | null;
  subject: string;
  issuer: string;
  serial: string;
  notBefore: number;
  notAfter: number;
  fingerprint: string;
  keyType: string;
  hasKey: boolean;
  isCa: boolean;
  meta: Record<string, any>;
  revokedAt: number | null;
  createdAt: number;
  details: {
    subject: string; issuer: string; commonName: string | null; serial: string; notBefore: number; notAfter: number;
    fingerprint256: string; keyType: string; isCa: boolean; selfSigned: boolean; subjectAltName: string | null;
    roles: string[]; policies: string[]; fccId: string | null; cbsdSerial: string | null; cpiId: string | null; frn: string | null;
  };
}

export interface CrlRow {
  id: string;
  name: string;
  issuerHash: string;
  thisUpdate: number | null;
  nextUpdate: number | null;
  revoked: string[];
  revokedCount: number;
}

export interface FaultRule {
  id: number;
  enabled: boolean;
  name: string | null;
  method: string;
  match_cbsd: string | null;
  action: 'response_code' | 'patch' | 'http_status' | 'delay' | 'drop' | 'malformed';
  response_code: number | null;
  response_data: any;
  response_message: string | null;
  http_status: number | null;
  delay_ms: number | null;
  remaining: number | null;
  hits: number;
  created_at: number;
}

export interface Preset {
  label: string;
  description: string;
  patch: Record<string, any>;
}
