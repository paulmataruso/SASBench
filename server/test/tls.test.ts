import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import type { TLSSocket } from 'node:tls';
import { startSas, regRequest, code, type TestSas } from './helpers.ts';

// HTTPS listener (WINNF-TS-0065): TLS 1.2 with the WInnForum cipher suites, client certificates
// issued by the lab PKI, revocation → HTTP 403.

const WINNF_CIPHERS = [
  'AES128-GCM-SHA256', 'AES256-GCM-SHA384', 'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES128-GCM-SHA256',
];

let sas: TestSas;
let certId: string;
let certPem: string;
let keyPem: string;
let caBundle: string;

before(async () => {
  sas = await startSas();
  const { certs } = await sas.api('GET', '/api/certs');
  const cbsdCa = certs.find((c: any) => c.kind === 'sub_ca' && c.role === 'cbsd');
  assert.ok(cbsdCa, 'lab PKI has a CBSD CA');
  const issued = await sas.api('POST', '/api/certs/cbsd', { parentId: cbsdCa.id, fccId: 'FCCTLS', serial: 'SN-T1' });
  certId = issued.id;
  certPem = await sas.apiText(`/api/certs/${certId}/download?format=pem`);
  keyPem = await sas.apiText(`/api/certs/${certId}/download?format=key`);
  caBundle = await sas.apiText('/api/trust-bundle');
  assert.match(certPem, /BEGIN CERTIFICATE/);
  assert.match(keyPem, /BEGIN PRIVATE KEY/);
});

after(async () => {
  await sas?.stop();
});

interface TlsResult { status: number; body: any; protocol: string | null; cipher: string }

function post(path: string, body: unknown, tlsOpts: https.RequestOptions = {}): Promise<TlsResult> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      host: '127.0.0.1', port: sas.httpsPort, path, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      cert: certPem, key: keyPem, ca: caBundle, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
      ...tlsOpts,
    }, (res) => {
      const sock = res.socket as TLSSocket;
      const protocol = sock.getProtocol();
      const cipher = sock.getCipher().name;
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let parsed: any = text;
        try {
          parsed = JSON.parse(text);
        } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body: parsed, protocol, cipher });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('mutual TLS 1.2 with a lab-issued CBSD certificate; server certificate verifies against the trust bundle', async () => {
  const r = await post('/v1.2/registration', { registrationRequest: [regRequest('FCCTLS', 'SN-T1')] });
  assert.equal(r.status, 200);
  assert.equal(r.protocol, 'TLSv1.2');
  assert.ok(WINNF_CIPHERS.includes(r.cipher), `negotiated ${r.cipher}`);
  assert.equal(code(r.body.registrationResponse[0]), 0);
  const c = await sas.api('GET', `/api/cbsds/${encodeURIComponent(r.body.registrationResponse[0].cbsdId)}`);
  assert.equal(c.transport, 'https');
  assert.ok(c.certInfo?.roles.includes('CBSD'));
});

test('ECDSA server certificate is offered for ECDHE-ECDSA suites', async () => {
  const r = await post('/v1.2/registration', { registrationRequest: [regRequest('FCCTLS', 'SN-T1')] }, { ciphers: 'ECDHE-ECDSA-AES128-GCM-SHA256' });
  assert.equal(r.status, 200);
  assert.equal(r.cipher, 'ECDHE-ECDSA-AES128-GCM-SHA256');
});

test('suite outside the WInnForum list is refused', async () => {
  await assert.rejects(post('/v1.2/registration', { registrationRequest: [] }, { ciphers: 'ECDHE-RSA-AES256-GCM-SHA384' }));
});

test('TLS 1.3-only client fails the handshake', async () => {
  await assert.rejects(post('/v1.2/registration', { registrationRequest: [] }, { minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }));
});

test('certificate whose identity differs from the request is accepted with a warning by default', async () => {
  const r = await post('/v1.2/registration', { registrationRequest: [regRequest('FCCOTHER', 'SN-O1')] });
  assert.equal(code(r.body.registrationResponse[0]), 0);
});

test('revoked client certificate → HTTP 403', async () => {
  await sas.api('POST', `/api/certs/${certId}/revoke`, {});
  const r = await post('/v1.2/registration', { registrationRequest: [regRequest('FCCTLS', 'SN-T1')] });
  assert.equal(r.status, 403);
  await sas.api('POST', `/api/certs/${certId}/revoke`, { revoked: false });
  const r2 = await post('/v1.2/registration', { registrationRequest: [regRequest('FCCTLS', 'SN-T1')] });
  assert.equal(r2.status, 200);
});
