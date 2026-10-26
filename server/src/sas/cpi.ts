import crypto from 'node:crypto';
import type { Db } from '../db.ts';
import { jparse } from '../db.ts';
import { summarizeCert } from '../pki/x509.ts';

// CPI-signed installation data (WINNF-TS-0016 §9.3, §10.1.6–10.1.8): a JWS compact
// serialization split into protectedHeader . encodedCpiSignedData . digitalSignature,
// signed RS256 or ES256 by the Certified Professional Installer's private key.

export interface CpiDecoded {
  header: any;
  data: any;
  signingInput: string;
  signature: Buffer;
}

export function b64decode(s: string): Buffer {
  // Accept both base64 and base64url, with or without padding.
  const norm = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  return Buffer.from(norm, 'base64');
}

export function decodeCpi(sig: any): { ok: true; value: CpiDecoded } | { ok: false; missing?: string[]; invalid?: string[] } {
  if (!sig || typeof sig !== 'object' || Array.isArray(sig)) return { ok: false, invalid: ['cpiSignatureData'] };
  const missing = ['protectedHeader', 'encodedCpiSignedData', 'digitalSignature'].filter((k) => sig[k] === undefined);
  if (missing.length) return { ok: false, missing };
  const bad = ['protectedHeader', 'encodedCpiSignedData', 'digitalSignature'].filter((k) => typeof sig[k] !== 'string' || !sig[k]);
  if (bad.length) return { ok: false, invalid: bad };
  let header: any;
  let data: any;
  try {
    header = JSON.parse(b64decode(sig.protectedHeader).toString('utf8'));
  } catch {
    return { ok: false, invalid: ['protectedHeader'] };
  }
  if (!header || (header.alg !== 'RS256' && header.alg !== 'ES256')) return { ok: false, invalid: ['protectedHeader'] };
  try {
    data = JSON.parse(b64decode(sig.encodedCpiSignedData).toString('utf8'));
  } catch {
    return { ok: false, invalid: ['encodedCpiSignedData'] };
  }
  if (!data || typeof data !== 'object') return { ok: false, invalid: ['encodedCpiSignedData'] };
  return {
    ok: true,
    value: { header, data, signingInput: `${sig.protectedHeader}.${sig.encodedCpiSignedData}`, signature: b64decode(sig.digitalSignature) },
  };
}

export function verifyJws(dec: CpiDecoded, key: crypto.KeyObject): boolean {
  try {
    if (dec.header.alg === 'RS256') {
      return crypto.verify('sha256', Buffer.from(dec.signingInput), key, dec.signature);
    }
    return crypto.verify('sha256', Buffer.from(dec.signingInput), { key, dsaEncoding: 'ieee-p1363' }, dec.signature);
  } catch {
    return false;
  }
}

/**
 * Public keys registered for a CPI: injected CPI users (admin / harness InjectCpiUser) and
 * installer certificates in the PKI store whose CPIRID (or stored cpiId) matches.
 */
export function cpiKeysFor(db: Db, cpiId: string): crypto.KeyObject[] {
  const keys: crypto.KeyObject[] = [];
  for (const r of db.all('SELECT public_key FROM cpi_users WHERE cpi_id = ?', cpiId)) {
    try {
      keys.push(crypto.createPublicKey(r.public_key));
    } catch { /* skip unusable key */ }
  }
  for (const r of db.all("SELECT cert_pem, meta FROM certs WHERE kind IN ('installer','imported','trusted')")) {
    try {
      const s = summarizeCert(r.cert_pem);
      if (s.cpiId === cpiId || jparse<any>(r.meta, {}).cpiId === cpiId) keys.push(new crypto.X509Certificate(r.cert_pem).publicKey);
    } catch { /* skip */ }
  }
  return keys;
}

/** Produce a cpiSignatureData object (used by the UI's CPI tool to provision radios). */
export function signCpiData(data: object, privateKeyPem: string): { protectedHeader: string; encodedCpiSignedData: string; digitalSignature: string } {
  const key = crypto.createPrivateKey(privateKeyPem);
  const alg = key.asymmetricKeyType === 'ec' ? 'ES256' : 'RS256';
  const b64u = (b: Buffer) => b.toString('base64url');
  const protectedHeader = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg })));
  const encodedCpiSignedData = b64u(Buffer.from(JSON.stringify(data)));
  const input = Buffer.from(`${protectedHeader}.${encodedCpiSignedData}`);
  const sig = alg === 'RS256'
    ? crypto.sign('sha256', input, key)
    : crypto.sign('sha256', input, { key, dsaEncoding: 'ieee-p1363' });
  return { protectedHeader, encodedCpiSignedData, digitalSignature: b64u(sig) };
}
