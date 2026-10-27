import crypto from 'node:crypto';
import { jparse } from '../../../db.ts';
import { upsertPpa, upsertProtection } from '../../../api.ts';
import { cbsdViewFromRow } from '../../../sas/policy.ts';
import type { Route, V1Deps } from '../http.ts';
import { Reply, badRequest, conflict, created, noContent, notFound } from '../http.ts';
import { S, ref, toMs, type Schema } from '../schema.ts';
import { incumbentOut, ppaOut, protectionOut } from '../mappers.ts';
import { Where, noContentResp, ok, okRef, pageOf, pageQuery, sqlPage } from './common.ts';

// Spectrum: the band overview, protections (administrator blocks, DPAs, ESC, FSS, exclusion zones),
// DPAs from the NTIA KML files, PAL Protection Areas and injected incumbent data.

export const PROTECTION_KINDS = ['ADMIN', 'ESC', 'FSS', 'EXCLUSION', 'DPA', 'GWPZ', 'FSS_GWBL', 'EXCLUSION_ZONE'];
export const INCUMBENT_KINDS = ['fss', 'wisp', 'pal', 'zone', 'exclusion_zone', 'peer_sas', 'esc_sensor', 'sas_admin', 'fad_cbsd', 'database_url'];
const DPA_FILES = ['E-DPAs.kml', 'P-DPAs.kml'];

const idParam = (what: string) => ({ id: { description: `${what} id. Percent-encode it in the path if it contains "/".` } });
const channelPair = S.arr(S.hz(), { minItems: 2, maxItems: 2, description: '[lowHz, highHz]' });

const protectionBody = (withId: boolean): Schema => S.obj({
  ...(withId ? { id: S.str({ minLength: 1, maxLength: 200, description: 'Id to use; generated when omitted.' }) } : {}),
  name: S.str({ minLength: 1, maxLength: 200 }),
  kind: S.enum(PROTECTION_KINDS, { default: 'ADMIN' }),
  low: S.hz({ description: 'Protected band, lower edge (Hz).' }),
  high: S.hz({ description: 'Protected band, upper edge (Hz).' }),
  active: S.bool({ default: false, description: 'Only active protections are enforced.' }),
  channels: S.nullable(S.arr(channelPair, { description: 'Active sub-channels. Null or empty: the whole band when active.' })),
  action: S.enum(['suspend', 'terminate'], { default: 'suspend', description: 'What happens to grants it hits: 501 suspension or 500 termination at the next heartbeat.' }),
  geometry: S.nullable(S.anyObj({ description: 'GeoJSON geometry, Feature or FeatureCollection. Null with no point: band-wide (every CBSD).' })),
  latitude: S.nullable(S.num({ minimum: -90, maximum: 90 })),
  longitude: S.nullable(S.num({ minimum: -180, maximum: 180 })),
  radiusKm: S.nullable(S.num({ minimum: 0, description: 'With latitude/longitude: protect within this radius. With geometry: neighbourhood distance.' })),
  neighborhood: S.nullable(S.anyObj({ description: 'Neighbourhood distances (km) by CBSD class, as in the NTIA DPA files.' })),
  notes: S.nullable(S.str({ maxLength: 2000 })),
}, ['name', 'low', 'high']);

const protectionExample = { name: 'Bench shield test', kind: 'ADMIN', low: 3550000000, high: 3560000000, active: true, action: 'suspend' };

function protection(d: V1Deps, id: string) {
  const p = d.db.get('SELECT * FROM protections WHERE id = ?', id);
  if (!p) throw notFound('Protection');
  return protectionOut(p);
}

function checkBand(b: any) {
  if (!(b.low < b.high)) throw badRequest('low must be below high');
  for (const [i, [l, h]] of (b.channels ?? []).entries()) if (!(l < h)) throw badRequest(`channels[${i}]: low must be below high`);
}

const ppaBody = (withId: boolean): Schema => S.obj({
  ...(withId ? { id: S.str({ minLength: 1, maxLength: 300, description: 'Id to use; generated when omitted.' }) } : {}),
  name: S.str({ minLength: 1, maxLength: 200 }),
  channels: S.arr(S.obj({
    low: S.hz(), high: S.hz(), palId: S.nullable(S.str()), licenseExpiration: S.nullable(S.time()),
  }, ['low', 'high']), { minItems: 1, description: 'PAL channels of the PPA.' }),
  members: S.arr(S.str(), { description: 'cbsdIds in the PPA cluster: they may use the PAL channels; other CBSDs inside the area may not.' }),
  geometry: S.nullable(S.anyObj({ description: 'GeoJSON area. Null: the PPA applies to its members anywhere and excludes no one.' })),
  expiration: S.nullable(S.time({ description: 'When the PPA ends.' })),
}, ['name', 'channels']);

const ppaIn = (b: any) => ({
  ...b,
  expiration: b.expiration == null ? null : toMs(b.expiration),
  channels: b.channels.map((c: any) => ({ ...c, licenseExpiration: c.licenseExpiration == null ? null : toMs(c.licenseExpiration) })),
});

function ppa(d: V1Deps, id: string) {
  const p = d.db.get('SELECT * FROM ppas WHERE id = ?', id);
  if (!p) throw notFound('PPA');
  return ppaOut(p);
}

function incumbent(d: V1Deps, kind: string, id: string) {
  const r = d.db.get('SELECT * FROM harness_data WHERE kind = ? AND id = ?', kind, id);
  if (!r) throw notFound('Incumbent record');
  return incumbentOut(r);
}

export const spectrumRoutes: Route[] = [
  {
    method: 'GET', path: '/spectrum', operationId: 'getSpectrum', tag: 'Spectrum', scope: 'read',
    summary: 'Band overview',
    description: 'The managed band and GAA ranges, every protection and PPA, live grants with their CBSD locations, registered CBSD locations and injected incumbents: everything the Spectrum page draws.',
    responses: okRef('Spectrum overview.', 'Spectrum'),
    handler: ({ d }) => {
      const s = d.settings.get();
      return {
        band: { low: s.bandLowHz, high: s.bandHighHz }, gaaRanges: s.gaaRanges,
        protections: d.db.all('SELECT * FROM protections ORDER BY kind, name').map(protectionOut),
        ppas: d.db.all('SELECT * FROM ppas ORDER BY created_at').map(ppaOut),
        grants: d.db.all(`SELECT g.grant_id, g.cbsd_id, g.state, g.suspended, g.low_freq, g.high_freq, g.max_eirp, g.channel_type,
          c.effective FROM grants g JOIN cbsds c ON c.cbsd_id = g.cbsd_id WHERE g.state IN ('GRANTED','AUTHORIZED') ORDER BY g.low_freq`).map((g) => {
          const ip = jparse<any>(g.effective, {}).installationParam ?? {};
          return {
            grantId: g.grant_id, cbsdId: g.cbsd_id, state: g.state, suspended: !!g.suspended, low: g.low_freq, high: g.high_freq,
            maxEirp: g.max_eirp, channelType: g.channel_type, lat: ip.latitude ?? null, lon: ip.longitude ?? null,
          };
        }),
        cbsds: d.db.all("SELECT cbsd_id, fcc_id, serial, category, effective, state FROM cbsds WHERE state = 'REGISTERED' ORDER BY cbsd_id").map((c) => {
          const v = cbsdViewFromRow(c);
          return { cbsdId: c.cbsd_id, fccId: c.fcc_id, serial: c.serial, category: v.category, lat: v.lat, lon: v.lon, indoor: v.indoor };
        }),
        incumbents: Object.fromEntries(INCUMBENT_KINDS.map((k) => [k, d.admin.data(k)])),
      };
    },
  },

  // ---------------------------------------------------------------- protections
  {
    method: 'GET', path: '/protections', operationId: 'listProtections', tag: 'Protections', scope: 'read',
    summary: 'List protections',
    description: 'Administrator blocks, DPAs, ESC and FSS protections, exclusion zones and the protections derived from injected incumbent data.',
    query: {
      kind: { description: 'Only this kind.', schema: S.enum(PROTECTION_KINDS) },
      active: { description: 'Only active (or inactive) protections.', schema: S.bool() },
      source: { description: 'Only this source: ui (operator), ntia-e-dpa, ntia-p-dpa or harness.', schema: S.str() },
      ...pageQuery(),
    },
    responses: ok('A page of protections.', pageOf('Protection')),
    handler: ({ d, query }) => {
      const w = new Where();
      if (query.kind) w.add('kind = ?', query.kind);
      if (query.active !== undefined) w.add('active = ?', query.active ? 1 : 0);
      if (query.source) w.add('source = ?', query.source);
      return sqlPage(d.db, 'protections', w, 'kind, name, id', query, protectionOut);
    },
  },
  {
    method: 'POST', path: '/protections', operationId: 'createProtection', tag: 'Protections', scope: 'write', errors: [409],
    summary: 'Create a protection',
    description: 'Active protections remove spectrum from availability for the CBSDs they cover; grants they hit are suspended or terminated at the next heartbeat. A band-wide protection (no geometry, no point) covers every CBSD.',
    body: { required: true, schema: protectionBody(true), example: protectionExample },
    responses: { 201: { description: 'Created.', schema: ref('Protection') } },
    handler: ({ d, body }) => {
      checkBand(body);
      const id = body.id || `ui:${crypto.randomUUID()}`;
      if (d.db.get('SELECT 1 FROM protections WHERE id = ?', id)) throw conflict(`A protection with id ${id} already exists (use PUT to replace it)`);
      upsertProtection(d.db, id, { ...body, source: 'ui' });
      d.bus.event('info', 'admin', `Protection "${body.name}" saved (${body.kind ?? 'ADMIN'}, ${body.active ? 'active' : 'inactive'})`);
      d.bus.changed('spectrum');
      return created(protection(d, id), `/protections/${encodeURIComponent(id)}`);
    },
  },
  {
    method: 'GET', path: '/protections/{id}', operationId: 'getProtection', tag: 'Protections', scope: 'read',
    summary: 'Get a protection', params: idParam('Protection'),
    responses: okRef('The protection.', 'Protection'),
    handler: ({ d, params }) => protection(d, params.id),
  },
  {
    method: 'PUT', path: '/protections/{id}', operationId: 'putProtection', tag: 'Protections', scope: 'write',
    summary: 'Create or replace a protection',
    description: '201 when created, 200 when replaced. Protections derived from harness data are rebuilt whenever incumbent data changes.',
    params: idParam('Protection'),
    body: { required: true, schema: protectionBody(false), example: protectionExample },
    responses: { 200: { description: 'Replaced.', schema: ref('Protection') }, 201: { description: 'Created.', schema: ref('Protection') } },
    handler: ({ d, params, body }) => {
      checkBand(body);
      const existed = !!d.db.get('SELECT 1 FROM protections WHERE id = ?', params.id);
      upsertProtection(d.db, params.id, { ...body, source: 'ui' });
      d.bus.event('info', 'admin', `Protection "${body.name}" ${existed ? 'updated' : 'saved'} (${body.active ? 'active' : 'inactive'})`);
      d.bus.changed('spectrum');
      const out = protection(d, params.id);
      return existed ? out : created(out, `/protections/${encodeURIComponent(params.id)}`);
    },
  },
  {
    method: 'DELETE', path: '/protections/{id}', operationId: 'deleteProtection', tag: 'Protections', scope: 'write',
    summary: 'Delete a protection', params: idParam('Protection'),
    responses: noContentResp('Deleted.'),
    handler: ({ d, params }) => {
      if (!d.db.run('DELETE FROM protections WHERE id = ?', params.id).changes) throw notFound('Protection');
      d.bus.changed('spectrum');
      return noContent();
    },
  },
  {
    method: 'POST', path: '/protections/{id}/activate', operationId: 'activateProtection', tag: 'Protections', scope: 'write',
    summary: 'Activate a protection',
    description: 'Optionally on selected sub-channels only. Grants it hits are suspended (or terminated) at their next heartbeat.',
    params: idParam('Protection'),
    body: { schema: S.obj({ channels: S.nullable(S.arr(channelPair, { description: 'Sub-channels to activate. Omit for the whole band.' })) }), example: { channels: [[3550000000, 3560000000]] } },
    responses: okRef('The protection.', 'Protection'),
    handler: ({ d, params, body }) => {
      const p = protection(d, params.id);
      const ch: number[][] | null = body.channels?.length ? body.channels : null;
      for (const [i, [l, h]] of (ch ?? []).entries()) if (!(l < h)) throw badRequest(`channels[${i}]: low must be below high`);
      d.db.run('UPDATE protections SET active = 1, channels = ?, updated_at = ? WHERE id = ?', ch ? JSON.stringify(ch) : null, Date.now(), params.id);
      d.bus.event('warn', 'admin', `${p.kind} ${p.name} ACTIVATED${ch ? ' on ' + ch.map((c) => `${c[0] / 1e6}–${c[1] / 1e6}`).join(', ') + ' MHz' : ''}`);
      d.bus.changed('spectrum');
      return protection(d, params.id);
    },
  },
  {
    method: 'POST', path: '/protections/{id}/deactivate', operationId: 'deactivateProtection', tag: 'Protections', scope: 'write',
    summary: 'Deactivate a protection', params: idParam('Protection'),
    responses: okRef('The protection.', 'Protection'),
    handler: ({ d, params }) => {
      const p = protection(d, params.id);
      d.db.run('UPDATE protections SET active = 0, channels = NULL, updated_at = ? WHERE id = ?', Date.now(), params.id);
      d.bus.event('warn', 'admin', `${p.kind} ${p.name} deactivated`);
      d.bus.changed('spectrum');
      return protection(d, params.id);
    },
  },

  // ---------------------------------------------------------------- DPAs
  {
    method: 'GET', path: '/dpas', operationId: 'listDpas', tag: 'DPAs', scope: 'read',
    summary: 'List loaded DPAs',
    description: 'Dynamic Protection Areas loaded from the NTIA KML files (protections of kind DPA), and the files available to load.',
    query: { active: { description: 'Only active (or inactive) DPAs.', schema: S.bool() }, ...pageQuery() },
    responses: ok('A page of DPAs.', S.obj({
      items: S.arr(ref('Protection')), total: S.int(), limit: S.int(), offset: S.int(), files: S.arr(S.str()),
    }, ['items', 'total', 'limit', 'offset', 'files'])),
    handler: ({ d, query }) => {
      const w = new Where().add("kind = 'DPA'");
      if (query.active !== undefined) w.add('active = ?', query.active ? 1 : 0);
      return { ...sqlPage(d.db, 'protections', w, 'name, id', query, protectionOut), files: DPA_FILES };
    },
  },
  {
    method: 'POST', path: '/dpas/load', operationId: 'loadDpas', tag: 'DPAs', scope: 'write',
    summary: 'Load DPAs from an NTIA file',
    description: '`E-DPAs.kml`: ESC-monitored coastal DPAs. `P-DPAs.kml`: portal DPAs. Already loaded DPAs are kept (and activated when `activate` is true).',
    body: { schema: S.obj({ file: S.enum(DPA_FILES, { default: 'E-DPAs.kml' }), activate: S.bool({ default: false }) }), example: { file: 'E-DPAs.kml', activate: false } },
    responses: ok('How many DPAs the file holds.', S.obj({ loaded: S.int() }, ['loaded'])),
    handler: ({ d, body }) => ({ loaded: d.admin.loadDpas(body.file ?? 'E-DPAs.kml', !!body.activate) }),
  },
  {
    method: 'POST', path: '/dpas/activate-all', operationId: 'activateAllDpas', tag: 'DPAs', scope: 'write',
    summary: 'Activate every DPA on all channels', description: 'Same as the harness call trigger/bulk_dpa_activation with activate=true.',
    responses: ok('How many DPAs are now active.', S.obj({ active: S.int() }, ['active'])),
    handler: ({ d }) => {
      d.admin.bulkDpaActivation(true);
      return { active: d.db.get("SELECT COUNT(*) AS n FROM protections WHERE kind = 'DPA' AND active = 1")?.n ?? 0 };
    },
  },
  {
    method: 'POST', path: '/dpas/deactivate-all', operationId: 'deactivateAllDpas', tag: 'DPAs', scope: 'write',
    summary: 'Deactivate every DPA', description: 'Same as the harness call trigger/bulk_dpa_activation with activate=false.',
    responses: ok('How many DPAs are still active (0).', S.obj({ active: S.int() }, ['active'])),
    handler: ({ d }) => {
      d.admin.bulkDpaActivation(false);
      return { active: d.db.get("SELECT COUNT(*) AS n FROM protections WHERE kind = 'DPA' AND active = 1")?.n ?? 0 };
    },
  },
  {
    method: 'POST', path: '/dpas/{dpaId}/channels/activate', operationId: 'activateDpaChannel', tag: 'DPAs', scope: 'write',
    summary: 'Activate a DPA on one channel',
    description: 'Same as the harness call trigger/dpa_activation. `dpaId` is the DPA name (e.g. "East1") or its protection id ("dpa:East1").',
    params: { dpaId: { description: 'DPA name or protection id.' } },
    body: { required: true, schema: S.obj({ lowFrequency: S.hz(), highFrequency: S.hz() }, ['lowFrequency', 'highFrequency']), example: { lowFrequency: 3550000000, highFrequency: 3560000000 } },
    responses: okRef('The DPA.', 'Protection'),
    handler: ({ d, params, body }) => dpaChannel(d, params.dpaId, body, true),
  },
  {
    method: 'POST', path: '/dpas/{dpaId}/channels/deactivate', operationId: 'deactivateDpaChannel', tag: 'DPAs', scope: 'write',
    summary: 'Deactivate a DPA on one channel',
    description: 'Same as the harness call trigger/dpa_deactivation. A wider active range is split around the channel.',
    params: { dpaId: { description: 'DPA name or protection id.' } },
    body: { required: true, schema: S.obj({ lowFrequency: S.hz(), highFrequency: S.hz() }, ['lowFrequency', 'highFrequency']), example: { lowFrequency: 3550000000, highFrequency: 3560000000 } },
    responses: okRef('The DPA.', 'Protection'),
    handler: ({ d, params, body }) => dpaChannel(d, params.dpaId, body, false),
  },
  {
    method: 'DELETE', path: '/dpas', operationId: 'clearDpas', tag: 'DPAs', scope: 'write',
    summary: 'Remove every DPA',
    responses: ok('How many were removed.', S.obj({ deleted: S.int() }, ['deleted'])),
    handler: ({ d }) => {
      const n = d.db.run("DELETE FROM protections WHERE kind = 'DPA'").changes;
      d.bus.changed('spectrum');
      return { deleted: Number(n) };
    },
  },

  // ---------------------------------------------------------------- PPAs
  {
    method: 'GET', path: '/ppas', operationId: 'listPpas', tag: 'PPAs', scope: 'read',
    summary: 'List PAL Protection Areas',
    query: { source: { description: 'Only this source: ui (operator) or harness.', schema: S.str() }, ...pageQuery() },
    responses: ok('A page of PPAs.', pageOf('Ppa')),
    handler: ({ d, query }) => {
      const w = new Where();
      if (query.source) w.add('source = ?', query.source);
      return sqlPage(d.db, 'ppas', w, 'created_at, id', query, ppaOut);
    },
  },
  {
    method: 'POST', path: '/ppas', operationId: 'createPpa', tag: 'PPAs', scope: 'write', errors: [409],
    summary: 'Create a PPA',
    description: 'Member CBSDs get PAL grants on the PPA channels; other CBSDs inside the area are refused those channels.',
    body: {
      required: true, schema: ppaBody(true),
      example: { name: 'Lab PPA', channels: [{ low: 3550000000, high: 3560000000, palId: 'pal/lab/1' }], members: ['TEST-FCC/0123456789abcdef0123456789abcdef01234567'] },
    },
    responses: { 201: { description: 'Created.', schema: ref('Ppa') } },
    handler: ({ d, body }) => {
      for (const [i, c] of body.channels.entries()) if (!(c.low < c.high)) throw badRequest(`channels[${i}]: low must be below high`);
      const id = body.id || `zone/ppa/ui/${crypto.randomUUID()}`;
      if (d.db.get('SELECT 1 FROM ppas WHERE id = ?', id)) throw conflict(`A PPA with id ${id} already exists (use PUT to replace it)`);
      upsertPpa(d.db, id, ppaIn(body));
      d.bus.event('info', 'admin', `PPA "${body.name}" saved`);
      d.bus.changed('spectrum');
      return created(ppa(d, id), `/ppas/${encodeURIComponent(id)}`);
    },
  },
  {
    method: 'POST', path: '/ppas/from-pal', operationId: 'createPpaFromPal', tag: 'PPAs', scope: 'write',
    summary: 'Create a PPA from PAL records',
    description: 'Same as the harness call trigger/create_ppa: the PAL records (inject them first as incumbents of kind `pal`) give the channels, the CBSDs form the cluster and must belong to the PAL holder. Without `providedContour`, the area is the union of 8 km circles around the CBSDs.',
    body: {
      required: true,
      schema: S.obj({
        cbsdIds: S.arr(S.str(), { minItems: 1 }), palIds: S.arr(S.str(), { minItems: 1 }),
        providedContour: S.anyObj({ description: 'GeoJSON FeatureCollection for the PPA area.' }),
      }, ['cbsdIds', 'palIds']),
      example: { cbsdIds: ['TEST-FCC/0123456789abcdef0123456789abcdef01234567'], palIds: ['pal/lab/1'] },
    },
    responses: { 201: { description: 'Created.', schema: ref('Ppa') } },
    handler: ({ d, body }) => {
      const id = d.admin.createPpa(body);
      return created(ppa(d, id), `/ppas/${encodeURIComponent(id)}`);
    },
  },
  {
    method: 'GET', path: '/ppas/{id}', operationId: 'getPpa', tag: 'PPAs', scope: 'read',
    summary: 'Get a PPA', params: idParam('PPA'),
    responses: okRef('The PPA.', 'Ppa'),
    handler: ({ d, params }) => ppa(d, params.id),
  },
  {
    method: 'PUT', path: '/ppas/{id}', operationId: 'putPpa', tag: 'PPAs', scope: 'write',
    summary: 'Create or replace a PPA', description: '201 when created, 200 when replaced.',
    params: idParam('PPA'),
    body: { required: true, schema: ppaBody(false), example: { name: 'Lab PPA', channels: [{ low: 3550000000, high: 3560000000 }], members: [] } },
    responses: { 200: { description: 'Replaced.', schema: ref('Ppa') }, 201: { description: 'Created.', schema: ref('Ppa') } },
    handler: ({ d, params, body }) => {
      for (const [i, c] of body.channels.entries()) if (!(c.low < c.high)) throw badRequest(`channels[${i}]: low must be below high`);
      const existed = !!d.db.get('SELECT 1 FROM ppas WHERE id = ?', params.id);
      upsertPpa(d.db, params.id, ppaIn(body));
      d.bus.changed('spectrum');
      const out = ppa(d, params.id);
      return existed ? new Reply(200, out) : created(out, `/ppas/${encodeURIComponent(params.id)}`);
    },
  },
  {
    method: 'DELETE', path: '/ppas/{id}', operationId: 'deletePpa', tag: 'PPAs', scope: 'write',
    summary: 'Delete a PPA', description: 'Also removes the zone record it was built from, if it came from injected harness data.',
    params: idParam('PPA'),
    responses: noContentResp('Deleted.'),
    handler: ({ d, params }) => {
      if (!d.db.run('DELETE FROM ppas WHERE id = ?', params.id).changes) throw notFound('PPA');
      d.db.run("DELETE FROM harness_data WHERE kind = 'zone' AND id = ?", params.id);
      d.bus.changed('spectrum');
      return noContent();
    },
  },

  // ---------------------------------------------------------------- incumbents
  {
    method: 'GET', path: '/incumbents', operationId: 'listIncumbents', tag: 'Incumbents', scope: 'read',
    summary: 'List injected incumbent and zone data',
    description: 'FSS earth stations, WISP (GWPZ/GWBL) records, PAL records, PPA zones, exclusion zones, peer SASs, ESC sensors, SAS administrators, peer-SAS CBSD records and database URLs, as injected through the API, the console or the harness.',
    query: { kind: { description: 'Only this kind.', schema: S.enum(INCUMBENT_KINDS) }, ...pageQuery() },
    responses: ok('A page of records.', pageOf('Incumbent')),
    handler: ({ d, query }) => {
      const w = new Where();
      if (query.kind) w.add('kind = ?', query.kind);
      return sqlPage(d.db, 'harness_data', w, 'kind, created_at, id', query, incumbentOut);
    },
  },
  {
    method: 'POST', path: '/incumbents/{kind}', operationId: 'injectIncumbent', tag: 'Incumbents', scope: 'write',
    summary: 'Inject incumbent or zone data',
    description: [
      'The body is the record in the WInnForum harness format for that kind (see WINNF-TS-0096 / the harness sas_interface):',
      '',
      '- `fss`: `{"record": {"id": …, "deploymentParam": [ … ]}, "ttc": false}`. An FSS below 3700 MHz with a GWBL within 150 km protects 3650–3700 MHz within 150 km.',
      '- `wisp`: `{"record": { … }, "zone": <GeoJSON or omitted>}`. With a zone it is a GWPZ protection; without, a GWBL location.',
      '- `pal`: a PAL database record with `palId`.',
      '- `zone`: `{"record": {"id"?, "usage": "PPA", "zone": …, "ppaInfo": { … }}}`; a PPA zone becomes a PPA.',
      '- `exclusion_zone`: `{"zone": <GeoJSON>, "frequencyRanges": [ … ]}`.',
      '- `peer_sas`: `{"url": …, "certificateHash": …}`, pulled during daily activities.',
      '- `esc_sensor`, `sas_admin`: `{"record": {"id": …}}`.',
      '- `fad_cbsd`: a peer-SAS CBSD record `{"id": "cbsd/<fccId>/<sha1(serial)>", "grants": [ … ]}`; a matching CBSD is refused grants (401).',
      '- `database_url`: `{"type": …, "url": …}`.',
      '',
      'Protections and PPAs derived from the data are rebuilt immediately.',
    ].join('\n'),
    params: { kind: { description: 'Record kind.', schema: S.enum(INCUMBENT_KINDS) } },
    body: { required: true, schema: S.anyObj(), example: { record: { id: 'zone/fss/lab/1', deploymentParam: [{ installationParam: { latitude: 39.0, longitude: -98.5 }, operationParam: { operationFrequencyRange: { lowFrequency: 3600000000, highFrequency: 4200000000 } } }] }, ttc: false } },
    responses: { 201: { description: 'Stored.', schema: ref('Incumbent') } },
    handler: ({ d, params, body }) => {
      const id = injectIncumbent(d, params.kind, body);
      return created(incumbent(d, params.kind, id), `/incumbents/${params.kind}/${encodeURIComponent(id)}`);
    },
  },
  {
    method: 'GET', path: '/incumbents/{kind}/{id}', operationId: 'getIncumbent', tag: 'Incumbents', scope: 'read',
    summary: 'Get an incumbent record',
    params: { kind: { description: 'Record kind.', schema: S.enum(INCUMBENT_KINDS) }, ...idParam('Record') },
    responses: okRef('The record.', 'Incumbent'),
    handler: ({ d, params }) => incumbent(d, params.kind, params.id),
  },
  {
    method: 'DELETE', path: '/incumbents/{kind}/{id}', operationId: 'deleteIncumbent', tag: 'Incumbents', scope: 'write',
    summary: 'Delete an incumbent record', description: 'Derived protections and PPAs are rebuilt.',
    params: { kind: { description: 'Record kind.', schema: S.enum(INCUMBENT_KINDS) }, ...idParam('Record') },
    responses: noContentResp('Deleted.'),
    handler: ({ d, params }) => {
      if (!d.db.run('DELETE FROM harness_data WHERE kind = ? AND id = ?', params.kind, params.id).changes) throw notFound('Incumbent record');
      d.admin.rebuildDerived();
      return noContent();
    },
  },
];

function dpaChannel(d: V1Deps, dpaId: string, fr: { lowFrequency: number; highFrequency: number }, activate: boolean) {
  if (!(fr.lowFrequency < fr.highFrequency)) throw badRequest('lowFrequency must be below highFrequency');
  const p = d.db.get("SELECT id FROM protections WHERE kind = 'DPA' AND (id = ? OR name = ? OR id = ?)", dpaId, dpaId, `dpa:${dpaId}`);
  if (!p) throw notFound('DPA');
  d.admin.dpaActivation(p.id, fr, activate);
  return protection(d, p.id);
}

/** Store a record of one kind the way the harness admin API does; returns its id. */
function injectIncumbent(d: V1Deps, kind: string, b: any): string {
  const recId = typeof b.record?.id === 'string' && b.record.id ? b.record.id : null;
  switch (kind) {
    case 'fss':
    case 'wisp':
      if (!recId) throw badRequest('record.id is required');
      if (kind === 'fss') d.admin.injectFss(b);
      else d.admin.injectWisp(b);
      return recId;
    case 'pal':
      if (typeof b.palId !== 'string' || !b.palId) throw badRequest('palId is required');
      d.admin.injectPal(b);
      return b.palId;
    case 'zone':
      if (!b.record || typeof b.record !== 'object') throw badRequest('record is required');
      return d.admin.injectZone(b);
    case 'exclusion_zone':
      if (!b.zone) throw badRequest('zone is required');
      return d.admin.injectExclusionZone(b);
    case 'peer_sas':
      if (typeof b.url !== 'string' || !b.url) throw badRequest('url is required');
      d.admin.putData('peer_sas', b.url, b);
      return b.url;
    case 'fad_cbsd':
      if (typeof b.id !== 'string' || !b.id) throw badRequest('id is required');
      d.admin.putData('fad_cbsd', b.id, b);
      return b.id;
    case 'database_url': {
      if (typeof b.type !== 'string' || typeof b.url !== 'string') throw badRequest('type and url are required');
      const id = `${b.type}:${b.url}`;
      d.admin.putData('database_url', id, b);
      return id;
    }
    default: {
      const id = recId ?? crypto.randomUUID();
      d.admin.putData(kind, id, b);
      return id;
    }
  }
}
