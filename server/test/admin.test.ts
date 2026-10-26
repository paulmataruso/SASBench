import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startSas, regRequest, code, type TestSas } from './helpers.ts';

// WInnForum test-harness admin API (POST <base>/admin/...) on the SAS listeners.

let sas: TestSas;

before(async () => {
  sas = await startSas();
});

after(async () => {
  await sas?.stop();
});

test('admin/reset accepts an empty body and clears CBSDs', async () => {
  const [r] = await sas.sas('registration', [regRequest('FCCADM', 'SN-A0')]);
  assert.equal(code(r), 0);
  const res = await sas.sasRaw('/admin/reset');
  assert.equal(res.status, 200);
  assert.equal((await sas.api('GET', '/api/cbsds')).length, 0);
});

test('requireKnownFccId: unknown FCC ID → 103, injected via admin API → 0', async () => {
  await sas.api('PUT', '/api/settings', { requireKnownFccId: true });
  try {
    const [r1] = await sas.sas('registration', [regRequest('FCCUNKNOWN', 'SN-A1')]);
    assert.equal(code(r1), 103);
    assert.deepEqual(r1.response.responseData, ['fccId']);

    const inj = await sas.sasRaw('/admin/injectdata/fcc_id', { fccId: 'FCCUNKNOWN', fccMaxEirp: 47 });
    assert.equal(inj.status, 200);
    const [r2] = await sas.sas('registration', [regRequest('FCCUNKNOWN', 'SN-A1')]);
    assert.equal(code(r2), 0, JSON.stringify(r2));
  } finally {
    await sas.api('PUT', '/api/settings', { requireKnownFccId: false });
  }
});

test('blacklist by FCC ID → 101', async () => {
  assert.equal((await sas.sasRaw('/admin/injectdata/blacklist_fcc_id', { fccId: 'FCCBLACK' })).status, 200);
  const [r] = await sas.sas('registration', [regRequest('FCCBLACK', 'SN-A2')]);
  assert.equal(code(r), 101);
});

test('daily activities status and unknown admin method', async () => {
  const st = await sas.sasRaw('/admin/get_daily_activities_status');
  assert.equal(st.status, 200);
  assert.deepEqual(st.body, { completed: true });
  assert.equal((await sas.sasRaw('/admin/no_such_method')).status, 404);
});

test('injectdata/zone returns a zone id', async () => {
  const r = await sas.sasRaw('/admin/injectdata/zone', {
    record: {
      id: 'zone/ppa/test/1',
      zone: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-122.1, 37.4], [-122.0, 37.4], [-122.0, 37.5], [-122.1, 37.5], [-122.1, 37.4]]] } }] },
      ppaInfo: { palId: ['pal/test/1'], cbsdReferenceId: [], ppaBeginDate: '2020-01-01T00:00:00Z', ppaExpirationDate: '2099-01-01T00:00:00Z' },
    },
  });
  assert.equal(r.status, 200);
  assert.equal(typeof r.body, 'string');
  assert.ok(r.body.length > 0);
});
