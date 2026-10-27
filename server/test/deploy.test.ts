import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { freePort, regRequest, startSas, type TestSas } from './helpers.ts';
import { hostOrIp, lanIPv4 } from '../src/net/addresses.ts';

// Deployment settings from the environment (.env): SAS_FQDN, SAS_BIND_IP, SAS_API_PORT,
// SAS_PROFILE / SAS_PROFILE_APPLY, and blank values counting as unset.

const ADMIN = { Authorization: `Basic ${Buffer.from('admin:admin').toString('base64')}` };
const json = async (url: string) => {
  const r = await fetch(url, { headers: ADMIN });
  return { status: r.status, body: await r.json() as any };
};

/** Resolves true when a TCP connection to host:port is accepted. */
const connects = (host: string, port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect({ host, port });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

describe('deployment settings', () => {
  const started: TestSas[] = [];
  const dirs: string[] = [];
  after(async () => {
    for (const s of started) await s.stop();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('checks host names and addresses', () => {
    assert.equal(hostOrIp('SAS.Lab.Example.com.'), 'sas.lab.example.com');
    assert.equal(hostOrIp('192.168.10.5'), '192.168.10.5');
    assert.equal(hostOrIp('fe80::1'), 'fe80::1');
    assert.equal(hostOrIp('not a host'), null);
    assert.equal(hostOrIp('-bad.example'), null);
    assert.ok(lanIPv4().every((ip) => !ip.startsWith('127.')));
  });

  it('binds one address, serves the API on its own port, and advertises the FQDN', async () => {
    const apiPort = await freePort();
    const sas = await startSas({
      SAS_BIND_IP: '127.0.0.1', SAS_API_PORT: String(apiPort), SAS_FQDN: 'SAS.Deploy.Test', SAS_HOSTNAMES: '  ', SAS_PROFILE: '',
    });
    started.push(sas);
    const api = `http://127.0.0.1:${apiPort}/api/v1`;

    // The API port serves the public API, and only that; the UI port still serves it too.
    assert.equal((await json(`${api}/health`)).body.status, 'ok');
    const other = await json(`http://127.0.0.1:${apiPort}/api/status`);
    assert.deepEqual([other.status, other.body.error.code], [404, 'not_found']);
    assert.equal((await json(`http://127.0.0.1:${sas.uiPort}/api/v1/health`)).status, 200);

    const sys = (await json(`${api}/system`)).body;
    assert.deepEqual([sys.apiPort, sys.uiPort, sys.bindIp], [apiPort, sas.uiPort, '127.0.0.1']);
    assert.deepEqual(sys.advertised, ['sas.deploy.test', '127.0.0.1']);
    assert.equal(sys.hostnames[0], 'sas.deploy.test');

    // Endpoints list the FQDN and the bound address only.
    const status = (await json(`${api}/status`)).body;
    assert.deepEqual(status.urls, [
      `https://sas.deploy.test:${sas.httpsPort}/v1.2/`, `http://sas.deploy.test:${sas.httpPort}/v1.2/`,
      `https://127.0.0.1:${sas.httpsPort}/v1.2/`, `http://127.0.0.1:${sas.httpPort}/v1.2/`,
    ]);
    assert.deepEqual((await sas.api('GET', '/api/status')).urls, status.urls);

    // The auto server certificates name the FQDN first.
    const tls = (await json(`${api}/tls`)).body;
    const srv = (await json(`${api}/certs/${tls.serverCertIds[0]}`)).body;
    const x509 = new crypto.X509Certificate(srv.pem);
    assert.match(x509.subject, /CN=sas\.deploy\.test/);
    assert.match(x509.subjectAltName ?? '', /DNS:sas\.deploy\.test/);

    // Nothing listens on the machine's other addresses.
    const lan = lanIPv4()[0];
    if (lan) {
      assert.equal(await connects(lan, sas.uiPort), false);
      assert.equal(await connects(lan, apiPort), false);
      assert.equal(await connects(lan, sas.httpPort), false);
    }
    // Requests sent through the listeners reach the bound address.
    const reg = await fetch(`${api}/sas/registration?transport=http`, {
      method: 'POST', headers: { ...ADMIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ registrationRequest: [regRequest('DEPLOY-FCC', 'SN-D1')] }),
    });
    const regBody = await reg.json() as any;
    assert.equal(regBody.httpStatus, 200, JSON.stringify(regBody));
    assert.equal(regBody.body.registrationResponse[0].response.responseCode, 0);
  });

  it('refuses invalid addressing settings', async () => {
    await assert.rejects(startSas({ SAS_BIND_IP: 'not-an-ip' }), /SAS_BIND_IP must be an IP address/);
    await assert.rejects(startSas({ SAS_FQDN: 'bad host!' }), /SAS_FQDN must be a host name/);
    await assert.rejects(startSas({ SAS_API_PORT: '70000' }), /SAS_API_PORT must be a port number/);
  });

  it('applies SAS_PROFILE on first start and when it changes, or always', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sasbench-profile-'));
    dirs.push(dataDir);
    const restart = async (env: Record<string, string>) => {
      const s = await startSas(env, { dataDir });
      const st = await s.api('GET', '/api/status');
      const settings = (await s.api('GET', '/api/settings')).settings;
      await s.stop();
      return { profile: st.profile, settings, log: s.log() };
    };
    const first = await restart({ SAS_PROFILE: 'winnforum' });
    assert.equal(first.profile, 'winnforum');
    assert.match(first.log, /Applied the winnforum settings profile/);

    // A change made in Settings survives a restart with the same SAS_PROFILE...
    const s = await startSas({ SAS_PROFILE: 'winnforum' }, { dataDir });
    await s.api('PUT', '/api/settings', { requireKnownFccId: !first.settings.requireKnownFccId });
    await s.stop();
    const same = await restart({ SAS_PROFILE: 'winnforum' });
    assert.equal(same.settings.requireKnownFccId, !first.settings.requireKnownFccId);
    assert.doesNotMatch(same.log, /Applied the/);

    // ...unless SAS_PROFILE_APPLY=always, and a new value is applied once.
    const always = await restart({ SAS_PROFILE: 'winnforum', SAS_PROFILE_APPLY: 'always' });
    assert.equal(always.profile, 'winnforum');
    const lab = await restart({ SAS_PROFILE: 'lab' });
    assert.equal(lab.profile, 'lab');
    const bogus = await restart({ SAS_PROFILE: 'nope' });
    assert.match(bogus.log, /SAS_PROFILE "nope" is not a profile/);
    assert.equal(bogus.profile, 'lab');
  });
});
