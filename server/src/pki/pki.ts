import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { zipSync, strToU8 } from 'fflate';
import type { Db, Row } from '../db.ts';
import { jparse } from '../db.ts';
import { summarizeCert, splitPemCerts, extractPrivateKeyPem, WINNF_OID } from './x509.ts';

// Lab PKI modelled on the CBRS PKI (WINNF-TS-0065 §5.2) and the WInnForum example
// OpenSSL profiles (Spectrum-Access-System/cert/openssl.cnf):
//
//   Root CA ─┬─ SAS CA ─────────── SAS server certificate (ROLE_SAS, serverAuth+clientAuth)
//            ├─ CBSD CA ────────── CBSD device certificates (ROLE_CBSD, FCCID/SERIAL otherNames)
//            ├─ Domain Proxy CA ── Domain proxy certificates (ROLE_OPERATOR)
//            └─ Installer CA ───── CPI certificates (ROLE_INSTALLER, CPIRID) for cpiSignatureData

/** Organization of the certificates the lab PKI issues. Existing PKIs keep the names they were made with. */
const PKI_ORG = 'SASBench';

export type KeyType = 'rsa2048' | 'rsa3072' | 'rsa4096' | 'ec256' | 'ec384';
export type CaRole = 'sas' | 'cbsd' | 'operator' | 'installer';
export type CertKind = 'root' | 'sub_ca' | 'server' | 'cbsd' | 'domain_proxy' | 'installer' | 'trusted' | 'imported';

const ROLE_OID = {
  sas: '1.3.6.1.4.1.46609.1.1.1',
  installer: '1.3.6.1.4.1.46609.1.1.2',
  cbsd: '1.3.6.1.4.1.46609.1.1.3',
  operator: '1.3.6.1.4.1.46609.1.1.4',
  ca: '1.3.6.1.4.1.46609.1.1.5',
};

export interface DnInput {
  CN: string;
  O?: string;
  OU?: string;
  L?: string;
  ST?: string;
  C?: string;
}

export interface CertRecord {
  id: string;
  kind: CertKind;
  role: string | null;
  name: string;
  parentId: string | null;
  subject: string;
  issuer: string;
  serial: string;
  notBefore: number;
  notAfter: number;
  fingerprint: string;
  keyType: string;
  hasKey: boolean;
  isCa: boolean;
  meta: Record<string, any>;
  revokedAt: number | null;
  createdAt: number;
  details: ReturnType<typeof summarizeCert>;
}

export class Pki {
  private db: Db;
  private workDir: string;

  constructor(db: Db, workDir: string) {
    this.db = db;
    this.workDir = workDir;
    fs.mkdirSync(workDir, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  list(): CertRecord[] {
    return this.db.all('SELECT * FROM certs ORDER BY created_at').map((r) => this.toRecord(r));
  }

  getRow(id: string): Row | undefined {
    return this.db.get('SELECT * FROM certs WHERE id = ?', id);
  }

  get(id: string): CertRecord | null {
    const r = this.getRow(id);
    return r ? this.toRecord(r) : null;
  }

  toRecord(r: Row): CertRecord {
    const details = summarizeCert(r.cert_pem);
    return {
      id: r.id, kind: r.kind, role: r.role, name: r.name, parentId: r.parent_id, subject: r.subject,
      issuer: r.issuer, serial: r.serial, notBefore: r.not_before, notAfter: r.not_after,
      fingerprint: r.fingerprint, keyType: r.key_type, hasKey: !!r.key_pem, isCa: details.isCa,
      meta: jparse(r.meta, {}), revokedAt: r.revoked_at ?? null, createdAt: r.created_at, details,
    };
  }

  /** Every CA certificate in the store (generated or uploaded). */
  caCerts(): Row[] {
    return this.db.all("SELECT * FROM certs WHERE kind IN ('root','sub_ca','trusted') ORDER BY created_at");
  }

  /** Issuer chain (excluding the cert itself), nearest issuer first. */
  chainOf(id: string): Row[] {
    const out: Row[] = [];
    let cur = this.getRow(id);
    const seen = new Set<string>();
    while (cur?.parent_id && !seen.has(cur.parent_id)) {
      seen.add(cur.parent_id);
      const p = this.getRow(cur.parent_id);
      if (!p) break;
      out.push(p);
      cur = p;
    }
    return out;
  }

  rootOf(id: string): Row | undefined {
    const chain = this.chainOf(id);
    return chain.length ? chain[chain.length - 1] : this.getRow(id);
  }

  findCa(kind: 'root' | CaRole): Row | undefined {
    if (kind === 'root') return this.db.get("SELECT * FROM certs WHERE kind='root' AND key_pem IS NOT NULL ORDER BY created_at LIMIT 1");
    return this.db.get("SELECT * FROM certs WHERE kind='sub_ca' AND role=? AND key_pem IS NOT NULL ORDER BY created_at LIMIT 1", kind);
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  createRoot(opts: { dn: DnInput; keyType?: KeyType; days?: number; name?: string }): CertRecord {
    const keyType = opts.keyType ?? 'rsa4096';
    const key = genKey(keyType);
    const ext = [
      'subjectKeyIdentifier = hash',
      'authorityKeyIdentifier = keyid:always',
      'basicConstraints = critical, CA:true',
      'keyUsage = critical, digitalSignature, cRLSign, keyCertSign',
      `certificatePolicies = ${ROLE_OID.ca}`,
    ];
    const pem = this.withTmp((dir) => {
      write(dir, 'key.pem', key);
      write(dir, 'req.cnf', reqConfig(opts.dn, ext));
      openssl(dir, ['req', '-new', '-x509', '-key', 'key.pem', '-config', 'req.cnf', '-extensions', 'ext',
        '-days', String(opts.days ?? 7300), digestFor(keyType, true), '-set_serial', randSerial(), '-out', 'cert.pem']);
      return read(dir, 'cert.pem');
    });
    return this.store({ kind: 'root', role: 'ca', name: opts.name ?? opts.dn.CN, parentId: null, certPem: pem, keyPem: key, keyType });
  }

  createSubCa(opts: { parentId: string; role: CaRole; dn: DnInput; keyType?: KeyType; days?: number; name?: string }): CertRecord {
    const keyType = opts.keyType ?? 'rsa4096';
    const pathlen = opts.role === 'cbsd' ? 1 : 0; // CBSD CA may sign OEM sub-CAs (WInnForum cbsd_ca_sign)
    return this.issue({
      parentId: opts.parentId, kind: 'sub_ca', role: opts.role, name: opts.name ?? opts.dn.CN, dn: opts.dn, keyType,
      days: opts.days ?? 5475, caDigest: true,
      ext: [
        'subjectKeyIdentifier = hash',
        'authorityKeyIdentifier = keyid:always, issuer',
        `basicConstraints = critical, CA:true, pathlen:${pathlen}`,
        'keyUsage = critical, digitalSignature, cRLSign, keyCertSign',
        `certificatePolicies = ${ROLE_OID.ca}, ${ROLE_OID[opts.role]}`,
      ],
    });
  }

  issueServer(opts: { parentId: string; dn: DnInput; sans: string[]; keyType?: KeyType; days?: number; name?: string; frn?: string }): CertRecord {
    const alt = sanLines(opts.sans);
    if (opts.frn) alt.push(`otherName.${alt.length + 1} = ${WINNF_OID.FRN};UTF8:${opts.frn}`);
    return this.issue({
      parentId: opts.parentId, kind: 'server', role: 'sas', name: opts.name ?? opts.dn.CN, dn: opts.dn,
      keyType: opts.keyType ?? 'rsa2048', days: opts.days ?? 825, alt,
      meta: { sans: opts.sans, frn: opts.frn ?? null },
      ext: [
        'subjectKeyIdentifier = hash',
        'authorityKeyIdentifier = keyid:always, issuer',
        'basicConstraints = CA:FALSE',
        (opts.keyType ?? 'rsa2048').startsWith('ec') ? 'keyUsage = critical, digitalSignature' : 'keyUsage = critical, digitalSignature, keyEncipherment',
        'extendedKeyUsage = serverAuth, clientAuth',
        `certificatePolicies = ${ROLE_OID.sas}`,
      ],
    });
  }

  issueCbsd(opts: { parentId: string; fccId: string; serial: string; dn?: Partial<DnInput>; keyType?: KeyType; days?: number; name?: string }): CertRecord {
    const dn: DnInput = { O: PKI_ORG, ...opts.dn, CN: opts.dn?.CN || `${opts.fccId}:${opts.serial}` };
    return this.issue({
      parentId: opts.parentId, kind: 'cbsd', role: 'cbsd', name: opts.name ?? `${opts.fccId} / ${opts.serial}`, dn,
      keyType: opts.keyType ?? 'rsa2048', days: opts.days ?? 3650,
      alt: [`otherName.1 = ${WINNF_OID.FCCID};UTF8:${opts.fccId}`, `otherName.2 = ${WINNF_OID.SERIAL};UTF8:${opts.serial}`],
      meta: { fccId: opts.fccId, serial: opts.serial },
      ext: [
        'subjectKeyIdentifier = hash',
        'authorityKeyIdentifier = keyid:always, issuer',
        'basicConstraints = CA:FALSE',
        'keyUsage = critical, digitalSignature, keyEncipherment',
        'extendedKeyUsage = clientAuth',
        `certificatePolicies = ${ROLE_OID.cbsd}`,
      ],
    });
  }

  issueDomainProxy(opts: { parentId: string; dn: DnInput; frn?: string; keyType?: KeyType; days?: number; name?: string }): CertRecord {
    const alt = opts.frn ? [`otherName.1 = ${WINNF_OID.FRN};UTF8:${opts.frn}`] : [];
    return this.issue({
      parentId: opts.parentId, kind: 'domain_proxy', role: 'operator', name: opts.name ?? opts.dn.CN, dn: opts.dn,
      keyType: opts.keyType ?? 'rsa2048', days: opts.days ?? 1825, alt, meta: { frn: opts.frn ?? null },
      ext: [
        'subjectKeyIdentifier = hash',
        'authorityKeyIdentifier = keyid:always, issuer',
        'basicConstraints = CA:FALSE',
        'keyUsage = critical, digitalSignature, keyEncipherment',
        'extendedKeyUsage = clientAuth',
        `certificatePolicies = ${ROLE_OID.operator}`,
      ],
    });
  }

  issueInstaller(opts: { parentId: string; cpiId: string; cpiName: string; keyType?: KeyType; days?: number }): CertRecord {
    return this.issue({
      parentId: opts.parentId, kind: 'installer', role: 'installer', name: `CPI ${opts.cpiName} (${opts.cpiId})`,
      dn: { CN: opts.cpiName, O: `${PKI_ORG} CPI` }, keyType: opts.keyType ?? 'rsa2048', days: opts.days ?? 1825,
      alt: [`otherName.1 = ${WINNF_OID.CPIRID};UTF8:${opts.cpiId}`], meta: { cpiId: opts.cpiId, cpiName: opts.cpiName },
      ext: [
        'subjectKeyIdentifier = hash',
        'authorityKeyIdentifier = keyid:always, issuer',
        'basicConstraints = CA:FALSE',
        'keyUsage = critical, digitalSignature, nonRepudiation',
        `certificatePolicies = ${ROLE_OID.installer}`,
      ],
    });
  }

  private issue(o: {
    parentId: string; kind: CertKind; role: string; name: string; dn: DnInput; keyType: KeyType; days: number;
    ext: string[]; alt?: string[]; meta?: Record<string, any>; caDigest?: boolean;
  }): CertRecord {
    const parent = this.getRow(o.parentId);
    if (!parent) throw new Error('Issuing CA not found');
    if (!parent.key_pem) throw new Error('Issuing CA has no private key');
    if (!summarizeCert(parent.cert_pem).isCa) throw new Error('Selected issuer is not a CA certificate');
    const key = genKey(o.keyType);
    const ext = [...o.ext];
    if (o.alt?.length) ext.push('subjectAltName = @alt');
    const pem = this.withTmp((dir) => {
      write(dir, 'key.pem', key);
      write(dir, 'ca.pem', parent.cert_pem);
      write(dir, 'cakey.pem', parent.key_pem);
      write(dir, 'req.cnf', reqConfig(o.dn, ext, o.alt));
      openssl(dir, ['req', '-new', '-key', 'key.pem', '-config', 'req.cnf', '-out', 'req.csr']);
      openssl(dir, ['x509', '-req', '-in', 'req.csr', '-CA', 'ca.pem', '-CAkey', 'cakey.pem', '-set_serial', randSerial(),
        '-days', String(o.days), digestFor(o.keyType, !!o.caDigest), '-extfile', 'req.cnf', '-extensions', 'ext', '-out', 'cert.pem']);
      return read(dir, 'cert.pem');
    });
    return this.store({ kind: o.kind, role: o.role, name: o.name, parentId: o.parentId, certPem: pem, keyPem: key, keyType: o.keyType, meta: o.meta });
  }

  /**
   * Import PEM material: one or more certificates, optionally a private key.
   * CA certificates without a key become trusted anchors; a leaf with a key becomes an
   * importable server/client identity.
   */
  importPem(opts: { pem: string; keyPem?: string; name?: string; passphrase?: string }): CertRecord[] {
    let certs = splitPemCerts(opts.pem);
    if (!certs.length) {
      // maybe DER base64 without armor
      try {
        const x = new crypto.X509Certificate(Buffer.from(opts.pem.trim(), 'base64'));
        certs = [x.toString()];
      } catch {
        throw new Error('No PEM certificates found');
      }
    }
    let keyPem = opts.keyPem ? extractPrivateKeyPem(opts.keyPem) ?? opts.keyPem : extractPrivateKeyPem(opts.pem);
    if (keyPem) {
      const k = crypto.createPrivateKey({ key: keyPem, passphrase: opts.passphrase });
      keyPem = k.export({ type: 'pkcs8', format: 'pem' }) as string;
    }
    const out: CertRecord[] = [];
    const leafX = new crypto.X509Certificate(certs[0]);
    let leafHasKey = false;
    if (keyPem) {
      leafHasKey = leafX.checkPrivateKey(crypto.createPrivateKey(keyPem));
      if (!leafHasKey) throw new Error('Private key does not match the first certificate in the bundle');
    }
    certs.forEach((c, i) => {
      const x = new crypto.X509Certificate(c);
      const existing = this.db.get('SELECT id FROM certs WHERE fingerprint = ?', x.fingerprint256);
      if (existing) {
        if (i === 0 && leafHasKey) this.db.run('UPDATE certs SET key_pem = ? WHERE id = ? AND key_pem IS NULL', keyPem, existing.id);
        out.push(this.get(existing.id)!);
        return;
      }
      const s = summarizeCert(x);
      const isLeafWithKey = i === 0 && leafHasKey;
      const kind: CertKind = s.isCa ? (isLeafWithKey && s.selfSigned ? 'root' : isLeafWithKey ? 'sub_ca' : 'trusted') : 'imported';
      out.push(this.store({
        kind, role: s.roles.includes('SAS') ? 'sas' : s.roles[0]?.toLowerCase() ?? null,
        name: (i === 0 && opts.name) || s.commonName || s.subject, parentId: null, certPem: c,
        keyPem: isLeafWithKey ? keyPem! : null, keyType: s.keyType, meta: { imported: true },
      }));
    });
    this.relinkParents();
    return out;
  }

  /** Import a PKCS#12 file (certificate, key and chain). */
  importPkcs12(data: Buffer, password: string, name?: string): CertRecord[] {
    const pem = this.withTmp((dir) => {
      fs.writeFileSync(path.join(dir, 'in.p12'), data);
      const args = ['pkcs12', '-in', 'in.p12', '-nodes', '-passin', `pass:${password}`];
      try {
        return opensslOut(dir, args);
      } catch {
        return opensslOut(dir, [...args, '-legacy']);
      }
    });
    // openssl prints the leaf first when a key is present; put the cert matching the key first.
    const certs = splitPemCerts(pem);
    const key = extractPrivateKeyPem(pem);
    if (key) {
      const k = crypto.createPrivateKey(key);
      certs.sort((a, b) => Number(new crypto.X509Certificate(b).checkPrivateKey(k)) - Number(new crypto.X509Certificate(a).checkPrivateKey(k)));
    }
    return this.importPem({ pem: certs.join(''), keyPem: key ?? undefined, name });
  }

  /** Link imported certificates to issuers present in the store. */
  relinkParents() {
    const rows = this.db.all('SELECT id, cert_pem, parent_id FROM certs');
    const xs = rows.map((r) => ({ id: r.id, parent: r.parent_id, x: new crypto.X509Certificate(r.cert_pem) }));
    for (const c of xs) {
      if (c.parent) continue;
      if (c.x.subject === c.x.issuer) continue;
      const issuer = xs.find((p) => p.id !== c.id && p.x.ca && c.x.checkIssued(p.x) && safeVerify(c.x, p.x));
      if (issuer) this.db.run('UPDATE certs SET parent_id = ? WHERE id = ?', issuer.id, c.id);
    }
  }

  rename(id: string, name: string) {
    this.db.run('UPDATE certs SET name = ? WHERE id = ?', name, id);
  }

  delete(id: string) {
    const kids = this.db.get('SELECT COUNT(*) AS n FROM certs WHERE parent_id = ?', id);
    if (kids && kids.n > 0) throw new Error('Certificate has issued children; delete those first');
    this.db.run('DELETE FROM certs WHERE id = ?', id);
  }

  revoke(id: string, revoked: boolean) {
    this.db.run('UPDATE certs SET revoked_at = ? WHERE id = ?', revoked ? Date.now() : null, id);
  }

  private store(o: { kind: CertKind; role: string | null; name: string; parentId: string | null; certPem: string; keyPem: string | null; keyType: string; meta?: Record<string, any> }): CertRecord {
    const s = summarizeCert(o.certPem);
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO certs(id, kind, role, name, parent_id, subject, issuer, serial, not_before, not_after, fingerprint, key_type,
        cert_pem, key_pem, meta, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, o.kind, o.role, o.name, o.parentId, s.subject, s.issuer, s.serial, s.notBefore, s.notAfter, s.fingerprint256,
      o.keyType, o.certPem, o.keyPem, JSON.stringify(o.meta ?? {}), Date.now());
    return this.get(id)!;
  }

  // -------------------------------------------------------------------------
  // CRLs
  // -------------------------------------------------------------------------

  /** Generate a CRL for a CA we hold the key for (revoked children listed). */
  crlFor(caId: string): string | null {
    const ca = this.getRow(caId);
    if (!ca?.key_pem) return null;
    const revoked = this.db.all('SELECT serial, not_after, revoked_at, subject FROM certs WHERE parent_id = ? AND revoked_at IS NOT NULL', caId);
    return this.withTmp((dir) => {
      write(dir, 'ca.pem', ca.cert_pem);
      write(dir, 'cakey.pem', ca.key_pem);
      write(dir, 'index.txt', revoked.map((r) =>
        ['R', asn1Time(r.not_after), asn1Time(r.revoked_at), r.serial.toUpperCase(), 'unknown', '/CN=' + r.subject.replace(/[\t\n]/g, ' ')].join('\t') + '\n').join(''));
      write(dir, 'crlnumber', Date.now().toString(16).toUpperCase().padStart(16, '0') + '\n');
      write(dir, 'ca.cnf', [
        '[ ca ]', 'default_ca = lab', '[ lab ]', `dir = ${dir}`, 'database = $dir/index.txt', 'crlnumber = $dir/crlnumber',
        'default_md = sha256', 'default_crl_days = 30', 'unique_subject = no', 'crl_extensions = crl_ext',
        '[ crl_ext ]', 'authorityKeyIdentifier = keyid:always',
      ].join('\n') + '\n');
      openssl(dir, ['ca', '-gencrl', '-config', 'ca.cnf', '-cert', 'ca.pem', '-keyfile', 'cakey.pem', '-out', 'crl.pem']);
      return read(dir, 'crl.pem');
    });
  }

  isRevoked(fingerprint: string): boolean {
    const r = this.db.get('SELECT revoked_at FROM certs WHERE fingerprint = ?', fingerprint);
    return !!r?.revoked_at;
  }

  /** Import a CRL (PEM or DER) published by a trusted CA, e.g. the WInnForum harness certs/crl/*.crl. */
  importCrl(data: Buffer | string, name?: string): { id: string; issuer: string; revoked: number; nextUpdate: number | null } {
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    const isPem = buf.toString('latin1').includes('-----BEGIN X509 CRL-----');
    const out = this.withTmp((dir) => {
      fs.writeFileSync(path.join(dir, 'in.crl'), buf);
      const form = isPem ? 'PEM' : 'DER';
      const text = opensslOut(dir, ['crl', '-in', 'in.crl', '-inform', form, '-noout', '-text', '-nameopt', 'oneline']);
      const hash = opensslOut(dir, ['crl', '-in', 'in.crl', '-inform', form, '-noout', '-hash']).trim();
      const pem = opensslOut(dir, ['crl', '-in', 'in.crl', '-inform', form, '-outform', 'PEM']);
      return { text, hash, pem };
    });
    const issuer = /Issuer:\s*(.+)/.exec(out.text)?.[1]?.trim() ?? 'unknown';
    const last = Date.parse(/Last Update:\s*(.+)/.exec(out.text)?.[1] ?? '');
    const next = Date.parse(/Next Update:\s*(.+)/.exec(out.text)?.[1] ?? '');
    const serials = [...out.text.matchAll(/Serial Number:\s*([0-9A-Fa-f]+)/g)].map((m) => normSerial(m[1]));
    const existing = this.db.get('SELECT id FROM crls WHERE issuer = ? AND crl_pem = ?', out.hash, out.pem);
    const id = existing?.id ?? crypto.randomUUID();
    this.db.run(`INSERT OR REPLACE INTO crls(id, issuer, crl_pem, this_update, next_update, revoked, name, created_at)
      VALUES (?,?,?,?,?,?,?,?)`, id, out.hash, out.pem, Number.isFinite(last) ? last : null, Number.isFinite(next) ? next : null,
      JSON.stringify(serials), name ?? issuer, Date.now());
    this.crlIndex = null;
    return { id, issuer, revoked: serials.length, nextUpdate: Number.isFinite(next) ? next : null };
  }

  listCrls(): Array<{ id: string; name: string; issuerHash: string; thisUpdate: number | null; nextUpdate: number | null; revoked: string[] }> {
    return this.db.all('SELECT * FROM crls ORDER BY created_at').map((r) => ({
      id: r.id, name: r.name, issuerHash: r.issuer, thisUpdate: r.this_update, nextUpdate: r.next_update, revoked: jparse(r.revoked, []),
    }));
  }

  deleteCrl(id: string) {
    this.db.run('DELETE FROM crls WHERE id = ?', id);
    this.crlIndex = null;
  }

  private crlIndex: Map<string, Set<string>> | null = null;
  private hashCache = new Map<string, string>();

  /** OpenSSL subject-name hash of a certificate (matches `openssl crl -hash` of CRLs it issues). */
  subjectHash(x: crypto.X509Certificate): string {
    const fp = x.fingerprint256;
    let h = this.hashCache.get(fp);
    if (!h) {
      h = this.withTmp((dir) => {
        fs.writeFileSync(path.join(dir, 'c.pem'), x.toString());
        return opensslOut(dir, ['x509', '-in', 'c.pem', '-noout', '-subject_hash']).trim();
      });
      this.hashCache.set(fp, h);
    }
    return h;
  }

  /**
   * Revocation check over a client certificate chain (leaf first, ending at the trust anchor):
   * local PKI revocations by fingerprint and imported CRLs of each issuer (CRL_CHECK_ALL semantics,
   * but a CA without a CRL is not an error). Returns a reason when revoked.
   */
  revokedInChain(chain: crypto.X509Certificate[]): string | null {
    if (!this.crlIndex) {
      this.crlIndex = new Map();
      for (const r of this.db.all('SELECT issuer, revoked FROM crls')) {
        const set = this.crlIndex.get(r.issuer) ?? new Set<string>();
        for (const sn of jparse<string[]>(r.revoked, [])) set.add(sn);
        this.crlIndex.set(r.issuer, set);
      }
    }
    for (let i = 0; i < chain.length; i++) {
      const c = chain[i];
      if (this.isRevoked(c.fingerprint256)) return `certificate ${oneLine(c.subject)} revoked in the local PKI`;
      const issuer = chain[i + 1];
      if (!issuer || !this.crlIndex.size) continue;
      const set = this.crlIndex.get(this.subjectHash(issuer));
      if (set?.has(normSerial(c.serialNumber))) return `certificate ${oneLine(c.subject)} (serial ${c.serialNumber}) is on the CRL of ${oneLine(issuer.subject)}`;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  pemChain(id: string, includeRoot = true): string {
    const chain = this.chainOf(id).filter((r) => includeRoot || r.kind !== 'root');
    return chain.map((r) => r.cert_pem).join('');
  }

  keyPem(id: string, format: 'pkcs8' | 'traditional' = 'pkcs8'): string {
    const r = this.getRow(id);
    if (!r?.key_pem) throw new Error('No private key stored for this certificate');
    if (format === 'pkcs8') return r.key_pem;
    const k = crypto.createPrivateKey(r.key_pem);
    return k.export({ type: k.asymmetricKeyType === 'ec' ? 'sec1' : 'pkcs1', format: 'pem' }) as string;
  }

  der(id: string): Buffer {
    const r = this.getRow(id);
    if (!r) throw new Error('Certificate not found');
    return new crypto.X509Certificate(r.cert_pem).raw;
  }

  pkcs12(id: string, password: string, compat = false): Buffer {
    const r = this.getRow(id);
    if (!r?.key_pem) throw new Error('No private key stored for this certificate');
    const chain = this.pemChain(id, true);
    return this.withTmp((dir) => {
      write(dir, 'cert.pem', r.cert_pem);
      write(dir, 'key.pem', r.key_pem);
      write(dir, 'chain.pem', chain || r.cert_pem);
      const args = ['pkcs12', '-export', '-inkey', 'key.pem', '-in', 'cert.pem', '-name', r.name, '-passout', 'pass:' + password, '-out', 'out.p12'];
      if (chain) args.push('-certfile', 'chain.pem');
      if (compat) args.push('-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1');
      openssl(dir, args);
      return fs.readFileSync(path.join(dir, 'out.p12'));
    });
  }

  /**
   * Everything needed to provision a radio / domain proxy in one zip:
   * its identity (cert, key, chains, PKCS#12) and the trust anchors for the SAS server certificate.
   */
  radioBundle(id: string, opts: { password: string; serverCertId?: string | null; sasUrls: string[] }): Buffer {
    const r = this.getRow(id);
    if (!r?.key_pem) throw new Error('No private key stored for this certificate');
    const base = (r.meta && jparse<any>(r.meta, {}).fccId) ? safeName(`${jparse<any>(r.meta, {}).fccId}_${jparse<any>(r.meta, {}).serial}`) : safeName(r.name);
    const files: Record<string, Uint8Array> = {};
    const chain = this.pemChain(id, false);
    const full = this.pemChain(id, true);
    files[`${base}/device-cert.pem`] = strToU8(r.cert_pem);
    files[`${base}/device-cert.der`] = this.der(id);
    files[`${base}/device-key.pem`] = strToU8(this.keyPem(id, 'pkcs8'));
    files[`${base}/device-key-traditional.pem`] = strToU8(this.keyPem(id, 'traditional'));
    files[`${base}/device-chain.pem`] = strToU8(r.cert_pem + chain);
    files[`${base}/device-fullchain.pem`] = strToU8(r.cert_pem + full);
    files[`${base}/device-cert-and-key.pem`] = strToU8(r.cert_pem + chain + this.keyPem(id, 'pkcs8'));
    files[`${base}/device-all-in-one.pem`] = strToU8(r.cert_pem + full + this.keyPem(id, 'pkcs8'));
    files[`${base}/device-all-in-one-traditional.pem`] = strToU8(r.cert_pem + full + this.keyPem(id, 'traditional'));
    files[`${base}/device.p12`] = this.pkcs12(id, opts.password, false);
    files[`${base}/device-legacy.p12`] = this.pkcs12(id, opts.password, true);
    const own = this.rootOf(id);
    if (own) files[`${base}/client-issuer-root-ca.pem`] = strToU8(own.cert_pem);

    // SAS server trust anchors
    const srv = opts.serverCertId ? this.getRow(opts.serverCertId) : undefined;
    if (srv) {
      const sroot = this.rootOf(srv.id);
      if (sroot) {
        files[`${base}/sas-root-ca.pem`] = strToU8(sroot.cert_pem);
        files[`${base}/sas-root-ca.crt`] = strToU8(sroot.cert_pem);
        files[`${base}/sas-root-ca.der`] = new crypto.X509Certificate(sroot.cert_pem).raw;
      }
      const sch = this.pemChain(srv.id, true);
      if (sch) files[`${base}/sas-ca-chain.pem`] = strToU8(sch);
    }
    files[`${base}/README.txt`] = strToU8(bundleReadme(r, opts));
    return Buffer.from(zipSync(files, { level: 6 }));
  }

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  /** Create a complete lab PKI on first start so HTTPS works out of the box. */
  ensureLabPki(sans: string[], log: (m: string) => void): { serverCertIds: string[] } {
    const haveRoot = this.findCa('root');
    if (haveRoot) {
      const srv = this.db.all("SELECT id FROM certs WHERE kind='server' AND key_pem IS NOT NULL ORDER BY created_at DESC");
      return { serverCertIds: srv.map((r) => r.id) };
    }
    log('Generating lab PKI (root CA, SAS/CBSD/Domain Proxy/Installer CAs, SAS server certificate)…');
    const O = PKI_ORG;
    const root = this.createRoot({ dn: { CN: `${PKI_ORG} Root CA`, O, OU: 'Lab PKI' } });
    const sasCa = this.createSubCa({ parentId: root.id, role: 'sas', dn: { CN: `${PKI_ORG} SAS CA`, O, OU: 'Lab PKI' } });
    this.createSubCa({ parentId: root.id, role: 'cbsd', dn: { CN: `${PKI_ORG} CBSD CA`, O, OU: 'Lab PKI' } });
    this.createSubCa({ parentId: root.id, role: 'operator', dn: { CN: `${PKI_ORG} Domain Proxy CA`, O, OU: 'Lab PKI' } });
    this.createSubCa({ parentId: root.id, role: 'installer', dn: { CN: `${PKI_ORG} Installer CA`, O, OU: 'Lab PKI' } });
    const srv = this.issueServer({ parentId: sasCa.id, dn: { CN: sans[0] ?? 'localhost', O }, sans, name: 'SAS server RSA (auto)' });
    // An ECDSA certificate as well, so the ECDHE-ECDSA cipher suites of WINNF-TS-0065 can be negotiated.
    const srvEc = this.issueServer({ parentId: sasCa.id, dn: { CN: sans[0] ?? 'localhost', O }, sans, keyType: 'ec256', name: 'SAS server ECDSA (auto)' });
    return { serverCertIds: [srv.id, srvEc.id] };
  }

  /**
   * Reissue the selected auto-generated SAS server certificates when a hostname or IP address the
   * radios may use (SAS_HOSTNAMES, the host's interfaces) is missing from their SANs. Radios trust
   * the CA, not the leaf, so the swap is transparent to them. Returns the new selection, or null
   * when every address is already covered.
   */
  refreshAutoServerCerts(sans: string[], selected: string[], log: (m: string) => void): string[] | null {
    let changed = false;
    const next = selected.map((id) => {
      const r = this.getRow(id);
      if (!r || r.kind !== 'server' || !r.key_pem || !r.parent_id || !String(r.name).endsWith('(auto)')) return id;
      const have = new Set(sanEntries(r.cert_pem));
      const missing = sans.filter((s) => !have.has(s.toLowerCase()));
      if (!missing.length) return id;
      const c = this.issueServer({ parentId: r.parent_id, dn: { CN: sans[0] ?? 'localhost', O: PKI_ORG }, sans, keyType: r.key_type as KeyType, name: r.name });
      this.delete(id);
      log(`Reissued ${r.name} to add ${missing.join(', ')} to its subject alternative names`);
      changed = true;
      return c.id;
    });
    return changed ? next : null;
  }

  // -------------------------------------------------------------------------

  private withTmp<T>(fn: (dir: string) => T): T {
    const dir = fs.mkdtempSync(path.join(this.workDir, 'op-'));
    try {
      return fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

function safeVerify(x: crypto.X509Certificate, issuer: crypto.X509Certificate) {
  try {
    return x.verify(issuer.publicKey);
  } catch {
    return false;
  }
}

function genKey(t: KeyType): string {
  const opts: any = t.startsWith('rsa')
    ? { type: 'rsa', modulusLength: Number(t.slice(3)) }
    : { type: 'ec', namedCurve: t === 'ec256' ? 'prime256v1' : 'secp384r1' };
  const { privateKey } = crypto.generateKeyPairSync(opts.type, opts) as unknown as { privateKey: crypto.KeyObject };
  return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
}

function digestFor(t: KeyType, ca: boolean): string {
  if (t === 'ec384' || (ca && t !== 'ec256')) return '-sha384';
  return '-sha256';
}

function randSerial(): string {
  const b = crypto.randomBytes(16);
  b[0] &= 0x7f;
  if (b[0] === 0) b[0] = 1;
  return '0x' + b.toString('hex');
}

function asn1Time(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function escapeDn(v: string): string {
  return v.replace(/[\r\n]/g, ' ');
}

function reqConfig(dn: DnInput, ext: string[], alt?: string[]): string {
  const dnLines = (['C', 'ST', 'L', 'O', 'OU', 'CN'] as const)
    .filter((k) => dn[k])
    .map((k) => `${k} = ${escapeDn(dn[k]!)}`);
  return [
    '[ req ]', 'distinguished_name = dn', 'prompt = no', 'utf8 = yes', 'string_mask = utf8only',
    '[ dn ]', ...dnLines,
    '[ ext ]', ...ext,
    ...(alt?.length ? ['[ alt ]', ...alt] : []),
  ].join('\n') + '\n';
}

function sanLines(sans: string[]): string[] {
  let dns = 0;
  let ip = 0;
  return sans.map((s) => s.trim()).filter(Boolean).map((s) =>
    isIp(s) ? `IP.${++ip} = ${s}` : `DNS.${++dns} = ${s}`);
}

/** DNS names and IP addresses in a certificate's SAN extension, lower-cased. */
function sanEntries(pem: string): string[] {
  const alt = new crypto.X509Certificate(pem).subjectAltName ?? '';
  return alt.split(/,\s*/).map((e) => e.replace(/^(DNS|IP Address):/, '').replace(/^"|"$/g, '').toLowerCase()).filter(Boolean);
}

export function isIp(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || (s.includes(':') && /^[0-9a-fA-F:]+$/.test(s));
}

function write(dir: string, f: string, data: string) {
  fs.writeFileSync(path.join(dir, f), data, { mode: 0o600 });
}

function read(dir: string, f: string): string {
  return fs.readFileSync(path.join(dir, f), 'utf8');
}

function openssl(cwd: string, args: string[]) {
  try {
    execFileSync('openssl', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, OPENSSL_CONF: '/dev/null' } });
  } catch (e: any) {
    const msg = (e.stderr?.toString() || e.message || '').trim().split('\n').slice(-3).join(' | ');
    throw new Error(`openssl ${args[0]} failed: ${msg}`);
  }
}

function opensslOut(cwd: string, args: string[]): string {
  try {
    return execFileSync('openssl', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, OPENSSL_CONF: '/dev/null' } }).toString('utf8');
  } catch (e: any) {
    const msg = (e.stderr?.toString() || e.message || '').trim().split('\n').slice(-3).join(' | ');
    throw new Error(`openssl ${args[0]} failed: ${msg}`);
  }
}

function normSerial(s: string): string {
  return s.replace(/[^0-9a-fA-F]/g, '').toUpperCase().replace(/^0+(?=.)/, '');
}

function oneLine(dn: string): string {
  return dn.split('\n').filter(Boolean).join(', ');
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'device';
}

function bundleReadme(r: Row, opts: { password: string; sasUrls: string[] }): string {
  return `SASBench — device credential bundle
===================================
Certificate : ${r.name}
Subject     : ${r.subject}
Issued by   : ${r.issuer}
Valid until : ${new Date(r.not_after).toISOString()}
Generated   : ${new Date().toISOString()}

Device identity (the radio presents this to the SAS — TLS client certificate)
  device-cert.pem / .der           Device certificate
  device-key.pem                   Private key, PKCS#8 PEM ("BEGIN PRIVATE KEY")
  device-key-traditional.pem       Private key, PKCS#1/SEC1 PEM ("BEGIN RSA PRIVATE KEY")
  device-chain.pem                 Device cert + issuing CA (no root)
  device-fullchain.pem             Device cert + issuing CA + root
  device-cert-and-key.pem          Chain followed by the key (single-file format)
  device-all-in-one.pem            Device cert + issuing CA + root + key (PKCS#8), one file
  device-all-in-one-traditional.pem  Same, key as PKCS#1/SEC1 ("BEGIN RSA PRIVATE KEY")
  device.p12                       PKCS#12 (AES), password: ${opts.password}
  device-legacy.p12                PKCS#12 (3DES/SHA1, for older firmware), password: ${opts.password}

SAS trust anchor (install on the radio so it trusts the SAS server certificate)
  sas-root-ca.pem / .crt / .der    Root CA that signed the SAS server certificate
  sas-ca-chain.pem                 SAS issuing CA + root

SAS URLs
${opts.sasUrls.map((u) => '  ' + u).join('\n') || '  (configure in the SAS UI)'}

Most CBSDs append the method name (registration, grant, heartbeat, ...) to the
configured SAS URL, so enter the URL ending in /v1.2/ (or as your radio expects).
`;
}

export const tmpBase = () => path.join(os.tmpdir(), 'sasbench');
