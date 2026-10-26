import crypto from 'node:crypto';

// Lightweight X.509 inspection helpers: Node's X509Certificate plus a minimal DER
// walker to pull out the WInnForum-specific fields (role certificate policies,
// FCCID / SERIAL / CPIRID / FRN otherName SANs) defined in WINNF-TS-0065 §5.3.2.

export const WINNF_OID = {
  ROLE_PREFIX: '1.3.6.1.4.1.46609.1.1',
  ROLE: {
    '1.3.6.1.4.1.46609.1.1.1': 'SAS',
    '1.3.6.1.4.1.46609.1.1.2': 'INSTALLER',
    '1.3.6.1.4.1.46609.1.1.3': 'CBSD',
    '1.3.6.1.4.1.46609.1.1.4': 'OPERATOR',
    '1.3.6.1.4.1.46609.1.1.5': 'CA',
    '1.3.6.1.4.1.46609.1.1.6': 'PAL',
    '1.3.6.1.4.1.46609.1.1.7': 'ESC',
  } as Record<string, string>,
  FCCID: '1.3.6.1.4.1.46609.1.4',
  SERIAL: '1.3.6.1.4.1.46609.1.5',
  FRN: '1.3.6.1.4.1.46609.1.6',
  CPIRID: '1.3.6.1.4.1.46609.1.7',
  TEST: '1.3.6.1.4.1.46609.1.999',
  ZONE: '1.3.6.1.4.1.46609.1.2',
  FREQUENCY: '1.3.6.1.4.1.46609.1.3',
  ARC: '1.3.6.1.4.1.46609.',
};

export interface CertSummary {
  subject: string;
  issuer: string;
  commonName: string | null;
  serial: string;
  notBefore: number;
  notAfter: number;
  fingerprint256: string;
  keyType: string;
  isCa: boolean;
  selfSigned: boolean;
  subjectAltName: string | null;
  roles: string[];
  /** All certificatePolicies OIDs. */
  policies: string[];
  fccId: string | null;
  cbsdSerial: string | null;
  cpiId: string | null;
  frn: string | null;
}

export function summarizeCert(input: string | Buffer | crypto.X509Certificate): CertSummary {
  const x = input instanceof crypto.X509Certificate ? input : new crypto.X509Certificate(input);
  const der = x.raw;
  const policies = findPolicyOids(der);
  const other = findOtherNames(der);
  const pk = x.publicKey;
  const d = pk.asymmetricKeyDetails ?? {};
  const keyType = pk.asymmetricKeyType === 'rsa'
    ? `RSA ${d.modulusLength ?? ''}`.trim()
    : pk.asymmetricKeyType === 'ec' ? `EC ${d.namedCurve ?? ''}`.trim() : String(pk.asymmetricKeyType);
  return {
    subject: oneLineDn(x.subject),
    issuer: oneLineDn(x.issuer),
    commonName: dnField(x.subject, 'CN'),
    serial: x.serialNumber.toUpperCase(),
    notBefore: Date.parse(x.validFrom),
    notAfter: Date.parse(x.validTo),
    fingerprint256: x.fingerprint256,
    keyType,
    isCa: x.ca,
    selfSigned: x.subject === x.issuer && safeVerify(x, x),
    subjectAltName: x.subjectAltName ?? null,
    roles: policies.filter((o) => WINNF_OID.ROLE[o]).map((o) => WINNF_OID.ROLE[o]),
    policies,
    fccId: other[WINNF_OID.FCCID] ?? null,
    cbsdSerial: other[WINNF_OID.SERIAL] ?? null,
    cpiId: other[WINNF_OID.CPIRID] ?? null,
    frn: other[WINNF_OID.FRN] ?? null,
  };
}

function safeVerify(x: crypto.X509Certificate, issuer: crypto.X509Certificate): boolean {
  try {
    return x.verify(issuer.publicKey);
  } catch {
    return false;
  }
}

export function oneLineDn(dn: string): string {
  return dn.split('\n').filter(Boolean).join(', ');
}

export function dnField(dn: string, field: string): string | null {
  for (const line of dn.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && line.slice(0, i) === field) return line.slice(i + 1);
  }
  return null;
}

/** Split a PEM bundle into individual certificate PEM blocks. */
export function splitPemCerts(pem: string): string[] {
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)?.map((s) => s + '\n') ?? [];
}

export function extractPrivateKeyPem(pem: string): string | null {
  const m = pem.match(/-----BEGIN ((?:RSA |EC |ENCRYPTED )?PRIVATE KEY)-----[\s\S]+?-----END \1-----/);
  return m ? m[0] + '\n' : null;
}

// ---------------------------------------------------------------------------
// Minimal DER parsing
// ---------------------------------------------------------------------------

interface Tlv { tag: number; start: number; hdr: number; len: number; end: number }

function readTlv(b: Buffer, off: number): Tlv | null {
  if (off + 2 > b.length) return null;
  const tag = b[off];
  let len = b[off + 1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || off + 2 + n > b.length) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | b[off + 2 + i];
    hdr = 2 + n;
  }
  const end = off + hdr + len;
  if (end > b.length) return null;
  return { tag, start: off, hdr, len, end };
}

function children(b: Buffer, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let off = t.start + t.hdr;
  while (off < t.end) {
    const c = readTlv(b, off);
    if (!c) break;
    out.push(c);
    off = c.end;
  }
  return out;
}

export function decodeOid(b: Buffer): string {
  if (!b.length) return '';
  const parts: number[] = [Math.floor(b[0] / 40), b[0] % 40];
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join('.');
}

/** Walk the whole certificate and collect every OID that appears inside a SEQUENCE (policyIdentifier etc.). */
function walk(b: Buffer, t: Tlv, visit: (t: Tlv, parent: Tlv | null) => void, parent: Tlv | null = null, depth = 0) {
  visit(t, parent);
  if (depth > 20) return;
  // constructed: SEQUENCE/SET or context-specific constructed, or OCTET STRING wrapping DER (extensions)
  const constructed = (t.tag & 0x20) !== 0;
  if (constructed) {
    for (const c of children(b, t)) walk(b, c, visit, t, depth + 1);
  } else if (t.tag === 0x04 && t.len > 2) {
    const inner = readTlv(b, t.start + t.hdr);
    if (inner && inner.end === t.end && (inner.tag & 0x20)) walk(b, inner, visit, t, depth + 1);
  }
}

/** policyIdentifier OIDs of the certificatePolicies extension (2.5.29.32). */
function findPolicyOids(der: Buffer): string[] {
  const root = readTlv(der, 0);
  if (!root) return [];
  const out = new Set<string>();
  walk(der, root, (t) => {
    // Extension ::= SEQUENCE { extnID OID, critical BOOLEAN OPTIONAL, extnValue OCTET STRING }
    if (t.tag !== 0x30) return;
    const kids = children(der, t);
    if (kids.length < 2 || kids[0].tag !== 0x06) return;
    if (decodeOid(der.subarray(kids[0].start + kids[0].hdr, kids[0].end)) !== '2.5.29.32') return;
    const val = kids[kids.length - 1];
    if (val.tag !== 0x04) return;
    const seq = readTlv(der, val.start + val.hdr);
    if (!seq || seq.tag !== 0x30) return;
    for (const pi of children(der, seq)) {
      const id = pi.tag === 0x30 ? children(der, pi)[0] : undefined;
      if (id?.tag === 0x06) out.add(decodeOid(der.subarray(id.start + id.hdr, id.end)));
    }
  });
  return [...out];
}

function findOtherNames(der: Buffer): Record<string, string> {
  const root = readTlv(der, 0);
  const out: Record<string, string> = {};
  if (!root) return out;
  walk(der, root, (t) => {
    // otherName ::= [0] IMPLICIT SEQUENCE { type-id OID, value [0] EXPLICIT ANY }
    if (t.tag !== 0xa0) return;
    const kids = children(der, t);
    if (kids.length !== 2 || kids[0].tag !== 0x06 || kids[1].tag !== 0xa0) return;
    const oid = decodeOid(der.subarray(kids[0].start + kids[0].hdr, kids[0].end));
    if (!oid.startsWith('1.3.6.1.4.1.46609.')) return;
    const val = children(der, kids[1])[0];
    if (!val) return;
    out[oid] = der.subarray(val.start + val.hdr, val.end).toString('utf8');
  });
  return out;
}
