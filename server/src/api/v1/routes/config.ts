import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Row } from '../../../db.ts';
import { redact } from '../../../api.ts';
import type { Settings } from '../../../settings.ts';
import type { Route, V1Deps } from '../http.ts';
import { invalid, sendFile } from '../http.ts';
import { S, validate } from '../schema.ts';
import { COMPONENTS } from '../components.ts';
import { SETTINGS_META } from '../settingsMeta.ts';
import { fileResp, ok } from './common.ts';
import { applySettings, checkSettings } from './settings.ts';

// Configuration export/import (the console's Backup page) and a full SQLite backup.

/** Export section → table. Same file format as the console's export. */
const SECTIONS: Array<[string, string]> = [
  ['fccIds', 'fcc_ids'], ['userIds', 'user_ids'], ['blacklist', 'blacklist'], ['conditional', 'conditional_reg'],
  ['cpiUsers', 'cpi_users'], ['protections', 'protections'], ['ppas', 'ppas'], ['faults', 'fault_rules'],
];

/** Settings an import never changes: they depend on this installation's certificates and password. */
const LOCAL_SETTINGS = ['uiPassword', 'serverCertIds', 'trustedClientCaIds'];

function exportDump(d: V1Deps) {
  const db = d.db;
  return {
    exportedAt: new Date().toISOString(), version: d.version, settings: redact(d.settings.get()),
    fccIds: db.all('SELECT * FROM fcc_ids'), userIds: db.all('SELECT * FROM user_ids'), blacklist: db.all('SELECT * FROM blacklist'),
    conditional: db.all('SELECT * FROM conditional_reg'), cpiUsers: db.all('SELECT * FROM cpi_users'),
    protections: db.all("SELECT * FROM protections WHERE source = 'ui'"), ppas: db.all("SELECT * FROM ppas WHERE source != 'harness'"),
    faults: db.all('SELECT * FROM fault_rules'),
  };
}

export const configRoutes: Route[] = [
  {
    method: 'GET', path: '/config/export', operationId: 'exportConfig', tag: 'Configuration', scope: 'read',
    summary: 'Export the configuration',
    description: 'Settings (password redacted), registry (FCC IDs, user IDs, blacklist, conditional registrations, CPI users), operator protections and PPAs, and fault rules, as one JSON document, the same file the console\'s Backup page saves. Certificates, CBSDs, grants and logs are not included: use GET /system/backup for everything.',
    query: { download: { description: 'Send as a file attachment.', schema: S.bool({ default: false }) } },
    responses: ok('The configuration.', S.anyObj()),
    handler: (c) => {
      const dump = exportDump(c.d);
      if (!c.query.download) return dump;
      return sendFile(c, JSON.stringify(dump, null, 2), 'application/json', `sas-config-${new Date().toISOString().slice(0, 10)}.json`);
    },
  },
  {
    method: 'POST', path: '/config/import', operationId: 'importConfig', tag: 'Configuration', scope: 'write',
    summary: 'Import a configuration',
    description: 'Takes a document from GET /config/export (or the console). Settings are validated and applied, except the UI password, server certificates and trusted CAs, which stay as they are on this installation; unknown settings are skipped and listed. Rows are inserted or replaced by primary key; nothing is deleted.',
    body: {
      required: true,
      schema: S.obj({
        exportedAt: S.str(), version: S.str(), settings: S.anyObj(),
        ...Object.fromEntries(SECTIONS.map(([k]) => [k, S.arr(S.anyObj())])),
      }),
      example: { settings: { heartbeatIntervalSec: 60 }, fccIds: [{ fcc_id: 'TEST-FCC', max_eirp: 47, created_at: 1767225600000 }] },
    },
    responses: ok('What was imported.', S.obj({
      settingsChanged: S.arr(S.str()), settingsSkipped: S.arr(S.str()), rows: S.anyObj(), listenersRestarted: S.bool(),
    }, ['settingsChanged', 'settingsSkipped', 'rows', 'listenersRestarted'])),
    handler: async ({ d, body }) => {
      // Validate everything before changing anything.
      const patch: Record<string, unknown> = {};
      const skipped: string[] = [];
      for (const [k, v] of Object.entries(body.settings ?? {})) {
        if (LOCAL_SETTINGS.includes(k)) continue;
        const meta = Object.hasOwn(SETTINGS_META, k) ? (SETTINGS_META as Record<string, { schema: any }>)[k] : null;
        if (!meta) {
          skipped.push(k);
          continue;
        }
        const issues = validate(meta.schema, v, COMPONENTS, `settings.${k}`);
        if (issues.length) throw invalid(issues[0].path, issues[0].message);
        patch[k] = v;
      }
      const columns = new Map<string, Set<string>>();
      for (const [key, table] of SECTIONS) {
        const cols = new Set(d.db.all(`PRAGMA table_info(${table})`).map((r) => String(r.name)));
        columns.set(table, cols);
        (body[key] ?? []).forEach((row: Row, i: number) => {
          for (const col of Object.keys(row)) if (!cols.has(col)) throw invalid(`${key}[${i}].${col}`, `is not a column of ${table}`);
          if (!Object.keys(row).length) throw invalid(`${key}[${i}]`, 'is empty');
        });
      }
      checkSettings(d, patch as Partial<Settings>);

      // Rows first, in one transaction: if one is refused (e.g. a missing NOT NULL column), nothing
      // has changed. The settings were checked above, so applying them afterwards does not fail.
      const rows: Record<string, number> = {};
      d.db.tx(() => {
        for (const [key, table] of SECTIONS) {
          rows[key] = 0;
          for (const row of (body[key] ?? []) as Row[]) {
            const keys = Object.keys(row);
            d.db.run(`INSERT OR REPLACE INTO ${table}(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
              ...keys.map((k) => (row[k] !== null && typeof row[k] === 'object' ? JSON.stringify(row[k]) : row[k])));
            rows[key]++;
          }
        }
      });
      const applied = Object.keys(patch).length ? await applySettings(d, patch as Partial<Settings>, 'Settings imported') : null;
      d.bus.event('info', 'admin', 'Configuration imported');
      d.bus.changed('all');
      return { settingsChanged: applied?.changed ?? [], settingsSkipped: skipped, rows, listenersRestarted: applied?.listenersRestarted ?? false };
    },
  },
  {
    method: 'GET', path: '/system/backup', operationId: 'downloadBackup', tag: 'Configuration', scope: 'write',
    summary: 'Download a database backup',
    description: 'A consistent copy of the whole SQLite database (VACUUM INTO): settings, certificates and private keys, CBSDs, grants, registry, spectrum data, fault rules, logs and API token hashes. To restore, stop the SAS and replace sas.db in the data directory. Needs write access because it contains private keys.',
    responses: fileResp('SQLite database.', 'application/vnd.sqlite3'),
    handler: (c) => {
      const tmp = path.join(c.d.dataDir, `.backup-${crypto.randomUUID()}.db`);
      try {
        c.d.db.run('VACUUM INTO ?', tmp);
        const data = fs.readFileSync(tmp);
        c.d.bus.event('info', 'admin', `Database backup downloaded (${data.length} bytes)`);
        return sendFile(c, data, 'application/vnd.sqlite3', `sasbench-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    },
  },
];
