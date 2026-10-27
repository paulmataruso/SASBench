import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Single SQLite database holding all SAS state. node:sqlite is synchronous,
// which keeps every protocol request handled atomically with no interleaving.

export type Row = Record<string, any>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cbsds (
  cbsd_id          TEXT PRIMARY KEY,
  fcc_id           TEXT NOT NULL,
  serial           TEXT NOT NULL,
  user_id          TEXT,
  category         TEXT,
  state            TEXT NOT NULL,           -- REGISTERED | UNREGISTERED
  registration     TEXT NOT NULL,           -- last RegistrationRequest object (JSON)
  effective        TEXT NOT NULL,           -- merged effective registration params (JSON)
  meas_capability  TEXT,
  cert_info        TEXT,                    -- client certificate summary at registration (JSON)
  cert_fingerprint TEXT,                    -- TLS identity that registered the CBSD
  approved         INTEGER NOT NULL DEFAULT 0,
  meas_required    TEXT,                    -- JSON {siq:bool, grant:bool} RECEIVED_POWER_WITHOUT_GRANT reports owed
  reg_meas_config  TEXT,                    -- measReportConfig sent in the registration response
  transport        TEXT,
  remote_addr      TEXT,
  eirp_cap_dbm_mhz REAL,                    -- per-CBSD admin EIRP cap (dBm/MHz)
  pending_deregister INTEGER NOT NULL DEFAULT 0,
  meas_report_config TEXT,                  -- pending measReportConfig to send (JSON array)
  last_meas_report TEXT,
  notes            TEXT,
  created_at       INTEGER NOT NULL,
  registered_at    INTEGER,
  updated_at       INTEGER NOT NULL,
  last_seen        INTEGER,
  last_heartbeat_ok INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS cbsds_identity ON cbsds(fcc_id, serial);

CREATE TABLE IF NOT EXISTS grants (
  grant_id             TEXT PRIMARY KEY,
  cbsd_id              TEXT NOT NULL,
  state                TEXT NOT NULL,       -- GRANTED | AUTHORIZED | TERMINATED | RELINQUISHED | EXPIRED | DELETED
  suspended            INTEGER NOT NULL DEFAULT 0,
  low_freq             INTEGER NOT NULL,
  high_freq            INTEGER NOT NULL,
  max_eirp             REAL NOT NULL,
  channel_type         TEXT NOT NULL,
  grant_expire_time    INTEGER NOT NULL,
  transmit_expire_time INTEGER,
  heartbeat_interval   INTEGER NOT NULL,
  heartbeat_count      INTEGER NOT NULL DEFAULT 0,
  last_heartbeat       INTEGER,
  pending_action       TEXT,                -- suspend | terminate | resume (admin actions applied on next heartbeat)
  pending_hb_interval  INTEGER,
  suggested_op_param   TEXT,                -- JSON OperationParam to recommend
  pending_meas_config  TEXT,
  end_reason           TEXT,
  ended_at             INTEGER,
  created_at           INTEGER NOT NULL,
  request              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS grants_cbsd ON grants(cbsd_id);

CREATE TABLE IF NOT EXISTS fcc_ids (
  fcc_id      TEXT PRIMARY KEY,
  max_eirp    REAL,                         -- dBm/10MHz certified maximum
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_ids (
  user_id     TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blacklist (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fcc_id      TEXT NOT NULL,
  serial      TEXT,                         -- NULL = whole FCC ID
  reason      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conditional_reg (
  fcc_id      TEXT NOT NULL,
  serial      TEXT NOT NULL,
  data        TEXT NOT NULL,                -- REG-Conditional parameters (JSON)
  source      TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (fcc_id, serial)
);

CREATE TABLE IF NOT EXISTS protections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,                -- DPA | ESC | FSS | EXCLUSION | ADMIN
  source      TEXT NOT NULL DEFAULT 'ui',   -- ui | ntia-e-dpa | ntia-p-dpa | harness
  low_freq    INTEGER NOT NULL,             -- protected band
  high_freq   INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 0,
  channels    TEXT,                         -- JSON [[low,high],...] active sub-channels; NULL = whole band when active
  action      TEXT NOT NULL DEFAULT 'suspend',  -- suspend | terminate
  geometry    TEXT,                         -- GeoJSON polygon(s); NULL = point/radius or band-wide
  latitude    REAL,
  longitude   REAL,
  radius_km   REAL,
  neighborhood TEXT,                        -- JSON neighbourhood distances (km) by CBSD class
  notes       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ppas (
  id          TEXT PRIMARY KEY,             -- zone id
  name        TEXT NOT NULL,
  channels    TEXT NOT NULL,                -- JSON [{low, high, palId, licenseExpiration}]
  members     TEXT NOT NULL DEFAULT '[]',   -- JSON array of cbsdIds (cluster list)
  geometry    TEXT,                         -- GeoJSON; NULL = applies to members anywhere
  expiration  INTEGER,
  source      TEXT NOT NULL DEFAULT 'ui',
  data        TEXT,                         -- original zone record (harness)
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS harness_data (
  kind        TEXT NOT NULL,                -- pal | fss | wisp | esc_sensor | peer_sas | fad_cbsd | exclusion_zone | ...
  id          TEXT NOT NULL,
  data        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);

CREATE TABLE IF NOT EXISTS cpi_users (
  cpi_id      TEXT PRIMARY KEY,
  name        TEXT,
  public_key  TEXT NOT NULL,                -- SubjectPublicKeyInfo PEM
  source      TEXT NOT NULL DEFAULT 'ui',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS crls (
  id          TEXT PRIMARY KEY,
  issuer      TEXT NOT NULL,                -- issuer DN (one line)
  crl_pem     TEXT NOT NULL,
  this_update INTEGER,
  next_update INTEGER,
  revoked     TEXT NOT NULL DEFAULT '[]',   -- JSON array of revoked serials (upper-case hex)
  name        TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fault_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  name        TEXT,
  method      TEXT NOT NULL DEFAULT '*',    -- registration | grant | heartbeat | ... | *
  match_cbsd  TEXT,                         -- cbsdId / fccId / serial substring, NULL = any
  action      TEXT NOT NULL,                -- response_code | http_status | delay | drop | malformed
  response_code INTEGER,
  response_data TEXT,
  response_message TEXT,
  http_status INTEGER,
  delay_ms    INTEGER,
  remaining   INTEGER,                      -- NULL = unlimited
  hits        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS certs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                -- root | sub_ca | server | cbsd | domain_proxy | installer | trusted | imported
  role        TEXT,
  name        TEXT NOT NULL,
  parent_id   TEXT,
  subject     TEXT,
  issuer      TEXT,
  serial      TEXT,
  not_before  INTEGER,
  not_after   INTEGER,
  fingerprint TEXT,
  key_type    TEXT,
  cert_pem    TEXT NOT NULL,
  key_pem     TEXT,
  meta        TEXT,
  revoked_at  INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS msg_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  transport   TEXT NOT NULL,
  remote_addr TEXT,
  path        TEXT,
  method      TEXT,
  version     TEXT,
  http_status INTEGER,
  duration_ms INTEGER,
  cbsd_ids    TEXT,
  codes       TEXT,
  cert_subject TEXT,
  request     TEXT,
  response    TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS msg_log_ts ON msg_log(ts);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  level       TEXT NOT NULL,
  category    TEXT NOT NULL,
  message     TEXT NOT NULL,
  cbsd_id     TEXT,
  grant_id    TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS api_tokens (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  scope       TEXT NOT NULL,                -- read | write
  token_hash  TEXT NOT NULL UNIQUE,         -- SHA-256 of the secret; the secret itself is never stored
  prefix      TEXT NOT NULL,                -- first characters of the secret, to recognise it
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  last_used_at INTEGER,
  last_used_addr TEXT
);
`;

export class Db {
  readonly sql: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.sql = new DatabaseSync(file);
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.sql.exec(SCHEMA);
  }

  all(q: string, ...p: any[]): Row[] {
    return this.sql.prepare(q).all(...p) as Row[];
  }
  get(q: string, ...p: any[]): Row | undefined {
    return this.sql.prepare(q).get(...p) as Row | undefined;
  }
  run(q: string, ...p: any[]) {
    return this.sql.prepare(q).run(...p);
  }

  tx<T>(fn: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.sql.exec('COMMIT');
      return out;
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
  }
}

export function jparse<T = any>(s: string | null | undefined, fallback: T): T {
  if (s == null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
