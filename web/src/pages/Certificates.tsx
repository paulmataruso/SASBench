import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Download, FileKey2, FileUp, KeyRound, Package, Pencil, Search, ShieldCheck, ShieldOff, Trash2, Upload } from 'lucide-react';
import { api, download, fileToBase64, postDownload } from '../lib/api';
import { useResource } from '../lib/live';
import { useStatus, lanFirst } from '../lib/status';
import { clock, iso } from '../lib/format';
import type { CertRecord, CrlRow } from '../lib/types';
import {
  Button, CopyButton, Drawer, Empty, ErrorNote, Field, Input, Module, PageHeader, Readout, Segmented, Select,
  SkeletonRows, Switch, Tabs, Tag, Textarea, cx, useAction, useConfirm, useToast, type Tone,
} from '../components/ui';

// Lab PKI: radio certificate kits, CA / server / domain-proxy / installer issuance, inventory, imports and CRLs.

interface CertsResponse {
  certs: CertRecord[];
  serverCertIds: string[];
  trustedClientCaIds: string[];
  crls: CrlRow[];
}

type KeyType = 'rsa2048' | 'rsa3072' | 'rsa4096' | 'ec256' | 'ec384';

const KIND_LABEL: Record<string, string> = {
  root: 'Root CA', sub_ca: 'Sub-CA', server: 'SAS server', cbsd: 'CBSD', domain_proxy: 'Domain proxy',
  installer: 'Installer', trusted: 'Trusted CA', imported: 'Imported',
};
const KIND_RANK: Record<string, number> = { root: 0, sub_ca: 1, trusted: 2, server: 3, domain_proxy: 4, installer: 5, cbsd: 6, imported: 7 };
const KIND_TONE: Record<string, Tone> = { root: 'sel', sub_ca: 'sel', trusted: 'sel', server: 'info', cbsd: 'ok', domain_proxy: 'ok', installer: 'warn', imported: 'off' };
const ROLE_LABEL: Record<string, string> = { sas: 'SAS', cbsd: 'CBSD', operator: 'Domain proxy', installer: 'Installer' };

const FORMATS: Array<{ fmt: string; label: string; needsKey?: boolean; caOnly?: boolean; hint: string }> = [
  { fmt: 'bundle', label: 'Radio bundle (.zip)', needsKey: true, hint: 'Every file below plus the SAS root CA and a README' },
  { fmt: 'pem', label: 'Certificate PEM', hint: 'Leaf certificate only' },
  { fmt: 'crt', label: 'Certificate .crt', hint: 'Same as PEM, .crt extension' },
  { fmt: 'der', label: 'Certificate DER', hint: 'Binary X.509' },
  { fmt: 'chain', label: 'Cert + chain', hint: 'Leaf followed by intermediate CAs (no root)' },
  { fmt: 'fullchain', label: 'Cert + full chain', hint: 'Leaf, intermediates and root' },
  { fmt: 'all-in-one', label: 'All-in-one PEM', needsKey: true, hint: 'Leaf, intermediates, root and private key (PKCS#8) in one file' },
  { fmt: 'all-in-one-traditional', label: 'All-in-one PEM, traditional key', needsKey: true, hint: 'Same, key as BEGIN RSA / EC PRIVATE KEY' },
  { fmt: 'key', label: 'Private key PKCS#8', needsKey: true, hint: 'BEGIN PRIVATE KEY' },
  { fmt: 'key-traditional', label: 'Private key traditional', needsKey: true, hint: 'BEGIN RSA / EC PRIVATE KEY' },
  { fmt: 'p12', label: 'PKCS#12', needsKey: true, hint: 'AES-256 / SHA-256 (OpenSSL 3 default)' },
  { fmt: 'p12-legacy', label: 'PKCS#12 legacy', needsKey: true, hint: '3DES / SHA-1, for older radio firmware' },
  { fmt: 'crl', label: 'CRL', needsKey: true, caOnly: true, hint: 'Certificates revoked under this CA' },
];

const dlUrl = (id: string, fmt: string, password: string) =>
  `/api/certs/${encodeURIComponent(id)}/download?format=${fmt}&password=${encodeURIComponent(password || 'cbrs')}`;

function expiryTone(notAfter: number): { tone: Tone; text: string } {
  const days = (notAfter - Date.now()) / 86400e3;
  if (days < 0) return { tone: 'bad', text: 'expired' };
  if (days < 30) return { tone: 'warn', text: `${Math.ceil(days)} d left` };
  return { tone: 'off', text: '' };
}

function issuers(certs: CertRecord[]): CertRecord[] {
  return certs.filter((c) => c.isCa && c.hasKey && !c.revokedAt);
}

function defaultIssuer(certs: CertRecord[], role: string): string {
  const cas = issuers(certs);
  return (cas.find((c) => c.kind === 'sub_ca' && c.role === role) ?? cas.find((c) => c.kind === 'root') ?? cas[0])?.id ?? '';
}

function IssuerSelect({ certs, value, onChange, id }: { certs: CertRecord[]; value: string; onChange: (v: string) => void; id?: string }) {
  const cas = issuers(certs);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {!cas.length && <option value="">No CA with a private key</option>}
      {cas.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}{c.role ? ` · ${ROLE_LABEL[c.role] ?? c.role}` : ''}
        </option>
      ))}
    </Select>
  );
}

function KeyTypeSelect({ value, onChange, options = ['rsa2048', 'rsa3072', 'rsa4096', 'ec256', 'ec384'] }: { value: KeyType; onChange: (v: KeyType) => void; options?: KeyType[] }) {
  const label: Record<KeyType, string> = { rsa2048: 'RSA 2048', rsa3072: 'RSA 3072', rsa4096: 'RSA 4096', ec256: 'ECDSA P-256', ec384: 'ECDSA P-384' };
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as KeyType)}>
      {options.map((o) => <option key={o} value={o}>{label[o]}</option>)}
    </Select>
  );
}

// ====================================================================== page

export function CertificatesPage() {
  const res = useResource<CertsResponse>('/api/certs', ['certs', 'settings']);
  const [openId, setOpenId] = useState<string | null>(null);
  const d = res.data;

  return (
    <div>
      <PageHeader
        title="Certificates"
        sub="Lab PKI for the SAS HTTPS listener and for your radios. Certificates issued here carry the WInnForum role policies and FCC ID / serial identities that a SAS checks."
      >
        <Button icon={Download} onClick={() => download('/api/trust-bundle?which=all')}>CA bundle</Button>
      </PageHeader>

      {res.error && !d && <ErrorNote>Could not load certificates: {res.error}</ErrorNote>}

      <div className="space-y-4">
        {d ? <RadioKit certs={d.certs} /> : <Module title="Radio certificate kit"><SkeletonRows rows={4} cols={3} /></Module>}

        {d && <NokiaCard certs={d.certs} serverCertIds={d.serverCertIds} />}

        <Inventory data={d} loading={res.loading} openId={openId} onOpen={setOpenId} />

        <div className="grid gap-4 xl:grid-cols-2">
          {d ? <IssueOther certs={d.certs} /> : <Module title="Issue other certificates"><SkeletonRows rows={5} cols={2} /></Module>}
          <ImportPanel crls={d?.crls} />
        </div>
      </div>

      {d && openId && (
        <CertDrawer
          id={openId}
          onClose={() => setOpenId(null)}
          serverCertIds={d.serverCertIds}
          trustedClientCaIds={d.trustedClientCaIds}
        />
      )}
    </div>
  );
}

// ====================================================================== Nokia

/** The CAs above the active SAS server certificate, root first: what a radio must trust. */
function serverTrustChain(certs: CertRecord[], serverCertIds: string[]): CertRecord[] {
  const byId = new Map(certs.map((c) => [c.id, c]));
  const chain: CertRecord[] = [];
  let c = byId.get(byId.get(serverCertIds[0] ?? '')?.parentId ?? '');
  while (c && chain.length < 5) {
    chain.unshift(c);
    c = c.parentId ? byId.get(c.parentId) : undefined;
  }
  return chain;
}

function NokiaCard({ certs, serverCertIds }: { certs: CertRecord[]; serverCertIds: string[] }) {
  const chain = serverTrustChain(certs, serverCertIds);
  const step = (n: number, body: ReactNode) => (
    <li className="flex gap-2.5">
      <span className="num w-4 flex-none pt-px text-right font-mono text-sm text-ink-3">{n}</span>
      <div className="min-w-0 flex-1">{body}</div>
    </li>
  );
  return (
    <Module title="Nokia radios" meta="Make an AirScale BBU trust this SAS (WebEM)">
      <ol className="space-y-2 text-base text-ink-2">
        {step(1, 'Log in to WebEM.')}
        {step(2, 'Click the shield icon in the left-hand navigation bar.')}
        {step(3, <>Go to <span className="font-medium text-ink">CBRS Certificate Management › CBRS Certificates</span>.</>)}
        {step(4, (
          <>
            <p>
              Select <span className="font-medium text-ink">CBRS additional CA certificates</span>
              {chain.length ? ` and add ${chain.map((c) => `the ${c.name}`).join(', then ')}.` : '.'}
            </p>
            {chain.length ? (
              <div className="mt-2 grid gap-1.5 sm:grid-cols-2 xl:max-w-[48rem]">
                {chain.map((c, i) => (
                  <a
                    key={c.id}
                    href={`/api/certs/${encodeURIComponent(c.id)}/download?format=pem`}
                    download
                    className="group flex items-center gap-2.5 rounded border border-line bg-panel px-2.5 py-1.5 transition-colors duration-150 hover:border-ink-3 hover:bg-panel-2"
                  >
                    <Download className="size-3.5 flex-none text-ink-3 group-hover:text-ink" aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-ink">{i + 1}. {c.name}</span>
                      <span className="block truncate text-xs text-ink-3">PEM · valid until {iso(c.notAfter).slice(0, 10)} · SHA-256 {c.fingerprint.slice(0, 11)}…</span>
                    </span>
                  </a>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-sm text-warn-ink">The active SAS server certificate was not issued by a CA in this PKI, so there is no chain to download here. Install the CA that issued it.</p>
            )}
          </>
        ))}
      </ol>
    </Module>
  );
}

// ====================================================================== radio kit

function RadioKit({ certs }: { certs: CertRecord[] }) {
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  return (
    <Module
      title="Radio certificate kit"
      meta="Device certificate, key and chain for a CBSD, plus the SAS CA the radio must trust"
      actions={
        <Segmented
          size="sm"
          label="Issue mode"
          value={mode}
          onChange={setMode}
          options={[{ value: 'single', label: 'Single radio' }, { value: 'batch', label: 'Batch' }]}
        />
      }
      bodyClass="p-0"
    >
      {mode === 'single' ? <SingleKit certs={certs} /> : <BatchKit certs={certs} />}
      <TrustStrip />
    </Module>
  );
}

function SingleKit({ certs }: { certs: CertRecord[] }) {
  const { run, busy } = useAction();
  const [f, setF] = useState({ fccId: '', serial: '', CN: '', O: '', days: '3650', keyType: 'rsa2048' as KeyType, registerFccId: true });
  const [parentId, setParentId] = useState(() => defaultIssuer(certs, 'cbsd'));
  const [issued, setIssued] = useState<CertRecord | null>(null);
  const [password, setPassword] = useState('cbrs');
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!parentId || !certs.some((c) => c.id === parentId)) setParentId(defaultIssuer(certs, 'cbsd'));
  }, [certs, parentId]);

  const set = (k: keyof typeof f, v: any) => setF((x) => ({ ...x, [k]: v }));

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!f.fccId.trim()) e.fccId = 'FCC ID is required';
    else if (f.fccId.trim().length > 19) e.fccId = 'FCC IDs are at most 19 characters';
    if (!f.serial.trim()) e.serial = 'Serial number is required';
    else if (new TextEncoder().encode(f.serial.trim()).length > 64) e.serial = 'Serial numbers are at most 64 bytes';
    if (!parentId) e.parentId = 'Create or import a CA with a private key first';
    setErrors(e);
    if (Object.keys(e).length) return;
    const c = await run('issue', () => api.post<CertRecord>('/api/certs/cbsd', {
      parentId, fccId: f.fccId.trim(), serial: f.serial.trim(), CN: f.CN.trim() || undefined, O: f.O.trim() || undefined,
      keyType: f.keyType, days: f.days, registerFccId: f.registerFccId,
    }), `Issued certificate for ${f.fccId.trim()} / ${f.serial.trim()}`);
    if (c) setIssued(c);
  };

  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <form
        className="space-y-3 border-b border-line p-4 lg:border-b-0 lg:border-r"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="FCC ID" htmlFor="kit-fcc" error={errors.fccId} hint="Written into the certificate as the WInnForum FCCID otherName">
            <Input id="kit-fcc" value={f.fccId} onChange={(e) => set('fccId', e.target.value)} placeholder="e.g. 2AG32MBS3500" className="font-mono" aria-invalid={!!errors.fccId} autoComplete="off" />
          </Field>
          <Field label="Serial number" htmlFor="kit-serial" error={errors.serial} hint="Must match cbsdSerialNumber in the radio's registration">
            <Input id="kit-serial" value={f.serial} onChange={(e) => set('serial', e.target.value)} placeholder="e.g. SN-000123" className="font-mono" aria-invalid={!!errors.serial} autoComplete="off" />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Issuing CA" htmlFor="kit-ca" error={errors.parentId}>
            <IssuerSelect id="kit-ca" certs={certs} value={parentId} onChange={setParentId} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Key">
              <KeyTypeSelect value={f.keyType} onChange={(v) => set('keyType', v)} options={['rsa2048', 'rsa3072', 'ec256', 'ec384']} />
            </Field>
            <Field label="Valid (days)" htmlFor="kit-days">
              <Input id="kit-days" type="number" min={1} value={f.days} onChange={(e) => set('days', e.target.value)} className="num" />
            </Field>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Common name (optional)" htmlFor="kit-cn" hint={`Default: ${f.fccId || 'FCCID'}:${f.serial || 'serial'}`}>
            <Input id="kit-cn" value={f.CN} onChange={(e) => set('CN', e.target.value)} />
          </Field>
          <Field label="Organization (optional)" htmlFor="kit-o" hint="Default: SASBench">
            <Input id="kit-o" value={f.O} onChange={(e) => set('O', e.target.value)} />
          </Field>
        </div>
        <Switch
          checked={f.registerFccId}
          onChange={(v) => set('registerFccId', v)}
          label="Also add this FCC ID to the registry"
          description="Needed when “Require known FCC ID” is on (the WInnForum profile turns it on). Max EIRP defaults to 47 dBm/10 MHz."
        />
        <div className="pt-1">
          <Button type="submit" variant="primary" icon={KeyRound} loading={busy === 'issue'}>Issue certificate</Button>
        </div>
      </form>

      <div className="p-4">
        {issued ? (
          <IssuedPanel cert={issued} password={password} setPassword={setPassword} onClear={() => setIssued(null)} />
        ) : (
          <WhereFilesGo />
        )}
      </div>
    </div>
  );
}

function WhereFilesGo() {
  return (
    <div className="text-base text-ink-2">
      <h3 className="mb-2 text-md font-semibold text-ink">What goes on the radio</h3>
      <dl className="space-y-2.5">
        <div>
          <dt className="font-medium text-ink">Device certificate + chain</dt>
          <dd className="text-sm text-ink-3">The CBSD's client certificate for mutual TLS. Most radios want the leaf followed by the CBSD CA (<span className="font-mono text-xs">device-chain.pem</span>), some a PKCS#12 file.</dd>
        </div>
        <div>
          <dt className="font-medium text-ink">Private key</dt>
          <dd className="text-sm text-ink-3">PKCS#8 (<span className="font-mono text-xs">BEGIN PRIVATE KEY</span>) or traditional RSA/EC format, depending on the firmware.</dd>
        </div>
        <div>
          <dt className="font-medium text-ink">SAS root CA → radio trust store</dt>
          <dd className="text-sm text-ink-3">So the radio accepts this SAS's HTTPS certificate. Download it below, or take <span className="font-mono text-xs">sas-root-ca.pem</span> from the bundle.</dd>
        </div>
      </dl>
      <p className="mt-3 text-sm text-ink-3">Issue a certificate on the left; the radio bundle zip contains every format plus a README with the SAS URLs.</p>
    </div>
  );
}

function IssuedPanel({ cert, password, setPassword, onClear }: { cert: CertRecord; password: string; setPassword: (v: string) => void; onClear: () => void }) {
  return (
    <div>
      <div className="mb-3 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="led" data-c="ok" aria-hidden />
            <h3 className="truncate text-md font-semibold">{cert.name}</h3>
          </div>
          <p className="mt-0.5 text-sm text-ink-3">
            <span className="font-mono text-xs text-ink-2">{cert.details.commonName}</span> · {cert.keyType} · valid until {iso(cert.notAfter).slice(0, 10)}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClear}>Issue another</Button>
      </div>
      <div className="flex flex-wrap items-end gap-3 rounded border border-line bg-panel-2 p-3">
        <Field label="PKCS#12 / bundle password" htmlFor="kit-pw" className="w-48">
          <Input id="kit-pw" value={password} onChange={(e) => setPassword(e.target.value)} className="font-mono" />
        </Field>
        <Button variant="primary" icon={Package} onClick={() => download(dlUrl(cert.id, 'bundle', password))}>Download radio bundle (.zip)</Button>
      </div>
      <FormatGrid cert={cert} password={password} exclude={['bundle', 'crl']} className="mt-3" />
    </div>
  );
}

function FormatGrid({ cert, password, exclude = [], className }: { cert: Pick<CertRecord, 'id' | 'hasKey' | 'isCa'>; password: string; exclude?: string[]; className?: string }) {
  const list = FORMATS.filter((x) => !exclude.includes(x.fmt) && (!x.needsKey || cert.hasKey) && (!x.caOnly || cert.isCa));
  return (
    <div className={cx('grid gap-1.5 sm:grid-cols-2', className)}>
      {list.map((x) => (
        <button
          key={x.fmt}
          type="button"
          onClick={() => download(dlUrl(cert.id, x.fmt, password))}
          className="group flex items-center gap-2.5 rounded border border-line bg-panel px-2.5 py-1.5 text-left transition-colors duration-150 hover:border-ink-3 hover:bg-panel-2"
        >
          <Download className="size-3.5 flex-none text-ink-3 group-hover:text-ink" aria-hidden />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-ink">{x.label}</span>
            <span className="block truncate text-xs text-ink-3">{x.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function TrustStrip() {
  const { data: s } = useStatus();
  const urls = lanFirst(s?.urls ?? []);
  return (
    <div className="grid gap-4 border-t border-line bg-panel-2 px-4 py-3 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-center">
      <div className="flex flex-wrap items-center gap-2">
        <span className="silk mr-1">SAS trust anchor</span>
        <Button size="sm" icon={Download} onClick={() => download('/api/trust-bundle?which=roots')}>Root CAs (PEM)</Button>
        <Button size="sm" icon={Download} onClick={() => download('/api/trust-bundle?which=all')}>All CA certificates (PEM)</Button>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 lg:justify-end">
        <span className="silk">Point the radio at</span>
        {urls.slice(0, 4).map((u) => (
          <span key={u} className="inline-flex items-center gap-0.5">
            <span className="font-mono text-xs text-ink">{u}</span>
            <CopyButton text={u} label={`Copy ${u}`} />
          </span>
        ))}
        {!urls.length && <span className="text-sm text-ink-3">No SAS listener enabled — see Settings.</span>}
      </div>
    </div>
  );
}

function BatchKit({ certs }: { certs: CertRecord[] }) {
  const { run, busy } = useAction();
  const [devices, setDevices] = useState('');
  const [parentId, setParentId] = useState(() => defaultIssuer(certs, 'cbsd'));
  const [keyType, setKeyType] = useState<KeyType>('rsa2048');
  const [days, setDays] = useState('3650');
  const [password, setPassword] = useState('cbrs');
  const lines = devices.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bad = lines.filter((l) => l.split(/[,;\t ]+/).filter(Boolean).length < 2);

  return (
    <form
      className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
      onSubmit={(e) => {
        e.preventDefault();
        if (!lines.length || bad.length) return;
        void run('batch', () => postDownload('/api/certs/cbsd-batch', { devices, parentId, keyType, days, password }, 'cbsd-certificates.zip'),
          `Issued ${lines.length} certificate${lines.length > 1 ? 's' : ''}`);
      }}
    >
      <Field
        label="Devices — one “fccId,serial” per line"
        htmlFor="batch-devices"
        error={bad.length ? `Missing serial on: ${bad.slice(0, 3).join(' · ')}` : null}
        hint={lines.length ? `${lines.length} device${lines.length > 1 ? 's' : ''}` : 'Comma, semicolon, tab or space separated'}
      >
        <Textarea id="batch-devices" rows={9} value={devices} onChange={(e) => setDevices(e.target.value)} placeholder={'2AG32MBS3500,SN-0001\n2AG32MBS3500,SN-0002\n2AG32MBS3500,SN-0003'} aria-invalid={bad.length > 0} />
      </Field>
      <div className="space-y-3">
        <Field label="Issuing CA">
          <IssuerSelect certs={certs} value={parentId} onChange={setParentId} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Key"><KeyTypeSelect value={keyType} onChange={setKeyType} options={['rsa2048', 'rsa3072', 'ec256', 'ec384']} /></Field>
          <Field label="Valid (days)"><Input type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} className="num" /></Field>
        </div>
        <Field label="PKCS#12 password" hint="Used for every device.p12 in the zip">
          <Input value={password} onChange={(e) => setPassword(e.target.value)} className="font-mono" />
        </Field>
        <p className="text-sm text-ink-3">Downloads one zip containing a radio bundle per device (cert, key, chain, PKCS#12, SAS root CA) and the device list.</p>
        <Button type="submit" variant="primary" icon={Package} loading={busy === 'batch'} disabled={!lines.length || bad.length > 0 || !parentId}>
          Issue {lines.length || ''} and download zip
        </Button>
      </div>
    </form>
  );
}

// ====================================================================== inventory

const FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All' }, { value: 'ca', label: 'CAs' }, { value: 'server', label: 'SAS server' }, { value: 'cbsd', label: 'CBSD' },
  { value: 'domain_proxy', label: 'Domain proxy' }, { value: 'installer', label: 'Installer' }, { value: 'imported', label: 'Imported' },
];

function Inventory({ data, loading, openId, onOpen }: { data?: CertsResponse; loading: boolean; openId: string | null; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const list = (data?.certs ?? []).filter((c) => {
      if (filter === 'ca' && !c.isCa) return false;
      if (filter !== 'all' && filter !== 'ca' && c.kind !== filter) return false;
      if (!q) return true;
      const hay = `${c.name} ${c.subject} ${c.issuer} ${c.serial} ${c.details.fccId ?? ''} ${c.details.cbsdSerial ?? ''} ${c.details.cpiId ?? ''} ${c.fingerprint}`.toLowerCase();
      return hay.includes(q.toLowerCase());
    });
    return list.sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || b.createdAt - a.createdAt);
  }, [data, filter, q]);

  const server = new Set(data?.serverCertIds ?? []);
  const trusted = new Set(data?.trustedClientCaIds ?? []);

  return (
    <Module
      title="Inventory"
      meta={data ? `${data.certs.length} certificates` : undefined}
      bodyClass="p-0"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Select value={filter} onChange={(e) => setFilter(e.target.value)} className="h-7 w-36 py-0 text-sm" aria-label="Filter by kind">
            {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </Select>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, FCC ID, serial…" className="h-7 w-44 py-0 pl-7 text-sm sm:w-52" aria-label="Search certificates" />
          </div>
        </div>
      }
    >
      {data && (
        <p className="border-b border-line px-3 py-2 text-xs text-ink-3">
          {trusted.size
            ? `Client certificates are verified against the ${trusted.size} CA${trusted.size > 1 ? 's' : ''} marked “Client trust”.`
            : 'No CA is marked “Client trust”, so every CA certificate in this store is trusted for client authentication.'}
          {' '}The HTTPS listener presents the certificates marked “HTTPS server” (RSA and ECDSA can both be active).
        </p>
      )}
      {loading && !data ? (
        <SkeletonRows rows={6} cols={6} />
      ) : !rows.length ? (
        <Empty icon={ShieldCheck} title={q || filter !== 'all' ? 'No certificates match' : 'No certificates yet'}>
          {q || filter !== 'all' ? 'Clear the search or choose another kind.' : 'The lab PKI is generated on first start. Issue a radio certificate above or import your own CA.'}
        </Empty>
      ) : (
        <div className="max-h-[520px] overflow-auto">
          <table className="dtable">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Identity</th>
                <th>Key</th>
                <th>Expires</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const exp = expiryTone(c.notAfter);
                return (
                  <tr
                    key={c.id}
                    aria-selected={openId === c.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    onClick={() => onOpen(c.id)}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(c.id))}
                  >
                    <td className="max-w-[280px]">
                      <span className="block truncate font-medium text-ink">{c.name}</span>
                    </td>
                    <td>
                      <span className="inline-flex items-center gap-1.5">
                        <Tag tone={KIND_TONE[c.kind] ?? 'off'}>{KIND_LABEL[c.kind] ?? c.kind}</Tag>
                        {c.role && c.kind === 'sub_ca' && <span className="text-xs text-ink-3">{ROLE_LABEL[c.role] ?? c.role}</span>}
                      </span>
                    </td>
                    <td className="max-w-[320px]">
                      <span className="block truncate font-mono text-xs text-ink-2" title={c.subject}>{identity(c)}</span>
                    </td>
                    <td className="whitespace-nowrap text-ink-2">{c.keyType}</td>
                    <td className="whitespace-nowrap">
                      <span className="num text-ink-2">{iso(c.notAfter).slice(0, 10)}</span>
                      {exp.text && <Tag tone={exp.tone} className="ml-2">{exp.text}</Tag>}
                    </td>
                    <td>
                      <span className="flex flex-wrap gap-1">
                        {server.has(c.id) && <Tag tone="info">HTTPS server</Tag>}
                        {trusted.has(c.id) && <Tag tone="sel">Client trust</Tag>}
                        {c.revokedAt && <Tag tone="bad">Revoked</Tag>}
                        {!c.hasKey && <Tag tone="off" title="Only the certificate is stored">No key</Tag>}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Module>
  );
}

function identity(c: CertRecord): string {
  const d = c.details;
  if (d.fccId || d.cbsdSerial) return `FCCID ${d.fccId ?? '—'} · SN ${d.cbsdSerial ?? '—'}`;
  if (d.cpiId) return `CPI ${d.cpiId}`;
  if (d.frn) return `FRN ${d.frn} · ${d.commonName ?? ''}`;
  if (c.kind === 'server' && d.subjectAltName) return d.subjectAltName.replace(/DNS:|IP Address:/g, '');
  return d.commonName ?? c.subject;
}

// ====================================================================== detail drawer

function CertDrawer({ id, onClose, serverCertIds, trustedClientCaIds }: { id: string; onClose: () => void; serverCertIds: string[]; trustedClientCaIds: string[] }) {
  const res = useResource<CertRecord & { pem: string; chain: Array<{ id: string; name: string; kind: string }> }>(`/api/certs/${encodeURIComponent(id)}`, ['certs']);
  const c = res.data;
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [password, setPassword] = useState('cbrs');
  const [rename, setRename] = useState<string | null>(null);

  const isServer = serverCertIds.includes(id);
  const isTrusted = trustedClientCaIds.includes(id);

  const toggleServer = async () => {
    if (!c) return;
    const ids = isServer ? serverCertIds.filter((x) => x !== id) : [...serverCertIds, id];
    if (isServer && !ids.length) {
      const ok = await confirm({
        title: 'Remove the last HTTPS server certificate?',
        body: 'The HTTPS listener cannot start without a server certificate. Radios using HTTPS will fail to connect until you select another one.',
        confirm: 'Remove', danger: true,
      });
      if (!ok) return;
    }
    await run('server', () => api.post('/api/certs/use-as-server', { ids }), isServer ? 'No longer presented by the HTTPS listener' : 'HTTPS listener now presents this certificate');
  };

  const toggleTrust = () => run('trust', () => api.post('/api/certs/trusted-cas', { ids: isTrusted ? trustedClientCaIds.filter((x) => x !== id) : [...trustedClientCaIds, id] }),
    isTrusted ? 'Removed from client trust anchors' : 'Added to client trust anchors');

  const revoke = async () => {
    if (!c) return;
    if (!c.revokedAt) {
      const ok = await confirm({
        title: `Revoke “${c.name}”?`,
        body: 'Clients presenting this certificate (or any certificate it issued) get HTTP 403 while CRL checking is on. It is also listed in the CRL its CA generates. You can un-revoke later.',
        confirm: 'Revoke', danger: true,
      });
      if (!ok) return;
    }
    await run('revoke', () => api.post(`/api/certs/${encodeURIComponent(id)}/revoke`, { revoked: !c.revokedAt }), c.revokedAt ? 'Certificate un-revoked' : 'Certificate revoked');
  };

  const del = async () => {
    if (!c) return;
    const ok = await confirm({
      title: `Delete “${c.name}”?`,
      body: <>The certificate{c.hasKey ? ' and its private key' : ''} are removed from this SAS. Radios already holding it keep working only if its CA stays trusted.{isServer ? ' It is currently an HTTPS server certificate.' : ''}</>,
      confirm: 'Delete', danger: true,
    });
    if (!ok) return;
    const r = await run('delete', () => api.del(`/api/certs/${encodeURIComponent(id)}`), 'Certificate deleted');
    if (r) onClose();
  };

  const saveName = async () => {
    if (!rename?.trim()) return;
    const r = await run('rename', () => api.patch(`/api/certs/${encodeURIComponent(id)}`, { name: rename.trim() }), 'Renamed');
    if (r) setRename(null);
  };

  return (
    <Drawer open onClose={onClose} width={720} title={c ? c.name : 'Certificate'}>
      {!c ? (
        res.error ? <div className="p-4"><ErrorNote>{res.error}</ErrorNote></div> : <SkeletonRows rows={8} cols={2} />
      ) : (
        <div className="space-y-5 p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <Tag tone={KIND_TONE[c.kind] ?? 'off'}>{KIND_LABEL[c.kind] ?? c.kind}</Tag>
            {c.role && <Tag>{ROLE_LABEL[c.role] ?? c.role} role</Tag>}
            {isServer && <Tag tone="info">HTTPS server</Tag>}
            {isTrusted && <Tag tone="sel">Client trust</Tag>}
            {c.revokedAt && <Tag tone="bad">Revoked {clock(c.revokedAt, true)}</Tag>}
            {expiryTone(c.notAfter).text && <Tag tone={expiryTone(c.notAfter).tone}>{expiryTone(c.notAfter).text}</Tag>}
          </div>

          <div className="flex flex-wrap gap-2">
            {(c.kind === 'server' || (c.hasKey && !c.isCa)) && (
              <Button icon={ShieldCheck} onClick={toggleServer} loading={busy === 'server'} disabled={!c.hasKey}>
                {isServer ? 'Stop presenting on HTTPS' : 'Use as HTTPS server certificate'}
              </Button>
            )}
            {c.isCa && (
              <Button icon={ShieldCheck} onClick={toggleTrust} loading={busy === 'trust'}>
                {isTrusted ? 'Remove from client trust' : 'Trust for client authentication'}
              </Button>
            )}
            <Button icon={ShieldOff} onClick={revoke} loading={busy === 'revoke'}>{c.revokedAt ? 'Un-revoke' : 'Revoke'}</Button>
            <Button variant="danger-ghost" icon={Trash2} onClick={del} loading={busy === 'delete'}>Delete</Button>
          </div>

          <section>
            <h3 className="silk mb-2">Name</h3>
            {rename === null ? (
              <div className="flex items-center gap-2">
                <span className="text-base">{c.name}</span>
                <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setRename(c.name)} aria-label="Rename" title="Rename" />
              </div>
            ) : (
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void saveName(); }}>
                <Input autoFocus value={rename} onChange={(e) => setRename(e.target.value)} aria-label="Certificate name" />
                <Button type="submit" variant="primary" loading={busy === 'rename'}>Save</Button>
                <Button onClick={() => setRename(null)}>Cancel</Button>
              </form>
            )}
          </section>

          <section>
            <h3 className="silk mb-2">Details</h3>
            <Readout
              rows={[
                ['Subject', <span className="font-mono text-xs">{c.subject}</span>],
                ['Issuer', <span className="font-mono text-xs">{c.issuer}</span>],
                ['Serial', <span className="font-mono text-xs">{c.serial}</span>],
                ['Key', c.keyType + (c.hasKey ? ' · private key stored' : ' · certificate only')],
                ['Not before', <span className="num">{iso(c.notBefore)}</span>],
                ['Not after', <span className="num">{iso(c.notAfter)}</span>],
                c.details.subjectAltName ? ['Subject alt. names', <span className="font-mono text-xs">{c.details.subjectAltName}</span>] : null,
                ['WInnForum roles', c.details.roles.length ? c.details.roles.join(', ') : <span className="text-ink-3">none</span>],
                c.details.fccId ? ['FCC ID', <span className="font-mono text-xs">{c.details.fccId}</span>] : null,
                c.details.cbsdSerial ? ['CBSD serial', <span className="font-mono text-xs">{c.details.cbsdSerial}</span>] : null,
                c.details.cpiId ? ['CPI ID', <span className="font-mono text-xs">{c.details.cpiId}</span>] : null,
                c.details.frn ? ['FRN', <span className="font-mono text-xs">{c.details.frn}</span>] : null,
              ]}
            />
            <div className="mt-3">
              <div className="silk">SHA-256 fingerprint</div>
              <div className="mt-0.5 flex items-start gap-1">
                <span className="break-all font-mono text-xs text-ink">{c.fingerprint}</span>
                <CopyButton text={c.fingerprint} label="Copy fingerprint" />
              </div>
            </div>
            {c.details.policies.length > 0 && (
              <div className="mt-3">
                <div className="silk">Certificate policies</div>
                <ul className="mt-0.5 space-y-0.5">
                  {c.details.policies.map((p) => <li key={p} className="font-mono text-xs text-ink-2">{p}</li>)}
                </ul>
              </div>
            )}
          </section>

          {c.chain.length > 0 && (
            <section>
              <h3 className="silk mb-2">Issuer chain</h3>
              <ol className="space-y-1">
                {c.chain.map((x, i) => (
                  <li key={x.id} className="flex items-center gap-2 text-base">
                    <span className="num w-4 text-right text-xs text-ink-3">{i + 1}</span>
                    <span>{x.name}</span>
                    <Tag tone={KIND_TONE[x.kind] ?? 'off'}>{KIND_LABEL[x.kind] ?? x.kind}</Tag>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section>
            <div className="mb-2 flex flex-wrap items-end gap-3">
              <h3 className="silk mr-auto">Download</h3>
              {c.hasKey && (
                <label className="flex items-center gap-2 text-sm text-ink-2">
                  PKCS#12 password
                  <Input value={password} onChange={(e) => setPassword(e.target.value)} className="h-7 w-32 py-0 font-mono text-sm" />
                </label>
              )}
            </div>
            <FormatGrid cert={c} password={password} />
          </section>

          <section>
            <div className="mb-2 flex items-center">
              <h3 className="silk mr-auto">Certificate PEM</h3>
              <CopyButton text={c.pem} label="Copy PEM" size="md" />
            </div>
            <pre className="max-h-64 overflow-auto rounded border border-line bg-panel-2 p-3 font-mono text-2xs leading-[15px] text-ink-2">{c.pem}</pre>
          </section>
        </div>
      )}
    </Drawer>
  );
}

// ====================================================================== issue other certificates

type IssueKind = 'server' | 'root' | 'sub-ca' | 'domain-proxy' | 'installer';

interface Dn { CN: string; O: string; OU: string; L: string; ST: string; C: string }
const EMPTY_DN: Dn = { CN: '', O: 'SASBench', OU: '', L: '', ST: '', C: '' };

function DnFields({ dn, onChange, cnLabel = 'Common name (CN)', cnHint, cnError }: { dn: Dn; onChange: (d: Dn) => void; cnLabel?: string; cnHint?: ReactNode; cnError?: string }) {
  const set = (k: keyof Dn) => (e: { target: { value: string } }) => onChange({ ...dn, [k]: e.target.value });
  return (
    <div className="grid gap-3 sm:grid-cols-6">
      <Field label={cnLabel} hint={cnHint} error={cnError} className="sm:col-span-6">
        <Input value={dn.CN} onChange={set('CN')} aria-invalid={!!cnError} />
      </Field>
      <Field label="Organization (O)" className="sm:col-span-3"><Input value={dn.O} onChange={set('O')} /></Field>
      <Field label="Unit (OU)" className="sm:col-span-3"><Input value={dn.OU} onChange={set('OU')} /></Field>
      <Field label="Locality (L)" className="sm:col-span-2"><Input value={dn.L} onChange={set('L')} /></Field>
      <Field label="State (ST)" className="sm:col-span-2"><Input value={dn.ST} onChange={set('ST')} /></Field>
      <Field label="Country (C)" className="sm:col-span-2"><Input value={dn.C} onChange={set('C')} maxLength={2} placeholder="US" /></Field>
    </div>
  );
}

function IssueOther({ certs }: { certs: CertRecord[] }) {
  const [kind, setKind] = useState<IssueKind>('server');
  const { run, busy } = useAction();
  const [dn, setDn] = useState<Dn>(EMPTY_DN);
  const [keyType, setKeyType] = useState<KeyType>('rsa2048');
  const [days, setDays] = useState('');
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [role, setRole] = useState('cbsd');
  const [sans, setSans] = useState('');
  const [use, setUse] = useState<'' | 'add' | 'replace'>('add');
  const [frn, setFrn] = useState('');
  const [cpiId, setCpiId] = useState('');
  const [cpiName, setCpiName] = useState('');
  const [registerCpi, setRegisterCpi] = useState(true);
  const [err, setErr] = useState<Record<string, string>>({});
  const [last, setLast] = useState<CertRecord | null>(null);

  const issuerRole: Record<IssueKind, string> = { server: 'sas', root: '', 'sub-ca': '', 'domain-proxy': 'operator', installer: 'installer' };

  useEffect(() => {
    setErr({});
    setLast(null);
    setKeyType(kind === 'root' || kind === 'sub-ca' ? 'rsa4096' : 'rsa2048');
    setParentId(kind === 'sub-ca' ? defaultIssuer(certs.filter((c) => c.kind === 'root' || c.kind === 'sub_ca'), 'none') : defaultIssuer(certs, issuerRole[kind]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const submit = async () => {
    const e: Record<string, string> = {};
    if (kind === 'installer') {
      if (!cpiId.trim()) e.cpiId = 'CPI ID is required';
      if (!cpiName.trim()) e.cpiName = 'CPI name is required';
    } else if (!dn.CN.trim()) e.CN = 'Common name is required';
    if (kind !== 'root' && !parentId) e.parentId = 'Choose an issuing CA';
    setErr(e);
    if (Object.keys(e).length) return;
    const base = { ...dn, CN: dn.CN.trim(), keyType, days: days || undefined, name: name.trim() || undefined };
    const call: Record<IssueKind, () => Promise<CertRecord>> = {
      root: () => api.post('/api/certs/root', base),
      'sub-ca': () => api.post('/api/certs/sub-ca', { ...base, parentId, role }),
      server: () => api.post('/api/certs/server', { ...base, parentId, sans, use: use || undefined, frn: frn || undefined }),
      'domain-proxy': () => api.post('/api/certs/domain-proxy', { ...base, parentId, frn: frn || undefined }),
      installer: () => api.post('/api/certs/installer', { parentId, cpiId: cpiId.trim(), cpiName: cpiName.trim(), keyType, days: days || undefined, registerCpi }),
    };
    const c = await run('issue', call[kind], 'Certificate issued');
    if (c) setLast(c);
  };

  return (
    <Module title="Issue other certificates" bodyClass="p-0">
      <Tabs
        className="px-2"
        value={kind}
        onChange={setKind}
        tabs={[
          { value: 'server', label: 'SAS server' }, { value: 'domain-proxy', label: 'Domain proxy' }, { value: 'installer', label: 'Installer (CPI)' },
          { value: 'sub-ca', label: 'Sub-CA' }, { value: 'root', label: 'Root CA' },
        ]}
      />
      <form
        className="space-y-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="text-sm text-ink-3">
          {kind === 'server' && 'HTTPS certificate presented by the SAS. Put every hostname and IP address the radios use in the SANs; issue one RSA and one ECDSA certificate to match WINNF-TS-0065.'}
          {kind === 'domain-proxy' && 'Client certificate for a Domain Proxy (ROLE_OPERATOR policy). One certificate can register many CBSDs.'}
          {kind === 'installer' && 'Certified Professional Installer certificate. Its key signs cpiSignatureData; the CPI is added to the registry so the SAS can verify the signature.'}
          {kind === 'sub-ca' && 'Intermediate CA with a WInnForum role. Issue it from the root, then issue end-entity certificates from it.'}
          {kind === 'root' && 'Self-signed root CA. Radios that should trust it need it in their trust store.'}
        </p>

        {kind !== 'root' && (
          <Field label="Issuing CA" error={err.parentId}>
            <IssuerSelect certs={kind === 'sub-ca' ? certs.filter((c) => c.kind === 'root' || c.kind === 'sub_ca' || c.kind === 'trusted') : certs} value={parentId} onChange={setParentId} />
          </Field>
        )}

        {kind === 'installer' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="CPI ID" error={err.cpiId} hint="Goes into professionalInstallerData.cpiId">
              <Input value={cpiId} onChange={(e) => setCpiId(e.target.value)} className="font-mono" aria-invalid={!!err.cpiId} />
            </Field>
            <Field label="CPI name" error={err.cpiName} hint="Certificate CN and cpiName">
              <Input value={cpiName} onChange={(e) => setCpiName(e.target.value)} aria-invalid={!!err.cpiName} />
            </Field>
          </div>
        ) : (
          <DnFields
            dn={dn}
            onChange={setDn}
            cnError={err.CN}
            cnHint={kind === 'server' ? 'Usually the SAS hostname; also used as SAN if none are given' : undefined}
          />
        )}

        {kind === 'server' && (
          <>
            <Field label="Subject alternative names" hint="Hostnames and IP addresses, comma or space separated">
              <Textarea rows={2} value={sans} onChange={(e) => setSans(e.target.value)} placeholder="sas.lab.local, 192.168.10.5, localhost" />
            </Field>
            <Field label="After issuing">
              <Segmented
                value={use}
                onChange={setUse}
                options={[
                  { value: '', label: 'Keep in store' },
                  { value: 'add', label: 'Add to HTTPS listener' },
                  { value: 'replace', label: 'Replace HTTPS certificates' },
                ]}
              />
            </Field>
          </>
        )}
        {kind === 'sub-ca' && (
          <Field label="Role" hint="Sets the WInnForum role policy carried by the CA">
            <Select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="cbsd">CBSD</option>
              <option value="operator">Domain proxy (operator)</option>
              <option value="installer">Professional installer</option>
              <option value="sas">SAS</option>
            </Select>
          </Field>
        )}
        {(kind === 'server' || kind === 'domain-proxy') && (
          <Field label="FCC Registration Number (optional)" hint="Adds the WInnForum FRN otherName">
            <Input value={frn} onChange={(e) => setFrn(e.target.value)} className="font-mono" />
          </Field>
        )}
        {kind === 'installer' && (
          <Switch checked={registerCpi} onChange={setRegisterCpi} label="Add this CPI to the registry" description="Lets the SAS verify cpiSignatureData signed with this key" />
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Key">
            <KeyTypeSelect value={keyType} onChange={setKeyType} />
          </Field>
          <Field label="Valid (days)" hint="Blank = default">
            <Input type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} className="num" />
          </Field>
          {kind !== 'installer' && (
            <Field label="Display name" hint="Blank = derived">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button type="submit" variant="primary" icon={FileKey2} loading={busy === 'issue'}>Issue</Button>
          {last && (
            <span className="flex min-w-0 items-center gap-2 text-sm text-ink-2">
              <span className="led" data-c="ok" aria-hidden />
              <span className="truncate">Issued “{last.name}” — open it in the inventory to download</span>
            </span>
          )}
        </div>
      </form>
    </Module>
  );
}

// ====================================================================== import + CRLs

function ImportPanel({ crls }: { crls?: CrlRow[] }) {
  const [tab, setTab] = useState<'pem' | 'p12' | 'crl'>('pem');
  return (
    <div className="space-y-4">
      <Module title="Import" bodyClass="p-0">
        <Tabs className="px-2" value={tab} onChange={setTab} tabs={[{ value: 'pem', label: 'PEM' }, { value: 'p12', label: 'PKCS#12' }, { value: 'crl', label: 'CRL' }]} />
        <div className="p-4">
          {tab === 'pem' && <ImportPem />}
          {tab === 'p12' && <ImportP12 />}
          {tab === 'crl' && <ImportCrl />}
        </div>
      </Module>
      <CrlTable crls={crls} />
    </div>
  );
}

function FilePick({ label, accept, multiple, onFiles }: { label: string; accept?: string; multiple?: boolean; onFiles: (f: File[]) => void }) {
  return (
    <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded border border-line-strong bg-panel px-2 text-sm font-medium text-ink transition-colors duration-150 hover:border-ink-3 hover:bg-panel-2 focus-within:outline focus-within:outline-2 focus-within:outline-sel">
      <FileUp className="size-3.5" aria-hidden />
      {label}
      <input
        type="file"
        className="sr-only"
        accept={accept}
        multiple={multiple}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </label>
  );
}

function ImportPem() {
  const { run, busy } = useAction();
  const toast = useToast();
  const [pem, setPem] = useState('');
  const [keyPem, setKeyPem] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [name, setName] = useState('');
  const submit = async () => {
    const r = await run('pem', () => api.post<CertRecord[]>('/api/certs/import', { pem, keyPem: keyPem || undefined, passphrase: passphrase || undefined, name: name || undefined }));
    if (r) toast.ok(`Imported ${r.length} certificate${r.length === 1 ? '' : 's'}`);
    if (r) {
      setPem('');
      setKeyPem('');
      setPassphrase('');
      setName('');
    }
  };
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm text-ink-3">Import a CA to trust its radios (e.g. a vendor or WInnForum test CA), or a certificate with its key to use as the SAS server certificate. A file may hold several certificates.</p>
      <Field label={<span className="flex items-center gap-2">Certificate(s) <FilePick label="Load file" accept=".pem,.crt,.cer,.txt" onFiles={async ([f]) => setPem(await f.text())} /></span>}>
        <Textarea rows={5} value={pem} onChange={(e) => setPem(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" />
      </Field>
      <Field label={<span className="flex items-center gap-2">Private key (optional) <FilePick label="Load file" accept=".pem,.key,.txt" onFiles={async ([f]) => setKeyPem(await f.text())} /></span>}>
        <Textarea rows={3} value={keyPem} onChange={(e) => setKeyPem(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Key passphrase"><Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" /></Field>
        <Field label="Display name (optional)"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      </div>
      <Button type="submit" variant="primary" icon={Upload} loading={busy === 'pem'} disabled={!pem.includes('BEGIN')}>Import</Button>
      <ImportedNote />
    </form>
  );
}

function ImportedNote() {
  return <p className="text-xs text-ink-3">Imported CA certificates are trusted for client authentication unless you restrict trust in the inventory.</p>;
}

function ImportP12() {
  const { run, busy } = useAction();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!file) return;
        const data = await fileToBase64(file);
        const r = await run('p12', () => api.post<CertRecord[]>('/api/certs/import-p12', { data, password, name: name || undefined }));
        if (r) toast.ok(`Imported ${r.length} certificate${r.length === 1 ? '' : 's'} from ${file.name}`);
        if (r) {
          setFile(null);
          setPassword('');
          setName('');
        }
      }}
    >
      <p className="text-sm text-ink-3">Certificate, key and chain from a .p12 / .pfx file. Legacy (RC2/3DES) files are supported.</p>
      <div className="flex items-center gap-3">
        <FilePick label={file ? 'Choose another file' : 'Choose .p12 / .pfx'} accept=".p12,.pfx" onFiles={([f]) => setFile(f)} />
        {file && <span className="truncate font-mono text-xs text-ink-2">{file.name}</span>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" /></Field>
        <Field label="Display name (optional)"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      </div>
      <Button type="submit" variant="primary" icon={Upload} loading={busy === 'p12'} disabled={!file}>Import</Button>
    </form>
  );
}

function ImportCrl() {
  const { run, busy } = useAction();
  const [files, setFiles] = useState<File[]>([]);
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!files.length) return;
        const payload = await Promise.all(files.map(async (f) => ({ name: f.name, data: await fileToBase64(f) })));
        const r = await run('crl', () => api.post('/api/crls', { files: payload }), `Imported ${files.length} CRL${files.length > 1 ? 's' : ''}`);
        if (r) setFiles([]);
      }}
    >
      <p className="text-sm text-ink-3">PEM or DER CRLs. With CRL checking on, every certificate in a client's chain is checked against the CRL of its issuer; revoked clients get HTTP 403.</p>
      <div className="flex flex-wrap items-center gap-3">
        <FilePick label="Choose CRL files" accept=".crl,.pem,.der" multiple onFiles={setFiles} />
        {files.length > 0 && <span className="text-sm text-ink-2">{files.map((f) => f.name).join(', ')}</span>}
      </div>
      <Button type="submit" variant="primary" icon={Upload} loading={busy === 'crl'} disabled={!files.length}>Import</Button>
    </form>
  );
}

function CrlTable({ crls }: { crls?: CrlRow[] }) {
  const { run } = useAction();
  const confirm = useConfirm();
  const del = async (c: CrlRow) => {
    if (!(await confirm({ title: `Delete CRL “${c.name}”?`, body: 'Certificates it lists are accepted again.', confirm: 'Delete', danger: true }))) return;
    await run(`crl-${c.id}`, () => api.del(`/api/crls/${encodeURIComponent(c.id)}`), 'CRL deleted');
  };
  return (
    <Module title="Imported CRLs" meta={crls ? `${crls.length}` : undefined} bodyClass="p-0">
      {!crls ? (
        <SkeletonRows rows={2} cols={4} />
      ) : !crls.length ? (
        <p className="px-3 py-4 text-sm text-ink-3">No CRLs imported. Revoking a certificate here takes effect without one; import CRLs from external CAs (e.g. the WInnForum test harness) to honour their revocations.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="dtable">
            <thead>
              <tr><th>Name</th><th>Issuer hash</th><th>This update</th><th>Next update</th><th className="text-right">Revoked</th><th /></tr>
            </thead>
            <tbody>
              {crls.map((c) => {
                const stale = c.nextUpdate !== null && c.nextUpdate < Date.now();
                return (
                  <tr key={c.id}>
                    <td className="max-w-[200px] truncate">{c.name}</td>
                    <td className="font-mono text-xs text-ink-2">{c.issuerHash}</td>
                    <td className="num whitespace-nowrap text-ink-2">{c.thisUpdate ? iso(c.thisUpdate).slice(0, 16).replace('T', ' ') : '—'}</td>
                    <td className="whitespace-nowrap">
                      <span className="num text-ink-2">{c.nextUpdate ? iso(c.nextUpdate).slice(0, 16).replace('T', ' ') : '—'}</span>
                      {stale && <Tag tone="warn" className="ml-2">stale</Tag>}
                    </td>
                    <td className="num text-right">{c.revokedCount}</td>
                    <td className="w-10 text-right">
                      <Button size="sm" variant="danger-ghost" icon={Trash2} onClick={() => del(c)} aria-label={`Delete ${c.name}`} title="Delete" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Module>
  );
}
