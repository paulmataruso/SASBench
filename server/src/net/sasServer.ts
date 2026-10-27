import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { SettingsStore, Settings } from '../settings.ts';
import type { Pki } from '../pki/pki.ts';
import type { Bus } from '../bus.ts';
import type { Engine, RequestCtx, SasMethod } from '../sas/engine.ts';
import { SAS_METHODS } from '../sas/engine.ts';
import { summarizeCert, type CertSummary } from '../pki/x509.ts';
import { readBody, sendJson } from './http.ts';
import type { FaultInjector } from '../sas/faults.ts';

// SAS-CBSD transport (WINNF-TS-0016 §9.2): HTTP/1.1 POST to
//   <base URL>/{sas_version_number}/{sas_method_name}
// carrying a JSON object whose single member is the request array.
// Served over HTTPS with mutual TLS (WINNF-TS-0065) and, for lab use, plain HTTP.

/** WINNF-TS-0065 §5.1: the only cipher suites a SAS may negotiate (TLS 1.2). */
export const WINNF_CIPHERS = [
  'AES128-GCM-SHA256',             // TLS_RSA_WITH_AES_128_GCM_SHA256
  'AES256-GCM-SHA384',             // TLS_RSA_WITH_AES_256_GCM_SHA384
  'ECDHE-ECDSA-AES128-GCM-SHA256', // TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
  'ECDHE-ECDSA-AES256-GCM-SHA384', // TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
  'ECDHE-RSA-AES128-GCM-SHA256',   // TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
];
export const EXTENDED_CIPHERS = [
  ...WINNF_CIPHERS,
  'ECDHE-RSA-AES256-GCM-SHA384', 'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-RSA-AES128-SHA256', 'ECDHE-RSA-AES256-SHA384', 'AES128-SHA256', 'AES256-SHA256', 'AES128-SHA', 'AES256-SHA',
];

const PATH_RE = /\/(v\d+\.\d+)\/([A-Za-z]+)\/?$/;
const VERSIONLESS_RE = /\/([A-Za-z]+)\/?$/;

/**
 * Node answers an HTTP/1.1 request without a Host header with a bare 400 before it reaches the
 * handler (and the wire log). Sercomm NR radios send none; the SAS serves no virtual hosts, so accept them.
 */
const SERVER_OPTIONS: http.ServerOptions = { requireHostHeader: false };

/**
 * The path a request is routed by, with runs of slashes collapsed. Radios that add "/registration"
 * to a SAS URL entered with a trailing slash (Baicells) send /v1.2//registration.
 */
export function routePath(target: string): string {
  // Only an origin-form target ("/…"); an absolute one ("http://host/…") has a "//" of its own.
  const t = target.startsWith('/') ? target.replace(/^[^?]*/, (p) => p.replace(/\/{2,}/g, '/')) : target;
  return new URL(t, 'http://x').pathname;
}

/** Why a listener could not start, with the two usual causes spelled out. */
function listenError(e: NodeJS.ErrnoException, port: number): string {
  if (e.code === 'EADDRINUSE') return `port ${port} is already in use by another program`;
  if (e.code === 'EACCES' && port < 1024) return `no permission for port ${port}: ports below 1024 need root or the CAP_NET_BIND_SERVICE capability`;
  return e.message;
}

export type AdminHook = (req: IncomingMessage, res: ServerResponse, pathname: string, ctx: RequestCtx) => Promise<boolean>;

export interface ListenerStatus {
  http: { enabled: boolean; listening: boolean; port: number; error: string | null };
  https: {
    enabled: boolean; listening: boolean; port: number; error: string | null; clientAuth: string;
    serverCerts: string[]; trustAnchors: number; ciphers: string; protocols: string;
  };
}

interface SocketInfo {
  revoked: string | null;
}

export class SasServer {
  private httpServer: http.Server | null = null;
  private httpsServer: https.Server | null = null;
  private status: ListenerStatus;
  private certCache = new Map<string, CertSummary>();
  private sockInfo = new WeakMap<Socket, SocketInfo>();
  private restarting: Promise<void> = Promise.resolve();
  adminHook: AdminHook | null = null;
  /** Address both listeners bind (SAS_BIND_IP). */
  bindHost = '0.0.0.0';

  private settings: SettingsStore;
  private pki: Pki;
  private bus: Bus;
  private engine: Engine;
  private faults: FaultInjector;

  constructor(settings: SettingsStore, pki: Pki, bus: Bus, engine: Engine, faults: FaultInjector) {
    this.settings = settings;
    this.pki = pki;
    this.bus = bus;
    this.engine = engine;
    this.faults = faults;
    this.status = this.initialStatus(settings.get());
  }

  private initialStatus(s: Settings): ListenerStatus {
    return {
      http: { enabled: s.sasHttpEnabled, listening: false, port: s.sasHttpPort, error: null },
      https: {
        enabled: s.sasHttpsEnabled, listening: false, port: s.sasHttpsPort, error: null, clientAuth: s.tlsClientAuth,
        serverCerts: [], trustAnchors: 0, ciphers: '', protocols: `${s.tlsMinVersion}–${s.tlsMaxVersion}`,
      },
    };
  }

  getStatus(): ListenerStatus {
    return structuredClone(this.status);
  }

  /** (Re)start both listeners according to current settings. Serialized. */
  restart(): Promise<void> {
    this.restarting = this.restarting.then(() => this.doRestart()).catch((e) => {
      this.bus.event('error', 'listener', `Listener restart failed: ${e.message}`);
    });
    return this.restarting;
  }

  /** Resolves once any pending listener restart has finished. */
  idle(): Promise<void> {
    return this.restarting;
  }

  /** Swap certificates / trust anchors on the running HTTPS listener without dropping connections. */
  reloadTls() {
    if (!this.httpsServer) return void this.restart();
    try {
      this.httpsServer.setSecureContext(this.tlsOptions(this.settings.get()) as tls.SecureContextOptions);
    } catch (e: any) {
      this.bus.event('error', 'listener', `TLS reload failed: ${e.message}`);
    }
  }

  async stop() {
    await Promise.all([closeServer(this.httpServer), closeServer(this.httpsServer)]);
    this.httpServer = this.httpsServer = null;
  }

  private async doRestart() {
    await this.stop();
    const s = this.settings.get();
    this.status = this.initialStatus(s);

    if (s.sasHttpEnabled) {
      const srv = http.createServer(SERVER_OPTIONS, (req, res) => void this.onRequest(req, res, 'http'));
      srv.keepAliveTimeout = 65_000;
      try {
        await listen(srv, s.sasHttpPort, this.bindHost);
        this.httpServer = srv;
        this.status.http.listening = true;
        this.bus.event('info', 'listener', `SAS HTTP listening on port ${s.sasHttpPort}`);
      } catch (e: any) {
        this.status.http.error = listenError(e, s.sasHttpPort);
        this.bus.event('error', 'listener', `SAS HTTP failed to listen on ${s.sasHttpPort}: ${this.status.http.error}`);
      }
    }

    if (s.sasHttpsEnabled) {
      try {
        const opts = this.tlsOptions(s);
        const srv = https.createServer({ ...opts, ...SERVER_OPTIONS }, (req, res) => void this.onRequest(req, res, 'https'));
        srv.keepAliveTimeout = 65_000;
        srv.on('tlsClientError', (err: any, sock: tls.TLSSocket) => {
          this.bus.message({
            ts: Date.now(), transport: 'https', remoteAddr: sock?.remoteAddress,
            error: `TLS handshake failed: ${err.code ?? ''} ${err.reason ?? err.message}`.trim(),
          });
        });
        srv.on('secureConnection', (sock: tls.TLSSocket) => this.onSecureConnection(sock));
        await listen(srv, s.sasHttpsPort, this.bindHost);
        this.httpsServer = srv;
        this.status.https.listening = true;
        this.bus.event('info', 'listener', `SAS HTTPS listening on port ${s.sasHttpsPort} (client auth: ${s.tlsClientAuth}, ${this.status.https.protocols})`);
      } catch (e: any) {
        this.status.https.error = listenError(e, s.sasHttpsPort);
        this.bus.event('error', 'listener', `SAS HTTPS failed to start on ${s.sasHttpsPort}: ${this.status.https.error}`);
      }
    }
    this.bus.changed('listeners');
  }

  private tlsOptions(s: Settings): https.ServerOptions {
    const certs = s.serverCertIds.map((id) => this.pki.getRow(id)).filter((r) => r && r.key_pem);
    if (!certs.length) throw new Error('No server certificate with private key selected (Certificates → use as SAS server certificate)');
    this.status.https.serverCerts = certs.map((r) => `${r!.name} (${r!.key_type})`);
    const anchors = (s.trustedClientCaIds.length ? s.trustedClientCaIds.map((id) => this.pki.getRow(id)).filter(Boolean) : this.pki.caCerts())
      .map((r) => r!.cert_pem);
    this.status.https.trustAnchors = anchors.length;
    const minVersion = s.tlsMinVersion;
    const maxVersion = s.tlsMinVersion === 'TLSv1.3' ? 'TLSv1.3' : s.tlsMaxVersion;
    const opts: https.ServerOptions = {
      key: certs.map((r) => r!.key_pem),
      cert: certs.map((r) => r!.cert_pem + this.pki.pemChain(r!.id, false)),
      ca: anchors.length ? anchors : undefined,
      minVersion,
      maxVersion,
      requestCert: s.tlsClientAuth !== 'none',
      rejectUnauthorized: s.tlsClientAuth === 'require',
      honorCipherOrder: true,
      // The harness opens a fresh connection for every request; never resume sessions so that
      // certificate validity (e.g. short-lived certificates) is re-checked on every handshake.
      sessionTimeout: 1,
      ticketKeys: crypto.randomBytes(48),
    };
    if (s.tlsCipherPolicy === 'winnforum') opts.ciphers = WINNF_CIPHERS.join(':');
    else if (s.tlsCipherPolicy === 'extended') opts.ciphers = EXTENDED_CIPHERS.join(':');
    if (opts.ciphers && maxVersion === 'TLSv1.3') opts.ciphers += ':TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256';
    this.status.https.ciphers = opts.ciphers ?? 'Node.js default';
    this.status.https.protocols = minVersion === maxVersion ? minVersion : `${minVersion}–${maxVersion}`;
    return opts;
  }

  /** Per-connection revocation check of the full client chain (local PKI + imported CRLs). */
  private onSecureConnection(sock: tls.TLSSocket) {
    const info: SocketInfo = { revoked: null };
    this.sockInfo.set(sock, info);
    if (!this.settings.get().tlsCheckCrl) return;
    try {
      const chain = peerChain(sock);
      if (!chain.length) return;
      info.revoked = this.pki.revokedInChain(chain);
      if (info.revoked) {
        this.bus.message({ ts: Date.now(), transport: 'https', remoteAddr: sock.remoteAddress, certSubject: oneLine(chain[0].subject), error: `Revoked client certificate: ${info.revoked}` });
      }
    } catch (e: any) {
      this.bus.event('warn', 'security', `Revocation check failed: ${e.message}`);
    }
  }

  private clientCert(sock: Socket): { summary: CertSummary | null; authorized: boolean; error: string | null } {
    const t = sock as tls.TLSSocket;
    if (typeof t.getPeerCertificate !== 'function') return { summary: null, authorized: false, error: null };
    const peer = t.getPeerCertificate(false);
    if (!peer || !peer.raw) return { summary: null, authorized: false, error: t.authorizationError ? String(t.authorizationError) : null };
    const key = peer.fingerprint256;
    let summary = this.certCache.get(key);
    if (!summary) {
      try {
        summary = summarizeCert(peer.raw);
        if (this.certCache.size > 5000) this.certCache.clear();
        this.certCache.set(key, summary);
      } catch {
        summary = undefined;
      }
    }
    return { summary: summary ?? null, authorized: t.authorized, error: t.authorizationError ? String(t.authorizationError) : null };
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse, transport: 'http' | 'https') {
    const started = Date.now();
    // The path as sent goes into the wire log; routing collapses runs of slashes (see routePath).
    const pathname = (req.url ?? '/').split('?')[0];
    const route = routePath(req.url ?? '/');
    const cert = this.clientCert(req.socket);
    const ctx: RequestCtx = {
      transport, remoteAddr: req.socket.remoteAddress ?? '', cert: cert.summary, certAuthorized: cert.authorized,
      certError: cert.error, version: '',
    };
    res.setHeader('Server', 'SASBench');
    const s = this.settings.get();
    const reject403 = async (why: string) => {
      const body = await readBody(req).catch(() => Buffer.alloc(0));
      this.bus.message({ ts: started, transport, remoteAddr: ctx.remoteAddr, path: pathname, httpStatus: 403, durationMs: Date.now() - started,
        certSubject: cert.summary?.subject, request: tryParse(body), error: why });
      sendJson(res, 403, { error: why });
    };

    try {
      if (transport === 'https') {
        const info = this.sockInfo.get(req.socket);
        if (info?.revoked) return await reject403(`Client certificate revoked: ${info.revoked}`);
        if (s.tlsClientAuth === 'optional' && s.rejectUnverifiedClientCert && cert.summary && !cert.authorized) {
          return await reject403(`Client certificate not trusted: ${cert.error ?? 'verification failed'}`);
        }
      }

      if (route.includes('/admin/')) {
        if (this.adminHook && s.harnessAdminEnabled && (await this.adminHook(req, res, route, ctx))) return;
        await readBody(req).catch(() => undefined);
        return sendJson(res, 404, { error: 'Test harness admin interface is disabled' });
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        return sendJson(res, 200, {
          service: 'SASBench', protocol: 'WINNF-TS-0016', supportedVersions: s.supportedVersions,
          methods: SAS_METHODS, transport, clientCertificate: cert.summary ? cert.summary.subject : null,
        });
      }
      if (req.method !== 'POST') {
        await readBody(req).catch(() => undefined);
        res.writeHead(405, { Allow: 'POST', 'Content-Length': 0 });
        return res.end();
      }

      let version: string | null = null;
      let method: string | null = null;
      const m = PATH_RE.exec(route);
      if (m) {
        version = m[1];
        method = m[2];
      } else if (s.acceptVersionlessPaths) {
        const m2 = VERSIONLESS_RE.exec(route);
        if (m2) {
          version = s.supportedVersions[0] ?? 'v1.2';
          method = m2[1];
        }
      }
      const sasMethod = SAS_METHODS.find((x) => x === method) as SasMethod | undefined;
      const unsupported = !!sasMethod && !s.supportedVersions.includes(version!) && !s.versionErrorAsResponseCode;
      if (!sasMethod || unsupported) {
        const body = await readBody(req).catch(() => Buffer.alloc(0));
        const error = unsupported ? `Unsupported SAS protocol version ${version}` : 'Unknown SAS method path';
        this.bus.message({ ts: started, transport, remoteAddr: ctx.remoteAddr, path: pathname, method: sasMethod, version: version ?? undefined,
          httpStatus: 404, durationMs: Date.now() - started, certSubject: cert.summary?.subject, request: tryParse(body), error });
        return sendJson(res, 404, { error: unsupported ? `${error}; supported: ${s.supportedVersions.join(', ')}` : `${error}. Expected POST .../{version}/{${SAS_METHODS.join('|')}}` });
      }
      ctx.version = version!;
      await this.handleSas(req, res, sasMethod, ctx, started, pathname);
    } catch (e: any) {
      this.bus.message({ ts: started, transport, remoteAddr: ctx.remoteAddr, path: pathname, httpStatus: 500, error: e?.stack ?? String(e) });
      if (!res.headersSent) sendJson(res, e?.status ?? 500, { error: e?.status ? e.message : 'Internal SAS error' });
      else res.destroy();
    }
  }

  private async handleSas(req: IncomingMessage, res: ServerResponse, method: SasMethod, ctx: RequestCtx, started: number, pathname: string) {
    const s = this.settings.get();
    const raw = await readBody(req);
    const reqKey = `${method}Request`;
    const respKey = `${method}Response`;
    let parsed: any;
    const log = (httpStatus: number, response: unknown, extra: { codes?: number[]; cbsdIds?: string[]; error?: string } = {}) =>
      this.bus.message({
        ts: started, transport: ctx.transport, remoteAddr: ctx.remoteAddr, path: pathname, method, version: ctx.version,
        httpStatus, durationMs: Date.now() - started, certSubject: ctx.cert?.subject ?? (ctx.certError ? `(unverified: ${ctx.certError})` : undefined),
        request: parsed ?? (raw.length ? raw.toString('utf8').slice(0, 65536) : undefined), response, ...extra,
      });

    try {
      parsed = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
    } catch {
      log(400, undefined, { error: 'Malformed JSON payload' });
      return sendJson(res, 400, { error: 'Malformed JSON payload' });
    }

    // Fault injection may short-circuit the whole HTTP exchange.
    const items: any[] | null = parsed && typeof parsed === 'object' && Array.isArray(parsed[reqKey]) ? parsed[reqKey] : null;
    const pre = this.faults.preResponse(method, items ?? [], ctx);
    if (pre) {
      if (pre.delayMs) await sleep(pre.delayMs);
      if (pre.drop) {
        log(0, undefined, { error: `Fault injection: connection dropped (${pre.ruleName})` });
        req.socket.destroy();
        return;
      }
      if (pre.httpStatus) {
        log(pre.httpStatus, pre.body ?? undefined, { error: `Fault injection: HTTP ${pre.httpStatus} (${pre.ruleName})` });
        return sendJson(res, pre.httpStatus, pre.body ?? { error: 'Injected fault' });
      }
      if (pre.rawBody !== undefined) {
        log(200, pre.rawBody, { error: `Fault injection: malformed response (${pre.ruleName})` });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(pre.rawBody) });
        return res.end(pre.rawBody);
      }
    }

    if (!items) {
      const err = `Payload must be a JSON object containing a "${reqKey}" array`;
      log(400, undefined, { error: err });
      return sendJson(res, 400, { error: err });
    }

    // Certificate role check (WINNF-TS-0065) before any other validation → 104 for every element.
    const problem = this.engine.certRoleProblem(ctx);
    const responses = problem ? this.engine.certErrorResponses(method, items, problem) : this.engine.handle(method, items, ctx);
    if (!problem) this.faults.postResponse(method, items, responses, ctx);
    if (s.responseDelayMs > 0) await sleep(s.responseDelayMs);

    const body = { [respKey]: responses };
    const codes = responses.map((r: any) => r?.response?.responseCode).filter((c: any) => typeof c === 'number');
    const cbsdIds = [...new Set(items.map((i: any) => i?.cbsdId).concat(responses.map((r: any) => r?.cbsdId))
      .filter((x: any) => typeof x === 'string'))] as string[];
    log(200, body, { codes, cbsdIds, error: problem ?? undefined });
    sendJson(res, 200, body);
  }
}

/** Client certificate chain as verified by OpenSSL (leaf first, ending at the trust anchor). */
function peerChain(sock: tls.TLSSocket): crypto.X509Certificate[] {
  const out: crypto.X509Certificate[] = [];
  let c: any = sock.getPeerCertificate(true);
  const seen = new Set<string>();
  while (c && c.raw && !seen.has(c.fingerprint256)) {
    seen.add(c.fingerprint256);
    out.push(new crypto.X509Certificate(c.raw));
    c = c.issuerCertificate;
  }
  return out;
}

function oneLine(dn: string): string {
  return dn.split('\n').filter(Boolean).join(', ');
}

function tryParse(b: Buffer): unknown {
  if (!b.length) return undefined;
  try {
    return JSON.parse(b.toString('utf8'));
  } catch {
    return b.toString('utf8').slice(0, 4096);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function listen(srv: http.Server | https.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onErr = (e: Error) => reject(e);
    srv.once('error', onErr);
    srv.listen(port, host, () => {
      srv.off('error', onErr);
      resolve();
    });
  });
}

function closeServer(srv: http.Server | https.Server | null): Promise<void> {
  if (!srv) return Promise.resolve();
  return new Promise((resolve) => {
    srv.close(() => resolve());
    srv.closeAllConnections?.();
  });
}
