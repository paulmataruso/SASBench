import { SAS_METHODS } from '../../../sas/engine.ts';
import type { Ctx, Route, V1Deps } from '../http.ts';
import { SENT, noContent, notFound } from '../http.ts';
import { S, toMs } from '../schema.ts';
import { eventOut, messageDetailOut, messageOut } from '../mappers.ts';
import { Where, cursorOf, cursorPage, cursorQuery, fileResp, inList, like, noContentResp, ok, okRef } from './common.ts';

// The wire log (every SAS–CBSD exchange), the event log (audit trail) and the live event stream.

const MSG_COLS = 'id, ts, transport, remote_addr, path, method, version, http_status, duration_ms, cbsd_ids, codes, cert_subject, error';
const LEVELS = ['info', 'warn', 'error', 'success'];
const STREAM_TYPES = ['event', 'message', 'changed'];
// Keep-alive comment interval; credentials are re-checked at each ping. The override is for tests.
const STREAM_PING_MS = Number(process.env.SAS_API_STREAM_PING_MS) || 15_000;
const STREAM_MAX_BUFFERED = 4 * 1024 * 1024;

/** The bus leaves absent fields out; the stream sends the same objects as GET /events and GET /messages. */
const STREAM_SHAPE: Record<string, (x: any) => unknown> = {
  event: (e) => ({ id: e.id, ts: e.ts, level: e.level, category: e.category, message: e.message, cbsdId: e.cbsdId ?? null, grantId: e.grantId ?? null }),
  message: (m) => ({
    id: m.id, ts: m.ts, transport: m.transport, remoteAddr: m.remoteAddr ?? null, path: m.path ?? null, method: m.method ?? null,
    version: m.version ?? null, httpStatus: m.httpStatus ?? null, durationMs: m.durationMs ?? null, cbsdIds: m.cbsdIds ?? [],
    codes: m.codes ?? [], certSubject: m.certSubject ?? null, error: m.error ?? null,
  }),
};

function messageFilter(q: Record<string, any>): Where {
  const w = new Where();
  if (q.method) w.add('method = ?', q.method);
  if (q.transport) w.add('transport = ?', q.transport);
  if (q.cbsdId) inList(w, 'cbsd_ids', q.cbsdId);
  if (q.code !== undefined) inList(w, 'codes', String(q.code));
  if (q.httpStatus !== undefined) w.add('http_status = ?', q.httpStatus);
  if (q.remoteAddr) w.add('remote_addr = ?', q.remoteAddr);
  if (q.errors) w.add("(error IS NOT NULL OR http_status >= 400 OR (codes IS NOT NULL AND codes GLOB '*[1-9]*'))");
  if (q.q) w.add("(request LIKE ? ESCAPE '\\' OR response LIKE ? ESCAPE '\\' OR error LIKE ? ESCAPE '\\' OR remote_addr LIKE ? ESCAPE '\\')", ...Array(4).fill(like(q.q)));
  return w;
}

const messageQuery = {
  method: { description: 'Only this SAS method.', schema: S.enum(SAS_METHODS) },
  transport: { description: 'Only this transport: https, http or internal (console and API requests).', schema: S.enum(['https', 'http', 'internal']) },
  cbsdId: { description: 'Only exchanges that mention this cbsdId.', schema: S.str() },
  code: { description: 'Only exchanges where some response object has this responseCode.', schema: S.int({ minimum: 0 }) },
  httpStatus: { description: 'Only exchanges answered with this HTTP status (0: connection dropped).', schema: S.int({ minimum: 0 }) },
  remoteAddr: { description: 'Only exchanges from this client address.', schema: S.str() },
  errors: { description: 'Only failures: a transport error, HTTP status ≥ 400 or a non-zero responseCode.', schema: S.bool() },
  q: { description: 'Text search in the request, response, error and client address.', schema: S.str({ minLength: 1 }) },
};

function eventFilter(q: Record<string, any>): Where {
  const w = new Where();
  if (q.level?.length) w.add(`level IN (${q.level.map(() => '?').join(',')})`, ...q.level);
  if (q.category) w.add('category = ?', q.category);
  if (q.cbsdId) w.add('cbsd_id = ?', q.cbsdId);
  if (q.grantId) w.add('grant_id = ?', q.grantId);
  if (q.q) w.add("message LIKE ? ESCAPE '\\'", like(q.q));
  return w;
}

const eventQuery = {
  level: { description: 'Comma-separated levels.', schema: S.arr(S.enum(LEVELS)) },
  category: { description: 'Only this category, e.g. registration, grant, heartbeat, admin, fault, tls, api, auth.', schema: S.str() },
  cbsdId: { description: 'Only events about this CBSD.', schema: S.str() },
  grantId: { description: 'Only events about this grant.', schema: S.str() },
  q: { description: 'Text search in the message.', schema: S.str({ minLength: 1 }) },
};

/** Oldest-first export of a log, filtered like the list, capped at `limit` rows (newest kept). */
function exportRows(d: V1Deps, table: string, w: Where, q: Record<string, any>) {
  if (q.since !== undefined) w.add('ts >= ?', toMs(q.since));
  if (q.until !== undefined) w.add('ts < ?', toMs(q.until));
  return d.db.all(`SELECT * FROM ${table} ${w.sql} ORDER BY id DESC LIMIT ?`, ...w.params, q.limit).reverse();
}

const exportQuery = (def: number) => ({
  since: { description: 'Only items at or after this time (epoch milliseconds or RFC 3339).', schema: S.time() },
  until: { description: 'Only items before this time.', schema: S.time() },
  limit: { description: 'Maximum rows (the newest are kept).', schema: S.int({ minimum: 1, maximum: 1000000, default: def }) },
  format: { description: 'ndjson (one JSON object per line) or json (an array).', schema: S.enum(['ndjson', 'json'], { default: 'ndjson' }) },
});

function sendExport(c: Ctx, name: string, items: unknown[]) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (c.query.format === 'json') return sendJsonFile(c, items, `${name}-${stamp}.json`);
  const text = items.map((x) => JSON.stringify(x)).join('\n') + (items.length ? '\n' : '');
  c.res.writeHead(200, {
    'Content-Type': 'application/x-ndjson', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${name}-${stamp}.ndjson"`,
  });
  c.res.end(c.head ? undefined : text);
  return SENT;
}

function sendJsonFile(c: Ctx, body: unknown, filename: string) {
  const text = JSON.stringify(body);
  c.res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  c.res.end(c.head ? undefined : text);
  return SENT;
}

export const logRoutes: Route[] = [
  // ---------------------------------------------------------------- wire log
  {
    method: 'GET', path: '/messages', operationId: 'listMessages', tag: 'Logs', scope: 'read',
    summary: 'List wire-log exchanges',
    description: 'Every SAS–CBSD exchange (HTTPS, HTTP and internal), newest first, without the request and response bodies. Page backwards with `before`, or poll for new exchanges with `after`.',
    query: { ...messageQuery, ...cursorQuery() },
    responses: ok('A page of exchanges.', cursorOf('Message')),
    handler: ({ d, query }) => cursorPage(d.db, 'msg_log', messageFilter(query), query, messageOut, MSG_COLS),
  },
  {
    method: 'DELETE', path: '/messages', operationId: 'clearMessages', tag: 'Logs', scope: 'write',
    summary: 'Clear the wire log',
    responses: ok('How many were deleted.', S.obj({ deleted: S.int() }, ['deleted'])),
    handler: ({ d }) => {
      const n = d.db.run('DELETE FROM msg_log').changes;
      d.bus.changed('messages');
      return { deleted: Number(n) };
    },
  },
  {
    method: 'GET', path: '/messages/export', operationId: 'exportMessages', tag: 'Logs', scope: 'read',
    summary: 'Export the wire log',
    description: 'Full exchanges including request and response JSON, oldest first. Accepts the same filters as the list.',
    query: { ...messageQuery, ...exportQuery(20000) },
    responses: fileResp('NDJSON or JSON file.', 'application/x-ndjson'),
    handler: (c) => sendExport(c, 'sas-messages', exportRows(c.d, 'msg_log', messageFilter(c.query), c.query).map(messageDetailOut)),
  },
  {
    method: 'GET', path: '/messages/{id}', operationId: 'getMessage', tag: 'Logs', scope: 'read',
    summary: 'Get a wire-log exchange', description: 'With the parsed request and response bodies (bodies over 512 KiB are truncated and returned as text).',
    params: { id: { description: 'Message id.', schema: S.int({ minimum: 1 }) } },
    responses: okRef('The exchange.', 'MessageDetail'),
    handler: ({ d, params }) => {
      const m = d.db.get('SELECT * FROM msg_log WHERE id = ?', Number(params.id));
      if (!m) throw notFound('Message');
      return messageDetailOut(m);
    },
  },
  {
    method: 'DELETE', path: '/messages/{id}', operationId: 'deleteMessage', tag: 'Logs', scope: 'write',
    summary: 'Delete a wire-log exchange',
    params: { id: { description: 'Message id.', schema: S.int({ minimum: 1 }) } },
    responses: noContentResp('Deleted.'),
    handler: ({ d, params }) => {
      if (!d.db.run('DELETE FROM msg_log WHERE id = ?', Number(params.id)).changes) throw notFound('Message');
      d.bus.changed('messages');
      return noContent();
    },
  },

  // ---------------------------------------------------------------- events
  {
    method: 'GET', path: '/events', operationId: 'listEvents', tag: 'Logs', scope: 'read',
    summary: 'List events', description: 'The audit trail: registrations, grants, state changes, administrator actions, faults, TLS problems. Newest first.',
    query: { ...eventQuery, ...cursorQuery() },
    responses: ok('A page of events.', cursorOf('Event')),
    handler: ({ d, query }) => cursorPage(d.db, 'events', eventFilter(query), query, eventOut),
  },
  {
    method: 'DELETE', path: '/events', operationId: 'clearEvents', tag: 'Logs', scope: 'write',
    summary: 'Clear the event log',
    responses: ok('How many were deleted.', S.obj({ deleted: S.int() }, ['deleted'])),
    handler: ({ d }) => {
      const n = d.db.run('DELETE FROM events').changes;
      d.bus.changed('events');
      return { deleted: Number(n) };
    },
  },
  {
    method: 'GET', path: '/events/export', operationId: 'exportEvents', tag: 'Logs', scope: 'read',
    summary: 'Export the event log', description: 'Oldest first. Accepts the same filters as the list.',
    query: { ...eventQuery, ...exportQuery(100000) },
    responses: fileResp('NDJSON or JSON file.', 'application/x-ndjson'),
    handler: (c) => sendExport(c, 'sas-events', exportRows(c.d, 'events', eventFilter(c.query), c.query).map(eventOut)),
  },
  {
    method: 'GET', path: '/events/{id}', operationId: 'getEvent', tag: 'Logs', scope: 'read',
    summary: 'Get an event',
    params: { id: { description: 'Event id.', schema: S.int({ minimum: 1 }) } },
    responses: okRef('The event.', 'Event'),
    handler: ({ d, params }) => {
      const e = d.db.get('SELECT * FROM events WHERE id = ?', Number(params.id));
      if (!e) throw notFound('Event');
      return eventOut(e);
    },
  },

  // ---------------------------------------------------------------- live stream
  {
    method: 'GET', path: '/stream', operationId: 'streamEvents', tag: 'Logs', scope: 'read',
    summary: 'Live event stream (Server-Sent Events)',
    description: [
      'A `text/event-stream` that stays open. Event types:',
      '',
      '- `hello`: sent once on connect: `{"requestId", "types", "serverTime"}`.',
      '- `event`: a new event-log entry (same fields as GET /events items).',
      '- `message`: a new wire-log exchange (same fields as GET /messages items).',
      '- `changed`: `{"what": "cbsds" | "grants" | "settings" | "certs" | "spectrum" | "faults" | "map" | "terrain" | "status" | …}`. Re-read that resource.',
      '',
      'A comment line (`: ping`) is sent every 15 s to keep proxies from closing the connection.',
      'Browsers\' EventSource cannot set headers, so this route also accepts the API key as `?access_token=` (in the console the login cookie is enough).',
    ].join('\n'),
    query: {
      types: { description: 'Comma-separated event types to receive (default: all).', schema: S.arr(S.enum(STREAM_TYPES)) },
      access_token: { description: 'API key, for clients that cannot send an Authorization header.', schema: S.str() },
    },
    responses: fileResp('Event stream.', 'text/event-stream'),
    handler: ({ d, req, res, query, head, requestId, principal }) => {
      const types: string[] = query.types?.length ? query.types : STREAM_TYPES;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      if (head) {
        res.end();
        return SENT;
      }
      // A client that stops reading must not make the SAS buffer events for it without limit.
      const send = (chunk: string) => {
        if (res.writableEnded) return;
        if (res.writableLength > STREAM_MAX_BUFFERED) res.destroy();
        else res.write(chunk);
      };
      // Credentials were checked at connect; end the stream once they stop being valid.
      const stillAllowed = () => d.auth.stillValid(principal);
      send(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ requestId, types, serverTime: Date.now() })}\n\n`);
      const onEvent = (type: string, data: unknown) => {
        if (types.includes(type)) send(`event: ${type}\ndata: ${JSON.stringify(STREAM_SHAPE[type]?.(data) ?? data)}\n\n`);
      };
      const end = () => {
        stop();
        res.end();
      };
      const onRevoked = (id: string) => {
        if (id === principal.tokenId) end();
      };
      const onAuthChanged = (userId: number) => {
        if (userId === principal.userId && !stillAllowed()) end();
      };
      d.bus.on('sse', onEvent);
      d.bus.on('api-token-revoked', onRevoked);
      d.bus.on('auth-changed', onAuthChanged);
      const ping = setInterval(() => (stillAllowed() ? send(': ping\n\n') : end()), STREAM_PING_MS);
      function stop() {
        clearInterval(ping);
        d.bus.off('sse', onEvent);
        d.bus.off('api-token-revoked', onRevoked);
        d.bus.off('auth-changed', onAuthChanged);
      }
      req.on('close', stop);
      res.on('close', stop);
      return SENT;
    },
  },
];
