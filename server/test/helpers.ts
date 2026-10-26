import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Starts the real SAS (node server/src/index.ts) in a child process with its own data directory
// and free ports, for black-box integration tests over the network interfaces.

const ROOT = path.resolve(import.meta.dirname, '..', '..');

export interface TestSas {
  uiPort: number;
  httpPort: number;
  httpsPort: number;
  dataDir: string;
  log: () => string;
  /** POST a SAS-CBSD request over HTTP; returns the response array. */
  sas: (method: string, items: unknown[], version?: string) => Promise<any[]>;
  /** Raw POST to the plain-HTTP SAS listener. */
  sasRaw: (urlPath: string, body?: unknown) => Promise<{ status: number; body: any }>;
  /** UI REST API call. */
  api: (method: string, urlPath: string, body?: unknown) => Promise<any>;
  /** UI REST API call returning the raw response body as text. */
  apiText: (urlPath: string) => Promise<string>;
  stop: () => Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function distinctPorts(n: number): Promise<number[]> {
  const out = new Set<number>();
  while (out.size < n) out.add(await freePort());
  return [...out];
}

export async function startSas(env: Record<string, string> = {}): Promise<TestSas> {
  const [uiPort, httpPort, httpsPort] = await distinctPorts(3);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbrs-sas-test-'));
  let output = '';
  const child: ChildProcess = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      SAS_DATA_DIR: dataDir,
      UI_PORT: String(uiPort),
      SAS_HTTP_PORT: String(httpPort),
      SAS_HTTPS_PORT: String(httpsPort),
      SAS_TERRAIN_DIR: path.join(dataDir, 'no-terrain'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));
  let exited = false;
  child.on('exit', () => (exited = true));

  const ui = `http://127.0.0.1:${uiPort}`;
  const api = async (method: string, urlPath: string, body?: unknown) => {
    const res = await fetch(ui + urlPath, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${urlPath} → ${res.status}: ${text}`);
    return data;
  };
  const apiText = async (urlPath: string) => {
    const res = await fetch(ui + urlPath);
    if (!res.ok) throw new Error(`GET ${urlPath} → ${res.status}`);
    return res.text();
  };
  const sasRaw = async (urlPath: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${httpPort}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch { /* not JSON */ }
    return { status: res.status, body: parsed };
  };
  const sas = async (method: string, items: unknown[], version = 'v1.2') => {
    const r = await sasRaw(`/${version}/${method}`, { [`${method}Request`]: items });
    if (r.status !== 200) throw new Error(`${method} → HTTP ${r.status}: ${JSON.stringify(r.body)}`);
    const arr = r.body?.[`${method}Response`];
    if (!Array.isArray(arr)) throw new Error(`${method}: no ${method}Response array in ${JSON.stringify(r.body)}`);
    return arr;
  };

  // First start generates the lab PKI (several RSA keys), so allow plenty of time.
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (exited) throw new Error(`SAS exited during startup:\n${output}`);
    try {
      const s = await api('GET', '/api/status');
      if (s.listeners.http.listening && s.listeners.https.listening) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`SAS did not start within 120 s:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  const stop = async () => {
    if (!exited) {
      const done = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
      if (!exited) child.kill('SIGKILL');
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  };

  return { uiPort, httpPort, httpsPort, dataDir, log: () => output, sas, sasRaw, api, apiText, stop };
}

export function cbsdIdFor(fccId: string, serial: string): string {
  return `${fccId}/${crypto.createHash('sha1').update(serial).digest('hex')}`;
}

/** A complete Category A (indoor) registration request. */
export function regRequest(fccId: string, serial: string, extra: Record<string, any> = {}) {
  return {
    userId: 'lab-user',
    fccId,
    cbsdSerialNumber: serial,
    cbsdCategory: 'A',
    airInterface: { radioTechnology: 'E_UTRA' },
    measCapability: [],
    installationParam: {
      latitude: 37.425, longitude: -122.084, height: 5, heightType: 'AGL', indoorDeployment: true,
      antennaGain: 5, eirpCapability: 26,
    },
    ...extra,
  };
}

export function grantRequest(cbsdId: string, lowMHz: number, highMHz: number, maxEirp = 10) {
  return { cbsdId, operationParam: { maxEirp, operationFrequencyRange: { lowFrequency: lowMHz * 1e6, highFrequency: highMHz * 1e6 } } };
}

export const code = (r: any): number => r?.response?.responseCode;
