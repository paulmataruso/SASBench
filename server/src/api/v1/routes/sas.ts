import http from 'node:http';
import https from 'node:https';
import type { RequestCtx, SasMethod } from '../../../sas/engine.ts';
import { SAS_METHODS } from '../../../sas/engine.ts';
import type { Route } from '../http.ts';
import { badRequest, conflict, invalid, notFound } from '../http.ts';
import { S } from '../schema.ts';
import { okRef } from './common.ts';
import { loopbackHost } from '../../../net/addresses.ts';

// Send SAS–CBSD protocol requests as if from a radio: straight into the protocol engine
// (transport=internal, as the console's request console does), or through the real SAS listener
// over HTTP or HTTPS so that TLS, client certificates, role checks and fault rules apply.

interface Loopback {
  status: number | null;
  text: string;
  error: string | null;
}

function loopback(o: { tls: boolean; host: string; port: number; path: string; body: string; cert?: string; key?: string; timeoutMs: number }): Promise<Loopback> {
  return new Promise((resolve) => {
    const opts: https.RequestOptions = {
      host: o.host, port: o.port, path: o.path, method: 'POST', timeout: o.timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(o.body) },
    };
    if (o.tls) Object.assign(opts, { servername: 'localhost', rejectUnauthorized: false, cert: o.cert, key: o.key, minVersion: 'TLSv1.2' });
    const req = (o.tls ? https : http).request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? null, text: Buffer.concat(chunks).toString('utf8'), error: null }));
      res.on('error', (e) => resolve({ status: res.statusCode ?? null, text: Buffer.concat(chunks).toString('utf8'), error: e.message }));
    });
    req.on('timeout', () => req.destroy(new Error(`No response within ${o.timeoutMs} ms`)));
    req.on('error', (e: NodeJS.ErrnoException) => resolve({ status: null, text: '', error: e.code ? `${e.code}: ${e.message}` : e.message }));
    req.end(o.body);
  });
}

const parse = (t: string): unknown => {
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

export const sasRoutes: Route[] = [
  {
    method: 'POST', path: '/sas/{method}', operationId: 'sendSasRequest', tag: 'SAS protocol', scope: 'write', errors: [404],
    summary: 'Send a SAS–CBSD protocol request',
    description: [
      'The body is exactly what a radio sends, e.g. `{"registrationRequest": [ … ]}`; batches are allowed. The response wraps what the SAS answered.',
      '',
      '- `transport=internal` (default): the request goes straight to the protocol engine. No TLS, no certificate checks, no fault rules; the exchange is logged in the wire log with transport `internal`.',
      '- `transport=http` / `https`: the request is sent over the loopback interface to the real SAS listener, so fault rules, TLS policy, client-certificate role and identity checks and revocation all apply. With `https`, `clientCertId` selects a certificate from the store (it needs a private key) to present as the client certificate.',
      '',
      'With `raw=true` (http or https only) the body is `{"rawBody": "…"}` and that text is sent unchanged, for testing how the SAS handles malformed payloads.',
      'Protocol errors are not API errors: a request the SAS rejects still returns HTTP 200 here, with the SAS\'s answer in `body`.',
    ].join('\n'),
    params: { method: { description: 'SAS method.', schema: S.enum(SAS_METHODS) } },
    query: {
      transport: { description: 'How to deliver the request.', schema: S.enum(['internal', 'http', 'https'], { default: 'internal' }) },
      version: { description: 'Protocol version in the URL path. Defaults to the first supported version.', schema: S.str({ pattern: '^v\\d+\\.\\d+$' }) },
      clientCertId: { description: 'With transport=https: certificate id to present as the client certificate.', schema: S.str({ minLength: 1 }) },
      raw: { description: 'Send body.rawBody verbatim (http/https only).', schema: S.bool({ default: false }) },
      timeoutMs: { description: 'How long to wait for the listener (http/https).', schema: S.int({ minimum: 100, maximum: 600000, default: 30000 }) },
    },
    body: {
      required: true,
      schema: S.anyObj({ description: 'The protocol request object, or {"rawBody": "…"} with raw=true.' }),
      example: {
        registrationRequest: [{
          userId: 'lab-user', fccId: 'TEST-FCC', cbsdSerialNumber: 'SN-0001', cbsdCategory: 'A', airInterface: { radioTechnology: 'E_UTRA' }, measCapability: [],
          installationParam: { latitude: 37.425, longitude: -122.084, height: 5, heightType: 'AGL', indoorDeployment: true, antennaGain: 5, eirpCapability: 26 },
        }],
      },
    },
    responses: okRef('What the SAS answered.', 'SasExchange'),
    handler: async ({ d, params, query, body }) => {
      const method = params.method as SasMethod;
      const s = d.settings.get();
      const version: string = query.version ?? s.supportedVersions[0] ?? 'v1.2';
      const transport: 'internal' | 'http' | 'https' = query.transport;
      if (query.raw && transport === 'internal') throw badRequest('raw=true needs transport=http or https');
      if (query.clientCertId && transport !== 'https') throw badRequest('clientCertId needs transport=https');
      const started = Date.now();

      if (transport === 'internal') {
        const items = body[`${method}Request`];
        if (!Array.isArray(items)) throw invalid(`${method}Request`, 'must be an array of request objects');
        const ctx: RequestCtx = { transport: 'internal', remoteAddr: 'api', cert: null, certAuthorized: false, certError: null, version };
        const responses = d.engine.handle(method, items, ctx);
        const out = { [`${method}Response`]: responses };
        d.bus.message({
          ts: started, transport: 'internal', remoteAddr: 'api', path: `/${version}/${method}`, method, version, httpStatus: 200,
          durationMs: Date.now() - started, request: body, response: out,
          codes: responses.map((x) => x.response.responseCode),
          cbsdIds: [...new Set(responses.map((x) => x.cbsdId).filter(Boolean))] as string[],
        });
        return { transport, method, version, httpStatus: 200, durationMs: Date.now() - started, body: out, error: null };
      }

      let payload: string;
      if (query.raw) {
        if (typeof body.rawBody !== 'string') throw invalid('rawBody', 'must be a string when raw=true');
        payload = body.rawBody;
      } else payload = JSON.stringify(body);
      const st = d.sas.getStatus();
      const l = transport === 'https' ? st.https : st.http;
      if (!l.listening) throw conflict(`The SAS ${transport.toUpperCase()} listener is not running`);
      let cert: string | undefined;
      let key: string | undefined;
      if (query.clientCertId) {
        const row = d.pki.getRow(query.clientCertId);
        if (!row) throw notFound('Client certificate');
        if (!row.key_pem) throw badRequest('The client certificate has no private key');
        cert = row.cert_pem + d.pki.pemChain(row.id, false);
        key = row.key_pem;
      }
      const r = await loopback({ tls: transport === 'https', host: loopbackHost(d.bindIp), port: l.port, path: `/${version}/${method}`, body: payload, cert, key, timeoutMs: query.timeoutMs });
      return { transport, method, version, httpStatus: r.status, durationMs: Date.now() - started, body: parse(r.text), error: r.error };
    },
  },
];
