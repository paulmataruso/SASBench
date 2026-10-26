import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { startSas, cbsdIdFor, regRequest, grantRequest, code, type TestSas } from './helpers.ts';

// SAS-CBSD protocol (WINNF-TS-0016 v1.2) over the plain-HTTP listener.

let sas: TestSas;

before(async () => {
  sas = await startSas();
});

after(async () => {
  await sas?.stop();
});

async function register(fccId: string, serial: string): Promise<string> {
  const [r] = await sas.sas('registration', [regRequest(fccId, serial)]);
  assert.equal(code(r), 0, JSON.stringify(r));
  return r.cbsdId;
}

async function grant(cbsdId: string, lo: number, hi: number): Promise<string> {
  const [r] = await sas.sas('grant', [grantRequest(cbsdId, lo, hi)]);
  assert.equal(code(r), 0, JSON.stringify(r));
  return r.grantId;
}

const hb = (cbsdId: string, grantId: string, operationState = 'GRANTED') => sas.sas('heartbeat', [{ cbsdId, grantId, operationState }]);

describe('registration', () => {
  test('batch: success, missing parameter (102), invalid value (103) keep request order', async () => {
    const { userId: _drop, ...noUser } = regRequest('FCCBATCH', 'SN-B2');
    const badLat = regRequest('FCCBATCH', 'SN-B3');
    badLat.installationParam.latitude = 95;
    const res = await sas.sas('registration', [regRequest('FCCBATCH', 'SN-B1'), noUser, badLat]);
    assert.equal(res.length, 3);
    assert.equal(code(res[0]), 0);
    assert.equal(res[0].cbsdId, cbsdIdFor('FCCBATCH', 'SN-B1'));
    assert.equal(code(res[1]), 102);
    assert.deepEqual(res[1].response.responseData, ['userId']);
    assert.equal(res[1].cbsdId, undefined, 'no cbsdId on failure');
    assert.equal(code(res[2]), 103);
    assert.deepEqual(res[2].response.responseData, ['installationParam.latitude']);
    assert.equal(res[2].cbsdId, undefined);
  });

  test('incomplete REG-conditional data → 200 with the missing list', async () => {
    const req = regRequest('FCCPEND', 'SN-P1');
    delete (req as any).airInterface;
    const [r] = await sas.sas('registration', [req]);
    assert.equal(code(r), 200);
    assert.ok(r.response.responseData.includes('airInterface.radioTechnology'));
    assert.equal(r.cbsdId, undefined);
  });

  test('no installation data: 200 by default; with missingInstallParams=register the radio registers and gets a grant', async () => {
    // Like a Nokia AirScale BBU: Category B, no installationParam, nothing preloaded.
    const { installationParam: _none, ...req } = regRequest('FCCNOLOC', 'SN-NL1', { cbsdCategory: 'B' });
    const [held] = await sas.sas('registration', [req]);
    assert.equal(code(held), 200);
    assert.ok(held.response.responseData.includes('installationParam.antennaBeamwidth'));
    await assert.rejects(sas.api('PUT', '/api/settings', { missingInstallParams: 'always' }), /400/);
    await sas.api('PUT', '/api/settings', { missingInstallParams: 'register' });
    try {
      const [r] = await sas.sas('registration', [req]);
      assert.equal(code(r), 0, JSON.stringify(r));
      const gid = await grant(r.cbsdId, 3600, 3610);
      const [h] = await hb(r.cbsdId, gid);
      assert.equal(code(h), 0);
      // Other REG-conditional parameters are still required.
      const { airInterface: _a, ...noAir } = req;
      const [p] = await sas.sas('registration', [{ ...noAir, cbsdSerialNumber: 'SN-NL2' }]);
      assert.equal(code(p), 200);
      assert.ok(p.response.responseData.includes('airInterface.radioTechnology'));
    } finally {
      await sas.api('PUT', '/api/settings', { missingInstallParams: 'pending' });
    }
  });

  test('cbsdId is stable across re-registration and re-registration removes grants', async () => {
    const id1 = await register('FCCREREG', 'SN-R1');
    const gid = await grant(id1, 3550, 3560);
    const id2 = await register('FCCREREG', 'SN-R1');
    assert.equal(id2, id1);
    const [h] = await hb(id1, gid);
    assert.equal(code(h), 103, JSON.stringify(h));
    assert.equal(h.grantId, undefined, 'removed grants are unknown: no grantId echo');
    const grants = await sas.api('GET', `/api/grants?cbsdId=${encodeURIComponent(id1)}`);
    assert.equal(grants.find((g: any) => g.grantId === gid).state, 'DELETED');
  });
});

describe('spectrum inquiry', () => {
  test('returns GAA availability for the inquired range', async () => {
    const id = await register('FCCSIQ', 'SN-S1');
    const [r] = await sas.sas('spectrumInquiry', [{ cbsdId: id, inquiredSpectrum: [{ lowFrequency: 3550e6, highFrequency: 3700e6 }] }]);
    assert.equal(code(r), 0);
    assert.equal(r.cbsdId, id);
    assert.ok(Array.isArray(r.availableChannel) && r.availableChannel.length > 0);
    for (const ch of r.availableChannel) {
      assert.equal(ch.channelType, 'GAA');
      assert.equal(ch.ruleApplied, 'FCC_PART_96');
      assert.equal(typeof ch.maxEirp, 'number');
      assert.ok(ch.frequencyRange.lowFrequency >= 3550e6 && ch.frequencyRange.highFrequency <= 3700e6);
    }
  });

  test('inquiry outside the band → 300, missing inquiredSpectrum → 102', async () => {
    const id = await register('FCCSIQ', 'SN-S2');
    const res = await sas.sas('spectrumInquiry', [
      { cbsdId: id, inquiredSpectrum: [{ lowFrequency: 3700e6, highFrequency: 3710e6 }] },
      { cbsdId: id },
    ]);
    assert.equal(code(res[0]), 300);
    assert.equal(res[0].availableChannel, undefined, 'availableChannel only on success');
    assert.equal(code(res[1]), 102);
  });
});

describe('grant and heartbeat', () => {
  test('grant success, overlapping grant 401, out-of-band 300', async () => {
    const id = await register('FCCGRANT', 'SN-G1');
    const res = await sas.sas('grant', [grantRequest(id, 3550, 3560), grantRequest(id, 3555, 3565), grantRequest(id, 3700, 3710)]);
    assert.equal(code(res[0]), 0);
    assert.match(res[0].grantId, /^\d+$/);
    assert.match(res[0].grantExpireTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(res[0].heartbeatInterval, 60);
    assert.equal(res[0].channelType, 'GAA');
    assert.equal(code(res[1]), 401, 'second object in the batch sees the first grant');
    assert.deepEqual(res[1].response.responseData, [res[0].grantId]);
    assert.equal(code(res[2]), 300);
  });

  test('heartbeat authorizes the grant with transmitExpireTime ≤ now + 240 s', async () => {
    const id = await register('FCCHBT', 'SN-H1');
    const gid = await grant(id, 3560, 3570);
    const before = Math.floor(Date.now() / 1000) * 1000;
    const [h] = await hb(id, gid, 'GRANTED');
    assert.equal(code(h), 0, JSON.stringify(h));
    assert.equal(h.cbsdId, id);
    assert.equal(h.grantId, gid);
    const tx = Date.parse(h.transmitExpireTime);
    assert.ok(tx > before, 'transmitExpireTime in the future');
    assert.ok(tx <= Date.now() + 240_000, 'transmitExpireTime at most 240 s ahead');
    const [g] = await sas.api('GET', `/api/grants?cbsdId=${encodeURIComponent(id)}`);
    assert.equal(g.state, 'AUTHORIZED');
    const [h2] = await hb(id, gid, 'AUTHORIZED');
    assert.equal(code(h2), 0);
  });

  test('missing operationState → 102 with grantId echo; unknown grantId → 103', async () => {
    const id = await register('FCCHBT', 'SN-H2');
    const gid = await grant(id, 3570, 3580);
    const res = await sas.sas('heartbeat', [{ cbsdId: id, grantId: gid }, { cbsdId: id, grantId: '999', operationState: 'GRANTED' }]);
    assert.equal(code(res[0]), 102);
    assert.equal(res[0].grantId, gid);
    assert.ok(res[0].transmitExpireTime, 'heartbeat responses always carry transmitExpireTime');
    assert.equal(code(res[1]), 103);
  });

  test('administrative suspension → 501, resume → 0; termination → 500', async () => {
    const id = await register('FCCSUSP', 'SN-U1');
    const gid = await grant(id, 3580, 3590);
    assert.equal(code((await hb(id, gid, 'GRANTED'))[0]), 0);

    await sas.api('POST', `/api/grants/${gid}/suspend`, {});
    const [s] = await hb(id, gid, 'AUTHORIZED');
    assert.equal(code(s), 501, JSON.stringify(s));
    assert.ok(Date.parse(s.transmitExpireTime) <= Date.now(), 'suspended: transmitExpireTime not in the future');

    await sas.api('POST', `/api/grants/${gid}/suspend`, { suspended: false });
    assert.equal(code((await hb(id, gid, 'GRANTED'))[0]), 0);

    await sas.api('POST', `/api/grants/${gid}/terminate`, { reason: 'test' });
    const [t] = await hb(id, gid, 'AUTHORIZED');
    assert.equal(code(t), 500);
    assert.equal(t.grantId, gid);
  });

  test('CBSD reporting AUTHORIZED before its first heartbeat → 502', async () => {
    const id = await register('FCCUNSYNC', 'SN-X1');
    const gid = await grant(id, 3590, 3600);
    const [h] = await hb(id, gid, 'AUTHORIZED');
    assert.equal(code(h), 502);
  });
});

describe('relinquishment and deregistration', () => {
  test('relinquishment succeeds once, then 103', async () => {
    const id = await register('FCCRELQ', 'SN-L1');
    const gid = await grant(id, 3600, 3610);
    const [r1] = await sas.sas('relinquishment', [{ cbsdId: id, grantId: gid }]);
    assert.equal(code(r1), 0);
    assert.equal(r1.grantId, gid);
    const [r2] = await sas.sas('relinquishment', [{ cbsdId: id, grantId: gid }]);
    assert.equal(code(r2), 103);
    assert.equal(code((await hb(id, gid))[0]), 103, 'heartbeat on a relinquished grant');
    const [r3] = await sas.sas('relinquishment', [{ grantId: gid }]);
    assert.equal(code(r3), 102);
  });

  test('deregistration succeeds once, then the cbsdId is unknown (103)', async () => {
    const id = await register('FCCDEREG', 'SN-D1');
    const gid = await grant(id, 3610, 3620);
    const [d1] = await sas.sas('deregistration', [{ cbsdId: id }]);
    assert.equal(code(d1), 0);
    assert.equal(d1.cbsdId, id);
    const [d2] = await sas.sas('deregistration', [{ cbsdId: id }]);
    assert.equal(code(d2), 103);
    assert.equal(code((await hb(id, gid))[0]), 103);
  });

  test('administrator-initiated deregistration: next request gets 105, then 103', async () => {
    const id = await register('FCC105', 'SN-105');
    const gid = await grant(id, 3620, 3630);
    await sas.api('POST', `/api/cbsds/${encodeURIComponent(id)}/deregister`, {});
    const [h] = await hb(id, gid);
    assert.equal(code(h), 105, JSON.stringify(h));
    assert.equal(h.cbsdId, id);
    const [h2] = await hb(id, gid);
    assert.equal(code(h2), 103);
    const c = await sas.api('GET', `/api/cbsds/${encodeURIComponent(id)}`);
    assert.equal(c.state, 'UNREGISTERED');
  });
});

describe('transport', () => {
  test('unsupported protocol version → HTTP 404', async () => {
    const r = await sas.sasRaw('/v9.9/registration', { registrationRequest: [regRequest('FCCVER', 'SN-V1')] });
    assert.equal(r.status, 404);
  });

  test('unknown method → HTTP 404; malformed JSON → HTTP 400', async () => {
    assert.equal((await sas.sasRaw('/v1.2/foo', {})).status, 404);
    const res = await fetch(`http://127.0.0.1:${sas.httpPort}/v1.2/registration`, { method: 'POST', body: '{not json' });
    assert.equal(res.status, 400);
  });

  test('every exchange is recorded in the wire log', async () => {
    const msgs = await sas.api('GET', '/api/messages?method=grant&limit=50');
    assert.ok(msgs.length > 0);
    assert.ok(msgs.every((m: any) => m.method === 'grant' && m.transport === 'http'));
  });
});
