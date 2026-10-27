import type { Db, Row } from '../../../db.ts';
import type { QuerySpec, ResponseSpec } from '../http.ts';
import { S, ref, toMs, type Schema } from '../schema.ts';

// Building blocks shared by the route modules.

export const pageQuery = (def = 500, max = 5000): Record<string, QuerySpec> => ({
  limit: { description: `Maximum number of items to return (1–${max}).`, schema: S.int({ minimum: 1, maximum: max, default: def }) },
  offset: { description: 'Number of items to skip.', schema: S.int({ minimum: 0, default: 0 }) },
});

/** Logs are paged by id: newest first with `before`, oldest first with `after`. */
export const cursorQuery = (def = 100, max = 1000): Record<string, QuerySpec> => ({
  limit: { description: `Maximum number of items to return (1–${max}).`, schema: S.int({ minimum: 1, maximum: max, default: def }) },
  before: { description: 'Only items whose id is lower than this. Pass the previous page\'s `next` to page backwards.', schema: S.int({ minimum: 1 }) },
  after: { description: 'Only items whose id is higher than this, oldest first. Pass the previous page\'s `next` to page forwards (polling).', schema: S.int({ minimum: 0 }) },
  since: { description: 'Only items at or after this time (epoch milliseconds or RFC 3339).', schema: S.time() },
  until: { description: 'Only items before this time (epoch milliseconds or RFC 3339).', schema: S.time() },
});

export const pageOf = (item: string): Schema => S.obj({
  items: S.arr(ref(item)),
  total: S.int({ description: 'Number of items matching the filters, before limit and offset.' }),
  limit: S.int(),
  offset: S.int(),
}, ['items', 'total', 'limit', 'offset']);

export const cursorOf = (item: string): Schema => S.obj({
  items: S.arr(ref(item)),
  limit: S.int(),
  order: S.enum(['desc', 'asc'], { description: '`desc` (newest first) unless `after` was given.' }),
  next: S.nullable(S.int({ description: 'Cursor for the next page. Newest first (desc): pass it as `before`; null when this page is the last. Oldest first (asc, polling): pass it as `after` next time; it is never null.' })),
}, ['items', 'limit', 'order', 'next']);

export const ok = (description: string, schema?: Schema): Record<number, ResponseSpec> => ({ 200: { description, schema } });
export const okRef = (description: string, name: string) => ok(description, ref(name));
export const createdRef = (description: string, name: string): Record<number, ResponseSpec> => ({ 201: { description, schema: ref(name) } });
export const noContentResp = (description = 'Done. No content.'): Record<number, ResponseSpec> => ({ 204: { description } });
export const fileResp = (description: string, contentType: string): Record<number, ResponseSpec> => ({ 200: { description, contentType } });

/** WHERE clause builder. */
export class Where {
  parts: string[] = [];
  params: any[] = [];
  add(cond: string, ...vals: any[]) {
    this.parts.push(cond);
    this.params.push(...vals);
    return this;
  }
  get sql() {
    return this.parts.length ? `WHERE ${this.parts.join(' AND ')}` : '';
  }
}

/** Id-cursor paging over a table with an INTEGER id and ts column. */
export function cursorPage(db: Db, table: string, w: Where, q: Record<string, any>, map: (r: Row) => unknown, columns = '*') {
  if (q.before !== undefined) w.add('id < ?', q.before);
  if (q.after !== undefined) w.add('id > ?', q.after);
  if (q.since !== undefined) w.add('ts >= ?', toMs(q.since));
  if (q.until !== undefined) w.add('ts < ?', toMs(q.until));
  const asc = q.after !== undefined;
  const rows = db.all(`SELECT ${columns} FROM ${table} ${w.sql} ORDER BY id ${asc ? 'ASC' : 'DESC'} LIMIT ?`, ...w.params, q.limit + 1);
  const more = rows.length > q.limit;
  const items = rows.slice(0, q.limit);
  // Polling (asc) always returns a cursor: the last id seen, or the one given when nothing is new.
  const next = asc ? (items.length ? items[items.length - 1].id : q.after) : more ? items[items.length - 1].id : null;
  return { items: items.map(map), limit: q.limit, order: asc ? 'asc' : 'desc', next };
}

/** LIMIT/OFFSET paging with a total count. */
export function sqlPage(db: Db, from: string, w: Where, order: string, q: Record<string, any>, map: (r: Row) => unknown, columns = '*') {
  const total = db.get(`SELECT COUNT(*) AS n FROM ${from} ${w.sql}`, ...w.params)?.n ?? 0;
  const rows = db.all(`SELECT ${columns} FROM ${from} ${w.sql} ORDER BY ${order} LIMIT ? OFFSET ?`, ...w.params, q.limit, q.offset);
  return { items: rows.map(map), total, limit: q.limit, offset: q.offset };
}

/** Escape LIKE wildcards; use with ESCAPE '\'. */
export const esc = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
export const like = (s: string) => `%${esc(s)}%`;
/** Rows whose comma-separated list column contains this exact value. */
export const inList = (w: Where, column: string, value: string) => w.add(`',' || ${column} || ',' LIKE ? ESCAPE '\\'`, `%,${esc(value)},%`);
