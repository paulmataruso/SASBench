import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../../db.ts';
import type { SettingsStore } from '../../settings.ts';
import type { Bus } from '../../bus.ts';
import type { Pki } from '../../pki/pki.ts';
import type { Engine } from '../../sas/engine.ts';
import type { SasServer } from '../../net/sasServer.ts';
import type { SasAdmin } from '../../sas/admin.ts';
import type { TileDownloader, TileStore } from '../../map/tiles.ts';
import type { TerrainDownloader } from '../../tools/terrainFetch.ts';
import type { ApiTokens, Principal, Scope } from './auth.ts';
import type { Schema } from './schema.ts';

// Types shared by the v1 dispatcher and the route modules.

export interface V1Deps {
  db: Db;
  settings: SettingsStore;
  bus: Bus;
  pki: Pki;
  engine: Engine;
  sas: SasServer;
  admin: SasAdmin;
  tiles: TileStore;
  tileDownloader: TileDownloader;
  terrainDownloader: TerrainDownloader;
  tokens: ApiTokens;
  startedAt: number;
  version: string;
  uiPort: number;
  hostnames: string[];
  dataDir: string;
  /** Origins allowed to call the API from a browser (SAS_API_CORS_ORIGINS); '*' allows any. */
  corsOrigins: string[];
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Who may call a route: anyone, any authenticated caller, or callers with write access. */
export type RouteScope = 'public' | Scope;

export interface ParamSpec {
  description: string;
  schema?: Schema;
}

export interface QuerySpec {
  description: string;
  schema: Schema;
  required?: boolean;
}

export interface ResponseSpec {
  description: string;
  schema?: Schema;
  /** Defaults to application/json. */
  contentType?: string;
  headers?: Record<string, string>;
}

export interface Route {
  method: Method;
  /** Relative to /api/v1. "{name}" is one path segment; "{name+}" matches the rest of the path. */
  path: string;
  operationId: string;
  tag: string;
  summary: string;
  description?: string;
  scope: RouteScope;
  params?: Record<string, ParamSpec>;
  query?: Record<string, QuerySpec>;
  body?: { schema: Schema; required?: boolean; description?: string; example?: unknown };
  responses: Record<number, ResponseSpec>;
  /** Error statuses this route can return beyond those the OpenAPI generator infers (400, 401, 403, 404 with path parameters, 409 for changes with path parameters). */
  errors?: number[];
  handler: (c: Ctx) => unknown | Promise<unknown>;
}

export interface Ctx {
  d: V1Deps;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  route: Route;
  params: Record<string, string>;
  query: Record<string, any>;
  body: any;
  principal: Principal;
  requestId: string;
  /** HEAD request: handlers that write the response themselves must not send a body. */
  head: boolean;
  /** Throw 403 unless the caller has write access (for GET routes that reveal secrets). */
  requireWrite: (what: string) => void;
}

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`);
export const conflict = (message: string) => new ApiError(409, 'conflict', message);
export const badRequest = (message: string, details?: unknown) => new ApiError(400, 'bad_request', message, details);
export const invalid = (path: string, message: string) => new ApiError(400, 'validation_failed', `${path} ${message}`, [{ path, message }]);

/** A handler result with a status other than 200 and/or extra headers. */
export class Reply {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  constructor(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export const created = (body: unknown, location?: string) =>
  new Reply(201, body, location ? { Location: `/api/v1${location}` } : {});
export const accepted = (body: unknown) => new Reply(202, body);
export const noContent = () => new Reply(204, undefined);

/** Marker returned by handlers that wrote the response themselves (downloads, streams). */
export const SENT = Symbol('sent');

/** Send a file-like body. */
export function sendFile(c: Ctx, data: Buffer | string, contentType: string, filename?: string): typeof SENT {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  const h: Record<string, string | number> = {
    'Content-Type': contentType, 'Content-Length': buf.length, 'Cache-Control': 'no-store',
  };
  if (filename) h['Content-Disposition'] = `attachment; filename="${filename.replace(/["\\\r\n]/g, '')}"`;
  c.res.writeHead(200, h);
  c.res.end(c.head ? undefined : buf);
  return SENT;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export function page<T>(all: T[], q: Record<string, any>): Page<T> {
  return { items: all.slice(q.offset, q.offset + q.limit), total: all.length, limit: q.limit, offset: q.offset };
}
