import type { Row } from '../../../db.ts';
import type { Route, V1Deps } from '../http.ts';
import { badRequest, notFound } from '../http.ts';
import { S } from '../schema.ts';
import { Where, ok, pageQuery } from './common.ts';

// Read-only access to every database table, for data the typed endpoints do not cover and for
// debugging. Secrets are always redacted here: private keys, the UI password and token hashes.

const REDACTED = '[redacted]';

/** Columns whose values are never returned by the table browser. */
const SECRET: Record<string, (r: Row) => Row> = {
  certs: (r) => ('key_pem' in r && r.key_pem != null ? { ...r, key_pem: REDACTED } : r),
  settings: (r) => (r.key === 'uiPassword' && r.value && r.value !== '""' ? { ...r, value: REDACTED } : r),
  api_tokens: (r) => ('token_hash' in r ? { ...r, token_hash: REDACTED } : r),
};

/** Columns that cannot be filtered or sorted on (a LIKE filter would reveal their content). */
const SECRET_COLUMNS: Record<string, string[]> = { certs: ['key_pem'], settings: ['value'], api_tokens: ['token_hash'] };

const tables = (d: V1Deps): string[] =>
  d.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => String(r.name));

function columnsOf(d: V1Deps, table: string) {
  if (!tables(d).includes(table)) throw notFound('Table');
  return d.db.all(`PRAGMA table_info("${table}")`).map((c) => ({
    name: String(c.name), type: String(c.type), notNull: !!c.notnull, primaryKey: Number(c.pk) > 0, default: c.dflt_value ?? null,
  }));
}

const tableParam = { table: { description: 'Table name (see GET /data/tables).', schema: S.str({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }) } };

export const dataRoutes: Route[] = [
  {
    method: 'GET', path: '/data/tables', operationId: 'listTables', tag: 'Data', scope: 'read',
    summary: 'List database tables', description: 'Every table with its row count and columns.',
    responses: ok('Tables.', S.obj({
      items: S.arr(S.obj({ name: S.str(), rows: S.int(), columns: S.arr(S.str()) }, ['name', 'rows', 'columns'])),
    }, ['items'])),
    handler: ({ d }) => ({
      items: tables(d).map((name) => ({
        name, rows: d.db.get(`SELECT COUNT(*) AS n FROM "${name}"`)?.n ?? 0, columns: columnsOf(d, name).map((c) => c.name),
      })),
    }),
  },
  {
    method: 'GET', path: '/data/tables/{table}', operationId: 'getTable', tag: 'Data', scope: 'read',
    summary: 'Describe a table', description: 'Columns (type, NOT NULL, primary key, default), indexes, row count and the CREATE statement.',
    params: tableParam,
    responses: ok('Table description.', S.obj({
      name: S.str(), rows: S.int(), sql: S.str(), columns: S.arr(S.anyObj()), indexes: S.arr(S.obj({ name: S.str(), unique: S.bool(), columns: S.arr(S.str()) }, ['name', 'unique', 'columns'])),
    }, ['name', 'rows', 'sql', 'columns', 'indexes'])),
    handler: ({ d, params }) => {
      const columns = columnsOf(d, params.table);
      return {
        name: params.table, rows: d.db.get(`SELECT COUNT(*) AS n FROM "${params.table}"`)?.n ?? 0,
        sql: d.db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", params.table)?.sql ?? '',
        columns,
        indexes: d.db.all(`PRAGMA index_list("${params.table}")`).map((i) => ({
          name: String(i.name), unique: !!i.unique, columns: d.db.all(`PRAGMA index_info("${String(i.name).replace(/"/g, '""')}")`).map((c) => String(c.name)),
        })),
      };
    },
  },
  {
    method: 'GET', path: '/data/tables/{table}/rows', operationId: 'listTableRows', tag: 'Data', scope: 'read',
    summary: 'Read table rows',
    description: 'Raw rows (snake_case columns, JSON stored as text, timestamps in epoch milliseconds). Filter on one column with `column` and `value` (exact match) or `like` (substring). Private keys, the UI password and token hashes read as "[redacted]". The rows of api_tokens need write access, like GET /tokens.',
    params: tableParam,
    query: {
      column: { description: 'Column to filter on.', schema: S.str() },
      value: { description: 'With column: exact value.', schema: S.str() },
      like: { description: 'With column: substring.', schema: S.str() },
      isNull: { description: 'With column: only rows where it is (or is not) NULL.', schema: S.bool() },
      order: { description: 'Column to sort by (default: rowid).', schema: S.str() },
      desc: { description: 'Sort descending.', schema: S.bool({ default: false }) },
      ...pageQuery(100, 5000),
    },
    responses: ok('A page of rows.', S.obj({
      items: S.arr(S.anyObj()), total: S.int(), limit: S.int(), offset: S.int(), columns: S.arr(S.str()),
    }, ['items', 'total', 'limit', 'offset', 'columns'])),
    handler: ({ d, params, query, requireWrite }) => {
      // Token names, prefixes and client addresses are for token managers only (as GET /tokens).
      if (params.table === 'api_tokens') requireWrite('Reading the api_tokens table');
      const cols = columnsOf(d, params.table).map((c) => c.name);
      const known = (k: string, name: string) => {
        if (!cols.includes(name)) throw badRequest(`${k}: ${params.table} has no column ${name}`);
        if (SECRET_COLUMNS[params.table]?.includes(name)) throw badRequest(`${k}: ${params.table}.${name} cannot be filtered or sorted on`);
        return `"${name}"`;
      };
      const w = new Where();
      const filters = ['value', 'like', 'isNull'].filter((k) => query[k] !== undefined);
      if (filters.length && !query.column) throw badRequest('value, like and isNull need column');
      if (query.column) {
        const c = known('column', query.column);
        if (query.value !== undefined) w.add(`CAST(${c} AS TEXT) = ?`, query.value);
        if (query.like !== undefined) w.add(`CAST(${c} AS TEXT) LIKE ? ESCAPE '\\'`, `%${query.like.replace(/[\\%_]/g, (m: string) => '\\' + m)}%`);
        if (query.isNull !== undefined) w.add(`${c} IS ${query.isNull ? '' : 'NOT '}NULL`);
      }
      const order = query.order ? known('order', query.order) : 'rowid';
      const total = d.db.get(`SELECT COUNT(*) AS n FROM "${params.table}" ${w.sql}`, ...w.params)?.n ?? 0;
      const rows = d.db.all(`SELECT * FROM "${params.table}" ${w.sql} ORDER BY ${order} ${query.desc ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?`, ...w.params, query.limit, query.offset);
      const scrub = SECRET[params.table] ?? ((r: Row) => r);
      return { items: rows.map(scrub), total, limit: query.limit, offset: query.offset, columns: cols };
    },
  },
];
