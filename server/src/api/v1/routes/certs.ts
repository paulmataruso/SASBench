import crypto from 'node:crypto';
import { jparse } from '../../../db.ts';
import { safe, sasUrls } from '../../../api.ts';
import { signCpiData } from '../../../sas/cpi.ts';
import { toRfc3339 } from '../../../util/time.ts';
import type { CaRole, KeyType } from '../../../pki/pki.ts';
import type { Ctx, Route, V1Deps } from '../http.ts';
import { badRequest, conflict, created, noContent, notFound, page, sendFile } from '../http.ts';
import { S, ref, type Schema } from '../schema.ts';
import { certOut, crlOut } from '../mappers.ts';
import { fileResp, noContentResp, ok, okRef, pageOf, pageQuery } from './common.ts';
import { applySettings, checkSettings, serverKeyType } from './settings.ts';

// Certificates: the lab PKI (roots, sub-CAs, server, CBSD, domain-proxy and installer certificates),
// imports, revocation and CRLs, downloads in every format, the SAS TLS configuration and CPI signing.

export const KEY_TYPES = ['rsa2048', 'rsa3072', 'rsa4096', 'ec256', 'ec384'];
export const CA_ROLES = ['sas', 'cbsd', 'operator', 'installer'];
const CERT_KINDS = ['root', 'sub_ca', 'server', 'cbsd', 'domain_proxy', 'installer', 'trusted', 'imported'];

/** Download formats; the ones marked key contain the private key and need write access. */
export const DOWNLOAD_FORMATS: Array<{ format: string; key: boolean; description: string }> = [
  { format: 'pem', key: false, description: 'The certificate (PEM).' },
  { format: 'crt', key: false, description: 'The certificate (PEM, .crt).' },
  { format: 'der', key: false, description: 'The certificate (DER).' },
  { format: 'chain', key: false, description: 'Certificate and issuing CAs, without the root (PEM).' },
  { format: 'fullchain', key: false, description: 'Certificate and issuing CAs including the root (PEM).' },
  { format: 'crl', key: false, description: 'A fresh CRL listing the revoked certificates this CA issued (CAs with a key only).' },
  { format: 'all-in-one', key: true, description: 'Full chain followed by the PKCS#8 private key (PEM).' },
  { format: 'all-in-one-traditional', key: true, description: 'Full chain followed by the PKCS#1 / SEC1 private key (PEM).' },
  { format: 'key', key: true, description: 'The private key, PKCS#8 (PEM).' },
  { format: 'key-traditional', key: true, description: 'The private key, PKCS#1 (RSA) or SEC1 (EC) (PEM).' },
  { format: 'p12', key: true, description: 'PKCS#12 with chain (AES), protected by `password`.' },
  { format: 'p12-legacy', key: true, description: 'PKCS#12 with 3DES/SHA-1 for older devices, protected by `password`.' },
  { format: 'bundle', key: true, description: 'Radio provisioning zip: identity in every format and the SAS trust anchors.' },
];

const dnProps = (cnRequired: boolean): Record<string, Schema> => ({
  CN: S.str({ minLength: cnRequired ? 1 : 0, maxLength: 64, description: 'Common name.' }),
  O: S.str({ maxLength: 64 }), OU: S.str({ maxLength: 64 }), L: S.str({ maxLength: 128 }), ST: S.str({ maxLength: 128 }),
  C: S.str({ pattern: '^[A-Za-z]{2}$', description: 'Two-letter country code.' }),
});
const common = (defKey: string): Record<string, Schema> => ({
  keyType: S.enum(KEY_TYPES, { default: defKey }),
  days: S.int({ minimum: 1, maximum: 36500, description: 'Validity in days (default depends on the kind).' }),
  name: S.str({ minLength: 1, maxLength: 200, description: 'Display name in the store (defaults from the subject).' }),
});
const parentId = S.str({ minLength: 1, description: 'Id of the issuing CA (must hold its private key).' });

const dn = (b: any) => ({ CN: b.CN, O: b.O || undefined, OU: b.OU || undefined, L: b.L || undefined, ST: b.ST || undefined, C: b.C || undefined });

function certOr404(d: V1Deps, id: string) {
  const c = d.pki.get(id);
  if (!c) throw notFound('Certificate');
  return c;
}

function issuer(d: V1Deps, id: string) {
  const row = d.pki.getRow(id);
  if (!row) throw notFound('Issuing CA');
  if (!row.key_pem) throw badRequest('The issuing CA has no private key in the store');
  return row;
}

const detail = (d: V1Deps, id: string) => {
  const c = certOr404(d, id);
  return {
    ...certOut(c, d.settings.get()),
    pem: d.pki.getRow(id)!.cert_pem,
    chain: d.pki.chainOf(id).map((x) => ({ id: x.id, name: x.name, kind: x.kind })),
    children: d.db.all('SELECT id, name, kind FROM certs WHERE parent_id = ? ORDER BY created_at', id),
  };
};

const issued = (d: V1Deps, id: string) => {
  d.bus.changed('certs');
  return created(detail(d, id), `/certs/${id}`);
};

const crlFull = (d: V1Deps, id: string) => {
  const c = d.pki.listCrls().find((x) => x.id === id);
  if (!c) throw notFound('CRL');
  return crlOut(c);
};

function tlsOf(d: V1Deps) {
  const s = d.settings.get();
  const brief = (id: string) => {
    const c = d.pki.get(id);
    return c ? { id, name: c.name, kind: c.kind, subject: c.subject, notAfter: c.notAfter, revoked: c.revokedAt !== null } : { id, name: null, kind: null, subject: null, notAfter: null, revoked: false };
  };
  return {
    serverCertIds: s.serverCertIds, trustedClientCaIds: s.trustedClientCaIds,
    serverCerts: s.serverCertIds.map(brief), trustedClientCas: s.trustedClientCaIds.map(brief),
    clientAuth: s.tlsClientAuth, minVersion: s.tlsMinVersion, maxVersion: s.tlsMaxVersion, cipherPolicy: s.tlsCipherPolicy, checkCrl: s.tlsCheckCrl,
    listener: d.sas.getStatus().https,
  };
}

function download(c: Ctx) {
  const { d, params, query } = c;
  const row = d.pki.getRow(params.id);
  if (!row) throw notFound('Certificate');
  const fmt: string = query.format;
  if (DOWNLOAD_FORMATS.find((f) => f.format === fmt)?.key) {
    c.requireWrite(`Downloading the private key (format ${fmt})`);
    if (!row.key_pem) throw badRequest('No private key stored for this certificate');
  }
  const base = safe(row.name);
  const id = params.id;
  const pw: string = query.password;
  const pem = 'application/x-pem-file';
  switch (fmt) {
    case 'pem': return sendFile(c, row.cert_pem, pem, `${base}.pem`);
    case 'crt': return sendFile(c, row.cert_pem, 'application/x-x509-ca-cert', `${base}.crt`);
    case 'der': return sendFile(c, d.pki.der(id), 'application/pkix-cert', `${base}.der`);
    case 'chain': return sendFile(c, row.cert_pem + d.pki.pemChain(id, false), pem, `${base}-chain.pem`);
    case 'fullchain': return sendFile(c, row.cert_pem + d.pki.pemChain(id, true), pem, `${base}-fullchain.pem`);
    case 'all-in-one': return sendFile(c, row.cert_pem + d.pki.pemChain(id, true) + d.pki.keyPem(id, 'pkcs8'), pem, `${base}-all-in-one.pem`);
    case 'all-in-one-traditional': return sendFile(c, row.cert_pem + d.pki.pemChain(id, true) + d.pki.keyPem(id, 'traditional'), pem, `${base}-all-in-one-traditional.pem`);
    case 'key': return sendFile(c, d.pki.keyPem(id, 'pkcs8'), pem, `${base}-key.pem`);
    case 'key-traditional': return sendFile(c, d.pki.keyPem(id, 'traditional'), pem, `${base}-key-traditional.pem`);
    case 'p12': return sendFile(c, d.pki.pkcs12(id, pw, false), 'application/x-pkcs12', `${base}.p12`);
    case 'p12-legacy': return sendFile(c, d.pki.pkcs12(id, pw, true), 'application/x-pkcs12', `${base}-legacy.p12`);
    case 'bundle': {
      const s = d.settings.get();
      return sendFile(c, d.pki.radioBundle(id, { password: pw, serverCertId: s.serverCertIds[0] ?? null, sasUrls: sasUrls(s, d.hostnames) }), 'application/zip', `${base}-bundle.zip`);
    }
    default: {
      if (!d.pki.get(id)?.isCa) throw badRequest('CRLs can only be generated for CA certificates');
      const crl = d.pki.crlFor(id);
      if (!crl) throw badRequest('CRLs can only be generated for CAs with a private key');
      return sendFile(c, crl, pem, `${base}.crl.pem`);
    }
  }
}

const idParam = { id: { description: 'Certificate id.' } };

export const certRoutes: Route[] = [
  {
    method: 'GET', path: '/certs', operationId: 'listCerts', tag: 'Certificates', scope: 'read',
    summary: 'List certificates',
    description: 'Every certificate in the store with its subject, issuer, validity, fingerprint, key type, role, revocation and whether the SAS uses it as a server certificate or trusts it as a client CA. Private keys are never included.',
    query: {
      kind: { description: 'Only this kind.', schema: S.enum(CERT_KINDS) },
      parentId: { description: 'Only certificates issued by this CA.', schema: S.str() },
      hasKey: { description: 'Only certificates with (or without) a private key.', schema: S.bool() },
      ca: { description: 'Only CAs (or only end-entity certificates).', schema: S.bool() },
      revoked: { description: 'Only revoked (or unrevoked) certificates.', schema: S.bool() },
      q: { description: 'Text search in the name, subject, issuer, serial and fingerprint.', schema: S.str({ minLength: 1 }) },
      ...pageQuery(),
    },
    responses: ok('A page of certificates.', pageOf('Certificate')),
    handler: ({ d, query }) => {
      const s = d.settings.get();
      const q = query.q?.toLowerCase();
      const all = d.pki.list().filter((c) =>
        (!query.kind || c.kind === query.kind) && (!query.parentId || c.parentId === query.parentId) &&
        (query.hasKey === undefined || c.hasKey === query.hasKey) && (query.ca === undefined || c.isCa === query.ca) &&
        (query.revoked === undefined || (c.revokedAt !== null) === query.revoked) &&
        (!q || [c.name, c.subject, c.issuer, c.serial, c.fingerprint].some((x) => String(x).toLowerCase().includes(q))));
      return page(all.map((c) => certOut(c, s)), query);
    },
  },
  {
    method: 'GET', path: '/certs/{id}', operationId: 'getCert', tag: 'Certificates', scope: 'read',
    summary: 'Get a certificate', description: 'With the PEM, the issuing chain and the certificates it issued.',
    params: idParam,
    responses: okRef('The certificate.', 'CertificateDetail'),
    handler: ({ d, params }) => detail(d, params.id),
  },
  {
    method: 'PATCH', path: '/certs/{id}', operationId: 'updateCert', tag: 'Certificates', scope: 'write',
    summary: 'Rename a certificate', params: idParam,
    body: { required: true, schema: S.obj({ name: S.str({ minLength: 1, maxLength: 200 }) }, ['name']), example: { name: 'Lab root 2026' } },
    responses: okRef('The certificate.', 'CertificateDetail'),
    handler: ({ d, params, body }) => {
      certOr404(d, params.id);
      d.pki.rename(params.id, body.name);
      d.bus.changed('certs');
      return detail(d, params.id);
    },
  },
  {
    method: 'DELETE', path: '/certs/{id}', operationId: 'deleteCert', tag: 'Certificates', scope: 'write',
    summary: 'Delete a certificate',
    description: 'Fails with 409 while it has issued certificates (delete those first) or while it is the only SAS server certificate (select another first). It is removed from the server-certificate and trusted-CA selections.',
    params: idParam,
    responses: noContentResp('Deleted.'),
    handler: async ({ d, params }) => {
      certOr404(d, params.id);
      const s = d.settings.get();
      if (d.db.get('SELECT 1 FROM certs WHERE parent_id = ?', params.id)) throw conflict('Certificate has issued children; delete those first');
      if (s.serverCertIds.length === 1 && s.serverCertIds[0] === params.id) throw conflict('This is the only SAS server certificate; select another one first (PUT /tls/server-certs)');
      const patch: Record<string, string[]> = {};
      if (s.serverCertIds.includes(params.id)) patch.serverCertIds = s.serverCertIds.filter((x) => x !== params.id);
      if (s.trustedClientCaIds.includes(params.id)) patch.trustedClientCaIds = s.trustedClientCaIds.filter((x) => x !== params.id);
      // Check the TLS change against the certificates that remain before deleting anything.
      if (Object.keys(patch).length) checkSettings(d, patch);
      d.pki.delete(params.id);
      if (Object.keys(patch).length) await applySettings(d, patch, 'Deleted certificate removed from the TLS configuration');
      d.bus.event('info', 'certs', `Certificate ${params.id} deleted`);
      d.bus.changed('certs');
      return noContent();
    },
  },
  {
    method: 'POST', path: '/certs/root', operationId: 'createRootCa', tag: 'Certificates', scope: 'write',
    summary: 'Create a root CA',
    body: { required: true, schema: S.obj({ ...dnProps(true), ...common('rsa4096') }, ['CN']), example: { CN: 'Lab Root CA', O: 'Lab', keyType: 'rsa4096' } },
    responses: { 201: { description: 'Created.', schema: ref('CertificateDetail') } },
    handler: ({ d, body }) => issued(d, d.pki.createRoot({ dn: dn(body), keyType: body.keyType as KeyType, days: body.days, name: body.name }).id),
  },
  {
    method: 'POST', path: '/certs/sub-ca', operationId: 'createSubCa', tag: 'Certificates', scope: 'write', errors: [404],
    summary: 'Create a subordinate CA',
    description: 'role: `sas` (issues SAS server certificates), `cbsd` (CBSD certificates), `operator` (domain-proxy certificates) or `installer` (CPI certificates); the WInnForum role OID is added.',
    body: { required: true, schema: S.obj({ parentId, role: S.enum(CA_ROLES), ...dnProps(true), ...common('rsa4096') }, ['parentId', 'role', 'CN']), example: { parentId: '<root id>', role: 'cbsd', CN: 'Lab CBSD CA' } },
    responses: { 201: { description: 'Created.', schema: ref('CertificateDetail') } },
    handler: ({ d, body }) => {
      issuer(d, body.parentId);
      return issued(d, d.pki.createSubCa({ parentId: body.parentId, role: body.role as CaRole, dn: dn(body), keyType: body.keyType, days: body.days, name: body.name }).id);
    },
  },
  {
    method: 'POST', path: '/certs/server', operationId: 'issueServerCert', tag: 'Certificates', scope: 'write', errors: [404],
    summary: 'Issue a SAS server certificate',
    description: '`use`: `add` presents it next to the current SAS server certificates, in place of the one with the same key type (RSA or ECDSA) if there is one, since the HTTPS listener presents at most one of each; `replace` makes it the only one. Either way the HTTPS listener restarts and the call returns when it is back. Without `use` the certificate is only stored.',
    body: {
      required: true,
      schema: S.obj({
        parentId, ...dnProps(true), ...common('rsa2048'),
        sans: S.arr(S.str({ minLength: 1 }), { description: 'DNS names and IP addresses (default: the CN).' }),
        frn: S.str({ description: 'FCC Registration Number for the subject.' }),
        use: S.enum(['add', 'replace']),
      }, ['parentId', 'CN']),
      example: { parentId: '<sas ca id>', CN: 'sas.lab', sans: ['sas.lab', 'localhost', '127.0.0.1'], use: 'add' },
    },
    responses: { 201: { description: 'Created.', schema: ref('CertificateDetail') } },
    handler: async ({ d, body }) => {
      issuer(d, body.parentId);
      const c = d.pki.issueServer({ parentId: body.parentId, dn: dn(body), sans: body.sans?.length ? body.sans : [body.CN], keyType: body.keyType, days: body.days, name: body.name, frn: body.frn });
      if (body.use) {
        const type = serverKeyType(d.pki.getRow(c.id)!.cert_pem);
        const others = d.settings.get().serverCertIds.filter((id) => {
          const row = d.pki.getRow(id);
          return row && serverKeyType(row.cert_pem) !== type;
        });
        await applySettings(d, { serverCertIds: body.use === 'replace' ? [c.id] : [...others, c.id] }, `SAS server certificate ${c.name} ${body.use === 'replace' ? 'selected' : 'added'}`);
      }
      return issued(d, c.id);
    },
  },
  {
    method: 'POST', path: '/certs/cbsd', operationId: 'issueCbsdCert', tag: 'Certificates', scope: 'write', errors: [404],
    summary: 'Issue a CBSD certificate',
    description: 'The subject carries the FCC ID and serial number as the WInnForum profile requires. `registerFccId` also adds the FCC ID to the registry.',
    body: {
      required: true,
      schema: S.obj({
        parentId, fccId: S.str({ minLength: 1, maxLength: 19 }), serial: S.str({ minLength: 1, maxLength: 64 }),
        CN: S.str({ maxLength: 64 }), O: S.str({ maxLength: 64 }), OU: S.str({ maxLength: 64 }), ...common('rsa2048'),
        registerFccId: S.bool({ default: false }),
      }, ['parentId', 'fccId', 'serial']),
      example: { parentId: '<cbsd ca id>', fccId: 'TEST-FCC', serial: 'SN-0001', registerFccId: true },
    },
    responses: { 201: { description: 'Created.', schema: ref('CertificateDetail') } },
    handler: ({ d, body }) => {
      issuer(d, body.parentId);
      const c = d.pki.issueCbsd({
        parentId: body.parentId, fccId: body.fccId, serial: body.serial, dn: { CN: body.CN || undefined, O: body.O || undefined, OU: body.OU || undefined },
        keyType: body.keyType, days: body.days, name: body.name,
      });
      if (body.registerFccId) d.admin.injectFccId(body.fccId, 47);
      return issued(d, c.id);
    },
  },
  {
    method: 'POST', path: '/certs/cbsd-batch', operationId: 'issueCbsdCertBatch', tag: 'Certificates', scope: 'write', errors: [404],
    summary: 'Issue CBSD certificates in bulk',
    description: 'Issues one certificate per device and returns a zip with a provisioning bundle per device (as format=bundle) plus devices.txt.',
    body: {
      required: true,
      schema: S.obj({
        parentId, devices: S.arr(S.obj({ fccId: S.str({ minLength: 1 }), serial: S.str({ minLength: 1 }) }, ['fccId', 'serial']), { minItems: 1, maxItems: 1000 }),
        keyType: S.enum(KEY_TYPES, { default: 'rsa2048' }), days: S.int({ minimum: 1, maximum: 36500 }),
        password: S.str({ minLength: 1, default: 'cbrs', description: 'PKCS#12 password.' }),
        registerFccIds: S.bool({ default: false }),
      }, ['parentId', 'devices']),
      example: { parentId: '<cbsd ca id>', devices: [{ fccId: 'TEST-FCC', serial: 'SN-0001' }, { fccId: 'TEST-FCC', serial: 'SN-0002' }] },
    },
    responses: fileResp('Zip of bundles.', 'application/zip'),
    handler: async (c) => {
      const { d, body } = c;
      issuer(d, body.parentId);
      const { zipSync, strToU8 } = await import('fflate');
      const s = d.settings.get();
      const files: Record<string, Uint8Array> = {};
      for (const dev of body.devices) {
        const cert = d.pki.issueCbsd({ parentId: body.parentId, fccId: dev.fccId, serial: dev.serial, keyType: body.keyType, days: body.days });
        files[`${safe(dev.fccId)}_${safe(dev.serial)}.zip`] = d.pki.radioBundle(cert.id, { password: body.password, serverCertId: s.serverCertIds[0] ?? null, sasUrls: sasUrls(s, d.hostnames) });
        if (body.registerFccIds) d.admin.injectFccId(dev.fccId, 47);
      }
      files['devices.txt'] = strToU8(body.devices.map((x: any) => `${x.fccId},${x.serial}`).join('\n') + '\n');
      d.bus.event('info', 'certs', `Issued ${body.devices.length} CBSD certificate(s)`);
      d.bus.changed('certs');
      return sendFile(c, Buffer.from(zipSync(files)), 'application/zip', `cbsd-certificates-${body.devices.length}.zip`);
    },
  },
  {
    method: 'POST', path: '/certs/domain-proxy', operationId: 'issueDomainProxyCert', tag: 'Certificates', scope: 'write', errors: [404],
    summary: 'Issue a domain-proxy certificate',
    body: { required: true, schema: S.obj({ parentId, ...dnProps(true), ...common('rsa2048'), frn: S.str() }, ['parentId', 'CN']), example: { parentId: '<operator ca id>', CN: 'Lab Domain Proxy', frn: '0123456789' } },
    responses: { 201: { description: 'Created.', schema: ref('CertificateDetail') } },
    handler: ({ d, body }) => {
      issuer(d, body.parentId);
      return issued(d, d.pki.issueDomainProxy({ parentId: body.parentId, dn: dn(body), frn: body.frn, keyType: body.keyType, days: body.days, name: body.name }).id);
    },
  },
  {
    method: 'POST', path: '/certs/installer', operationId: 'issueInstallerCert', tag: 'Certificates', scope: 'write', errors: [404],
    summary: 'Issue a CPI (installer) certificate',
    description: 'With `registerCpi` (default) the CPI is also added to the registry with the certificate\'s public key, so its signed installation data is accepted.',
    body: {
      required: true,
      schema: S.obj({
        parentId, cpiId: S.str({ minLength: 1 }), cpiName: S.str({ minLength: 1 }),
        keyType: S.enum(KEY_TYPES, { default: 'rsa2048' }), days: S.int({ minimum: 1, maximum: 36500 }), registerCpi: S.bool({ default: true }),
      }, ['parentId', 'cpiId', 'cpiName']),
      example: { parentId: '<installer ca id>', cpiId: 'CPI-0001', cpiName: 'Lab Installer' },
    },
    responses: { 201: { description: 'Created.', schema: ref('CertificateDetail') } },
    handler: ({ d, body }) => {
      issuer(d, body.parentId);
      const c = d.pki.issueInstaller({ parentId: body.parentId, cpiId: body.cpiId, cpiName: body.cpiName, keyType: body.keyType, days: body.days });
      if (body.registerCpi !== false) {
        const pub = new crypto.X509Certificate(d.pki.getRow(c.id)!.cert_pem).publicKey.export({ type: 'spki', format: 'pem' }) as string;
        d.admin.injectCpiUser(body.cpiId, body.cpiName, pub, 'api');
      }
      return issued(d, c.id);
    },
  },
  {
    method: 'POST', path: '/certs/import', operationId: 'importCerts', tag: 'Certificates', scope: 'write',
    summary: 'Import PEM certificates',
    description: 'One or more PEM certificates (e.g. a CA chain or the WInnForum harness CAs), optionally with the private key of the first. Imported CAs can then be trusted for client certificates (PUT /tls/trusted-cas).',
    body: {
      required: true,
      schema: S.obj({
        pem: S.str({ minLength: 1 }), keyPem: S.str({ description: 'Private key (PEM) for the first certificate.' }),
        passphrase: S.str({ description: 'Passphrase of an encrypted key.' }), name: S.str({ maxLength: 200 }),
      }, ['pem']),
      example: { pem: '-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----\n', name: 'Harness root' },
    },
    responses: { 201: { description: 'Imported.', schema: S.obj({ items: S.arr(ref('Certificate')) }, ['items']) } },
    handler: ({ d, body }) => {
      const out = d.pki.importPem({ pem: body.pem, keyPem: body.keyPem || undefined, name: body.name || undefined, passphrase: body.passphrase || undefined });
      d.bus.event('info', 'certs', `Imported ${out.length} certificate(s)`);
      d.bus.changed('certs');
      return created({ items: out.map((c) => certOut(c, d.settings.get())) });
    },
  },
  {
    method: 'POST', path: '/certs/import-p12', operationId: 'importPkcs12', tag: 'Certificates', scope: 'write',
    summary: 'Import a PKCS#12 file',
    body: {
      required: true,
      schema: S.obj({ data: S.str({ minLength: 1, contentEncoding: 'base64', description: 'The .p12/.pfx file, base64.' }), password: S.str({ default: '' }), name: S.str({ maxLength: 200 }) }, ['data']),
      example: { data: 'MIIK…', password: 'cbrs' },
    },
    responses: { 201: { description: 'Imported.', schema: S.obj({ items: S.arr(ref('Certificate')) }, ['items']) } },
    handler: ({ d, body }) => {
      const out = d.pki.importPkcs12(Buffer.from(body.data, 'base64'), body.password ?? '', body.name);
      d.bus.event('info', 'certs', `Imported ${out.length} certificate(s) from PKCS#12`);
      d.bus.changed('certs');
      return created({ items: out.map((c) => certOut(c, d.settings.get())) });
    },
  },
  {
    method: 'POST', path: '/certs/{id}/revoke', operationId: 'revokeCert', tag: 'Certificates', scope: 'write',
    summary: 'Revoke a certificate',
    description: 'Marks it revoked in the store. The SAS refuses TLS clients presenting it (or a certificate it issued) when tlsCheckCrl is on, and it appears in the CRL its CA generates.',
    params: idParam,
    responses: okRef('The certificate.', 'CertificateDetail'),
    handler: ({ d, params }) => {
      const c = certOr404(d, params.id);
      d.pki.revoke(params.id, true);
      d.bus.event('warn', 'certs', `Certificate ${c.name} revoked`);
      d.bus.changed('certs');
      return detail(d, params.id);
    },
  },
  {
    method: 'POST', path: '/certs/{id}/unrevoke', operationId: 'unrevokeCert', tag: 'Certificates', scope: 'write',
    summary: 'Clear a revocation', params: idParam,
    responses: okRef('The certificate.', 'CertificateDetail'),
    handler: ({ d, params }) => {
      const c = certOr404(d, params.id);
      d.pki.revoke(params.id, false);
      d.bus.event('warn', 'certs', `Certificate ${c.name} un-revoked`);
      d.bus.changed('certs');
      return detail(d, params.id);
    },
  },
  {
    method: 'GET', path: '/certs/{id}/download', operationId: 'downloadCert', tag: 'Certificates', scope: 'read',
    summary: 'Download a certificate',
    description: `Formats:\n\n${DOWNLOAD_FORMATS.map((f) => `- \`${f.format}\`: ${f.description}${f.key ? ' Contains the private key: needs write access.' : ''}`).join('\n')}`,
    params: idParam,
    query: {
      format: { description: 'File format.', schema: S.enum(DOWNLOAD_FORMATS.map((f) => f.format), { default: 'pem' }) },
      password: { description: 'Password for p12, p12-legacy and bundle.', schema: S.str({ minLength: 1, default: 'cbrs' }) },
    },
    responses: fileResp('The file.', 'application/octet-stream'),
    handler: download,
  },

  // ---------------------------------------------------------------- TLS configuration
  {
    method: 'GET', path: '/tls', operationId: 'getTls', tag: 'TLS', scope: 'read',
    summary: 'SAS TLS configuration',
    description: 'The server certificates presented on the HTTPS listener, the CAs trusted for client certificates (an empty list trusts every CA in the store), the TLS policy settings and the live listener state.',
    responses: okRef('TLS configuration.', 'Tls'),
    handler: ({ d }) => tlsOf(d),
  },
  {
    method: 'PUT', path: '/tls/server-certs', operationId: 'setServerCerts', tag: 'TLS', scope: 'write',
    summary: 'Select the SAS server certificates',
    description: 'At most one per key type (e.g. an RSA and an ECDSA certificate): the listener cannot present two of the same type. Each needs a private key. The HTTPS listener restarts; the call returns when it is back.',
    body: { required: true, schema: S.obj({ ids: S.arr(S.str({ minLength: 1 }), { minItems: 1 }) }, ['ids']), example: { ids: ['<server cert id>'] } },
    responses: okRef('TLS configuration.', 'Tls'),
    handler: async ({ d, body }) => {
      await applySettings(d, { serverCertIds: body.ids }, `SAS HTTPS server certificate(s) set to ${body.ids.map((i: string) => d.pki.getRow(i)?.name ?? i).join(', ')}`);
      return tlsOf(d);
    },
  },
  {
    method: 'PUT', path: '/tls/trusted-cas', operationId: 'setTrustedClientCas', tag: 'TLS', scope: 'write',
    summary: 'Select the CAs trusted for client certificates',
    description: 'An empty list trusts every CA certificate in the store. The HTTPS listener restarts; the call returns when it is back.',
    body: { required: true, schema: S.obj({ ids: S.arr(S.str({ minLength: 1 })) }, ['ids']), example: { ids: ['<harness root id>'] } },
    responses: okRef('TLS configuration.', 'Tls'),
    handler: async ({ d, body }) => {
      await applySettings(d, { trustedClientCaIds: body.ids }, `Trusted client CAs set to ${body.ids.length ? body.ids.map((i: string) => d.pki.getRow(i)?.name ?? i).join(', ') : 'every CA in the store'}`);
      return tlsOf(d);
    },
  },
  {
    method: 'GET', path: '/trust-bundle', operationId: 'downloadTrustBundle', tag: 'TLS', scope: 'read',
    summary: 'Download the CA trust bundle',
    description: 'CA certificates in one PEM file, for a CBSD or harness trust store. `which=roots`: self-signed CAs only.',
    query: { which: { description: 'all or roots.', schema: S.enum(['all', 'roots'], { default: 'all' }) } },
    responses: fileResp('PEM bundle.', 'application/x-pem-file'),
    handler: (c) => {
      const rows = c.d.pki.caCerts().filter((r) => {
        if (c.query.which === 'all') return true;
        const x = new crypto.X509Certificate(r.cert_pem);
        return r.kind === 'root' || (r.kind === 'trusted' && x.subject === x.issuer);
      });
      return sendFile(c, rows.map((r) => r.cert_pem).join(''), 'application/x-pem-file', c.query.which === 'roots' ? 'sas-root-bundle.pem' : 'sas-ca-bundle.pem');
    },
  },

  // ---------------------------------------------------------------- CRLs
  {
    method: 'GET', path: '/crls', operationId: 'listCrls', tag: 'CRLs', scope: 'read',
    summary: 'List imported CRLs',
    description: 'CRLs imported from trusted CAs (e.g. the harness certs/crl files). With tlsCheckCrl on, client certificates whose serial a CRL lists are refused.',
    query: pageQuery(),
    responses: ok('A page of CRLs.', pageOf('Crl')),
    handler: ({ d, query }) => page(d.pki.listCrls().map(crlOut), query),
  },
  {
    method: 'POST', path: '/crls', operationId: 'importCrls', tag: 'CRLs', scope: 'write',
    summary: 'Import CRLs',
    description: 'PEM or DER, base64-encoded. Re-importing the same CRL replaces it.',
    body: {
      required: true,
      schema: S.obj({
        files: S.arr(S.obj({ data: S.str({ minLength: 1, contentEncoding: 'base64' }), name: S.str({ maxLength: 200 }) }, ['data']), { minItems: 1 }),
      }, ['files']),
      example: { files: [{ name: 'harness root CRL', data: 'LS0tLS1CRUdJTiBYNTA5IENSTC0tLS0t…' }] },
    },
    responses: { 201: { description: 'Imported.', schema: S.obj({ items: S.arr(ref('Crl')) }, ['items']) } },
    handler: ({ d, body }) => {
      const ids = body.files.map((f: any) => d.pki.importCrl(Buffer.from(f.data, 'base64'), f.name).id);
      d.bus.event('info', 'certs', `Imported ${ids.length} CRL(s)`);
      d.bus.changed('certs');
      return created({ items: ids.map((id: string) => crlFull(d, id)) });
    },
  },
  {
    method: 'GET', path: '/crls/{id}', operationId: 'getCrl', tag: 'CRLs', scope: 'read',
    summary: 'Get a CRL', description: 'With every revoked serial number.',
    params: { id: { description: 'CRL id.' } },
    responses: okRef('The CRL.', 'Crl'),
    handler: ({ d, params }) => crlFull(d, params.id),
  },
  {
    method: 'GET', path: '/crls/{id}/download', operationId: 'downloadCrl', tag: 'CRLs', scope: 'read',
    summary: 'Download a CRL (PEM)',
    params: { id: { description: 'CRL id.' } },
    responses: fileResp('PEM CRL.', 'application/x-pem-file'),
    handler: (c) => {
      const r = c.d.db.get('SELECT name, crl_pem FROM crls WHERE id = ?', c.params.id);
      if (!r) throw notFound('CRL');
      return sendFile(c, r.crl_pem, 'application/x-pem-file', `${safe(r.name)}.crl.pem`);
    },
  },
  {
    method: 'DELETE', path: '/crls/{id}', operationId: 'deleteCrl', tag: 'CRLs', scope: 'write',
    summary: 'Delete a CRL',
    params: { id: { description: 'CRL id.' } },
    responses: noContentResp('Deleted.'),
    handler: ({ d, params }) => {
      if (!d.db.get('SELECT 1 FROM crls WHERE id = ?', params.id)) throw notFound('CRL');
      d.pki.deleteCrl(params.id);
      d.bus.changed('certs');
      return noContent();
    },
  },

  // ---------------------------------------------------------------- CPI signing
  {
    method: 'POST', path: '/cpi/sign', operationId: 'signCpiData', tag: 'Certificates', scope: 'write', errors: [404],
    summary: 'Sign installation data as a CPI',
    description: 'Produces the `cpiSignatureData` a Category B registration carries: a JWS over the FCC ID, serial number, installation parameters and professional-installer data, signed with an installer certificate\'s key from the store (`installerCertId`; its CPI id and name are used when not given) or with `privateKeyPem`.',
    body: {
      required: true,
      schema: S.obj({
        fccId: S.str({ minLength: 1 }), cbsdSerialNumber: S.str({ minLength: 1 }), installationParam: S.anyObj(),
        installerCertId: S.str({ minLength: 1 }), privateKeyPem: S.str({ minLength: 1 }), cpiId: S.str({ minLength: 1 }), cpiName: S.str({ minLength: 1 }),
      }, ['fccId', 'cbsdSerialNumber', 'installationParam']),
      example: { installerCertId: '<installer cert id>', fccId: 'TEST-FCC', cbsdSerialNumber: 'SN-0002', installationParam: { latitude: 37.4, longitude: -122.1, height: 10, heightType: 'AGL', indoorDeployment: false, antennaGain: 15, eirpCapability: 40 } },
    },
    responses: ok('Signature.', S.obj({ cpiSignatureData: S.anyObj(), signedData: S.anyObj() }, ['cpiSignatureData', 'signedData'])),
    handler: ({ d, body }) => {
      let keyPem: string | undefined = body.privateKeyPem;
      let cpiId: string | undefined = body.cpiId;
      let cpiName: string | undefined = body.cpiName;
      if (body.installerCertId) {
        const row = d.pki.getRow(body.installerCertId);
        if (!row) throw notFound('Installer certificate');
        if (!row.key_pem) throw badRequest('The installer certificate has no private key');
        keyPem = row.key_pem;
        const meta = jparse<any>(row.meta, {});
        cpiId ||= meta.cpiId;
        cpiName ||= meta.cpiName;
      }
      if (!keyPem) throw badRequest('installerCertId or privateKeyPem is required');
      if (!cpiId || !cpiName) throw badRequest('cpiId and cpiName are required (or use an installer certificate that carries them)');
      const data = {
        fccId: body.fccId, cbsdSerialNumber: body.cbsdSerialNumber, installationParam: body.installationParam,
        professionalInstallerData: { cpiId, cpiName, installCertificationTime: toRfc3339(Date.now()) },
      };
      return { cpiSignatureData: signCpiData(data, keyPem), signedData: data };
    },
  },
];
