import crypto from 'node:crypto';
import type { Route, V1Deps } from '../http.ts';
import { badRequest, created, noContent, notFound } from '../http.ts';
import { S, ref } from '../schema.ts';
import { blacklistOut, conditionalOut, cpiOut, fccOut, userOut } from '../mappers.ts';
import { Reply } from '../http.ts';
import { Where, like, noContentResp, ok, okRef, pageOf, pageQuery, sqlPage } from './common.ts';
import { page } from '../http.ts';
import { addCbsdsToRegistry, registryEntries } from '../../../registry.ts';

// Registry data the registration procedure consults: known FCC IDs (with certified maximum
// EIRP), user IDs, the blacklist, preloaded (conditional) registration data and CPI users.

const fccIdParam = { fccId: { description: 'FCC ID.' } };
const serialParam = { serial: { description: 'CBSD serial number.' } };
const qQuery = { q: { description: 'Substring match on the identifier.', schema: S.str({ minLength: 1 }) } };

function get(d: V1Deps, sql: string, what: string, ...p: any[]) {
  const r = d.db.get(sql, ...p);
  if (!r) throw notFound(what);
  return r;
}

export const registryAddOptions = {
  fccId: S.bool({ default: true, description: 'Add the FCC ID. One already listed keeps its max EIRP; a new one gets defaultFccMaxEirp.' }),
  userId: S.bool({ default: true, description: 'Add the user ID.' }),
  registration: S.bool({ default: true, description: 'Preload the registration parameters (category, air interface, installation parameters, measurement capability, call sign) as REG-Conditional data.' }),
  replace: S.bool({ default: false, description: 'Overwrite registration data already preloaded for the device.' }),
};

/** 201 when the record is new, 200 when an existing one was replaced. */
const upserted = (existed: boolean, body: unknown, location: string) => (existed ? new Reply(200, body) : created(body, location));

export const registryRoutes: Route[] = [
  {
    method: 'GET', path: '/registry', operationId: 'getRegistry', tag: 'Registry', scope: 'read',
    summary: 'Get the whole registry',
    description: 'FCC IDs, user IDs, blacklist entries, preloaded registrations and CPI users in one response (no paging).',
    responses: okRef('The registry.', 'Registry'),
    handler: ({ d }) => ({
      fccIds: d.db.all('SELECT * FROM fcc_ids ORDER BY fcc_id').map(fccOut),
      userIds: d.db.all('SELECT * FROM user_ids ORDER BY user_id').map(userOut),
      blacklist: d.db.all('SELECT * FROM blacklist ORDER BY id DESC').map(blacklistOut),
      conditional: d.db.all('SELECT * FROM conditional_reg ORDER BY created_at DESC').map(conditionalOut),
      cpiUsers: d.db.all('SELECT * FROM cpi_users ORDER BY cpi_id').map(cpiOut),
    }),
  },

  // ---------------------------------------------------------------- from registered radios
  {
    method: 'GET', path: '/registry/from-cbsds', operationId: 'listRegistryCandidates', tag: 'Registry', scope: 'read',
    summary: 'List registered radios and their registry status',
    description: 'Every CBSD the SAS has a record of, oldest first, with what the registry already holds for it: its FCC ID, its user ID and preloaded registration data.',
    query: { missing: { description: 'Only CBSDs with something not yet in the registry.', schema: S.bool() }, ...pageQuery() },
    responses: ok('A page of CBSDs.', pageOf('RegistryEntry')),
    handler: ({ d, query }) => {
      const all = registryEntries(d.db);
      return page(query.missing ? all.filter((e) => !e.inRegistry.fccId || (e.userId && !e.inRegistry.userId) || !e.inRegistry.registration) : all, query);
    },
  },
  {
    method: 'POST', path: '/registry/from-cbsds', operationId: 'addCbsdsToRegistry', tag: 'Registry', scope: 'write',
    summary: 'Add registered radios to the registry',
    description: 'For each CBSD (all of them when cbsdIds is omitted), adds its FCC ID and user ID and preloads the parameters it registered with, so the radio stays known when the registry is enforced (requireKnownFccId, requireKnownUserId, conditional registration). Entries already present are kept. Unknown cbsdIds are listed in `unknown`.',
    body: {
      schema: S.obj({
        cbsdIds: S.arr(S.str({ minLength: 1 }), { maxItems: 10000, description: 'CBSDs to add; omit for all.' }),
        ...registryAddOptions,
      }),
      example: { cbsdIds: ['2AG32MBS3500/0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3'], registration: true },
    },
    responses: okRef('What was added for each CBSD.', 'RegistryAddResults'),
    handler: ({ d, body }) => addCbsdsToRegistry({ db: d.db, admin: d.admin, bus: d.bus, defaultMaxEirp: d.settings.get().defaultFccMaxEirp }, body?.cbsdIds, body ?? {}),
  },

  // ---------------------------------------------------------------- FCC IDs
  {
    method: 'GET', path: '/registry/fcc-ids', operationId: 'listFccIds', tag: 'Registry', scope: 'read',
    summary: 'List FCC IDs',
    description: 'FCC IDs known to the SAS. With requireKnownFccId, registrations from other FCC IDs are rejected (103).',
    query: { ...qQuery, ...pageQuery() },
    responses: ok('A page of FCC IDs.', pageOf('FccId')),
    handler: ({ d, query }) => {
      const w = new Where();
      if (query.q) w.add("fcc_id LIKE ? ESCAPE '\\'", like(query.q));
      return sqlPage(d.db, 'fcc_ids', w, 'fcc_id', query, fccOut);
    },
  },
  {
    method: 'POST', path: '/registry/fcc-ids', operationId: 'addFccId', tag: 'Registry', scope: 'write',
    summary: 'Add or update an FCC ID',
    description: 'Same as the harness call injectdata/fcc_id. 201 when added, 200 when an existing FCC ID was updated.',
    body: {
      required: true,
      schema: S.obj({
        fccId: S.str({ minLength: 1, maxLength: 64 }),
        maxEirp: S.num({ minimum: -137, maximum: 100, default: 47, description: 'Certified maximum EIRP in dBm/10 MHz.' }),
      }, ['fccId']),
      example: { fccId: 'TEST-FCC', maxEirp: 47 },
    },
    responses: { 200: { description: 'Updated.', schema: ref('FccId') }, 201: { description: 'Added.', schema: ref('FccId') } },
    handler: ({ d, body }) => {
      const existed = !!d.db.get('SELECT 1 FROM fcc_ids WHERE fcc_id = ?', body.fccId);
      d.admin.injectFccId(body.fccId, body.maxEirp ?? 47);
      return upserted(existed, fccOut(d.db.get('SELECT * FROM fcc_ids WHERE fcc_id = ?', body.fccId)!), `/registry/fcc-ids/${encodeURIComponent(body.fccId)}`);
    },
  },
  {
    method: 'GET', path: '/registry/fcc-ids/{fccId}', operationId: 'getFccId', tag: 'Registry', scope: 'read',
    summary: 'Get an FCC ID', params: fccIdParam,
    responses: okRef('The FCC ID.', 'FccId'),
    handler: ({ d, params }) => fccOut(get(d, 'SELECT * FROM fcc_ids WHERE fcc_id = ?', 'FCC ID', params.fccId)),
  },
  {
    method: 'DELETE', path: '/registry/fcc-ids/{fccId}', operationId: 'deleteFccId', tag: 'Registry', scope: 'write',
    summary: 'Remove an FCC ID', params: fccIdParam,
    responses: noContentResp('Removed.'),
    handler: ({ d, params }) => {
      if (!d.db.run('DELETE FROM fcc_ids WHERE fcc_id = ?', params.fccId).changes) throw notFound('FCC ID');
      d.bus.changed('registry');
      return noContent();
    },
  },

  // ---------------------------------------------------------------- user IDs
  {
    method: 'GET', path: '/registry/user-ids', operationId: 'listUserIds', tag: 'Registry', scope: 'read',
    summary: 'List user IDs',
    description: 'User IDs known to the SAS. With requireKnownUserId, registrations from other user IDs are rejected (103).',
    query: { ...qQuery, ...pageQuery() },
    responses: ok('A page of user IDs.', pageOf('UserId')),
    handler: ({ d, query }) => {
      const w = new Where();
      if (query.q) w.add("user_id LIKE ? ESCAPE '\\'", like(query.q));
      return sqlPage(d.db, 'user_ids', w, 'user_id', query, userOut);
    },
  },
  {
    method: 'POST', path: '/registry/user-ids', operationId: 'addUserId', tag: 'Registry', scope: 'write',
    summary: 'Add a user ID',
    description: 'Same as the harness call injectdata/user_id. 201 when added, 200 when it already existed.',
    body: { required: true, schema: S.obj({ userId: S.str({ minLength: 1, maxLength: 256 }) }, ['userId']), example: { userId: 'lab-user' } },
    responses: { 200: { description: 'Already present.', schema: ref('UserId') }, 201: { description: 'Added.', schema: ref('UserId') } },
    handler: ({ d, body }) => {
      const existed = !!d.db.get('SELECT 1 FROM user_ids WHERE user_id = ?', body.userId);
      d.admin.injectUserId(body.userId);
      return upserted(existed, userOut(d.db.get('SELECT * FROM user_ids WHERE user_id = ?', body.userId)!), `/registry/user-ids/${encodeURIComponent(body.userId)}`);
    },
  },
  {
    method: 'GET', path: '/registry/user-ids/{userId}', operationId: 'getUserId', tag: 'Registry', scope: 'read',
    summary: 'Get a user ID', params: { userId: { description: 'User ID.' } },
    responses: okRef('The user ID.', 'UserId'),
    handler: ({ d, params }) => userOut(get(d, 'SELECT * FROM user_ids WHERE user_id = ?', 'User ID', params.userId)),
  },
  {
    method: 'DELETE', path: '/registry/user-ids/{userId}', operationId: 'deleteUserId', tag: 'Registry', scope: 'write',
    summary: 'Remove a user ID', params: { userId: { description: 'User ID.' } },
    responses: noContentResp('Removed.'),
    handler: ({ d, params }) => {
      if (!d.db.run('DELETE FROM user_ids WHERE user_id = ?', params.userId).changes) throw notFound('User ID');
      d.bus.changed('registry');
      return noContent();
    },
  },

  // ---------------------------------------------------------------- blacklist
  {
    method: 'GET', path: '/registry/blacklist', operationId: 'listBlacklist', tag: 'Registry', scope: 'read',
    summary: 'List blacklist entries',
    description: 'Blacklisted CBSDs are answered with 101 BLACKLISTED, and their grants are terminated on their next request.',
    query: { fccId: { description: 'Only entries for this FCC ID.', schema: S.str() }, ...pageQuery() },
    responses: ok('A page of entries.', pageOf('BlacklistEntry')),
    handler: ({ d, query }) => {
      const w = new Where();
      if (query.fccId) w.add('fcc_id = ?', query.fccId);
      return sqlPage(d.db, 'blacklist', w, 'id DESC', query, blacklistOut);
    },
  },
  {
    method: 'POST', path: '/registry/blacklist', operationId: 'addBlacklistEntry', tag: 'Registry', scope: 'write',
    summary: 'Blacklist an FCC ID or one device',
    description: 'Without `serial` the whole FCC ID is blacklisted. Same as the harness calls blacklist_fcc_id and blacklist_fcc_id_and_serial_number. 201 when added, 200 when the same entry existed.',
    body: {
      required: true,
      schema: S.obj({
        fccId: S.str({ minLength: 1, maxLength: 64 }),
        serial: S.nullable(S.str({ minLength: 1, maxLength: 256, description: 'Only this serial number.' })),
        reason: S.str({ maxLength: 500 }),
      }, ['fccId']),
      example: { fccId: 'TEST-FCC', serial: 'SN-0001', reason: 'interference investigation' },
    },
    responses: { 200: { description: 'Already present.', schema: ref('BlacklistEntry') }, 201: { description: 'Added.', schema: ref('BlacklistEntry') } },
    handler: ({ d, body }) => {
      const serial = body.serial ?? null;
      const before = d.db.get('SELECT id FROM blacklist WHERE fcc_id = ? AND serial IS ?', body.fccId, serial);
      d.admin.blacklist(body.fccId, serial, body.reason || 'blacklisted by administrator');
      const row = d.db.get('SELECT * FROM blacklist WHERE fcc_id = ? AND serial IS ?', body.fccId, serial)!;
      return upserted(!!before, blacklistOut(row), `/registry/blacklist/${row.id}`);
    },
  },
  {
    method: 'GET', path: '/registry/blacklist/{id}', operationId: 'getBlacklistEntry', tag: 'Registry', scope: 'read',
    summary: 'Get a blacklist entry', params: { id: { description: 'Entry id.', schema: S.int({ minimum: 1 }) } },
    responses: okRef('The entry.', 'BlacklistEntry'),
    handler: ({ d, params }) => blacklistOut(get(d, 'SELECT * FROM blacklist WHERE id = ?', 'Blacklist entry', params.id)),
  },
  {
    method: 'DELETE', path: '/registry/blacklist/{id}', operationId: 'deleteBlacklistEntry', tag: 'Registry', scope: 'write',
    summary: 'Remove a blacklist entry', params: { id: { description: 'Entry id.', schema: S.int({ minimum: 1 }) } },
    responses: noContentResp('Removed.'),
    handler: ({ d, params }) => {
      if (!d.db.run('DELETE FROM blacklist WHERE id = ?', params.id).changes) throw notFound('Blacklist entry');
      d.bus.event('info', 'admin', 'Blacklist entry removed');
      d.bus.changed('registry');
      return noContent();
    },
  },

  // ---------------------------------------------------------------- conditional registrations
  {
    method: 'GET', path: '/registry/conditional', operationId: 'listConditionalRegistrations', tag: 'Registry', scope: 'read',
    summary: 'List preloaded registrations',
    description: 'REG-Conditional data (location, antenna, category, …) preloaded per FCC ID and serial number. A CBSD that registers without that data gets it from here, e.g. radios that send no location.',
    query: { fccId: { description: 'Only this FCC ID.', schema: S.str() }, ...pageQuery() },
    responses: ok('A page of preloaded registrations.', pageOf('ConditionalRegistration')),
    handler: ({ d, query }) => {
      const w = new Where();
      if (query.fccId) w.add('fcc_id = ?', query.fccId);
      return sqlPage(d.db, 'conditional_reg', w, 'created_at DESC, fcc_id, serial', query, conditionalOut);
    },
  },
  {
    method: 'POST', path: '/registry/conditional', operationId: 'preloadRegistrations', tag: 'Registry', scope: 'write',
    summary: 'Preload registration data',
    description: 'One record, an array of records, or `{"registrationData": [ … ]}` (the harness format). Each record needs fccId and cbsdSerialNumber and may carry any RegistrationRequest parameters (cbsdCategory, airInterface, installationParam, …). Existing records for the same device are replaced.',
    body: {
      required: true,
      schema: {
        oneOf: [
          S.arr(S.anyObj(), { minItems: 1 }),
          S.obj({ registrationData: S.arr(S.anyObj(), { minItems: 1 }) }, ['registrationData']),
          { ...S.anyObj(), required: ['fccId', 'cbsdSerialNumber'] },
        ],
      },
      example: {
        fccId: 'TEST-FCC', cbsdSerialNumber: 'SN-0002', cbsdCategory: 'B', airInterface: { radioTechnology: 'E_UTRA' },
        installationParam: { latitude: 39.74, longitude: -104.99, height: 12, heightType: 'AGL', indoorDeployment: false, antennaGain: 16, antennaBeamwidth: 65, antennaAzimuth: 180 },
      },
    },
    responses: ok('The stored records.', S.obj({ saved: S.int(), items: S.arr(ref('ConditionalRegistration')) }, ['saved', 'items'])),
    handler: ({ d, body }) => {
      const records: any[] = Array.isArray(body) ? body : Array.isArray(body.registrationData) ? body.registrationData : [body];
      records.forEach((r, i) => {
        if (typeof r?.fccId !== 'string' || !r.fccId || typeof r.cbsdSerialNumber !== 'string' || !r.cbsdSerialNumber) {
          throw badRequest(`Record ${i + 1} needs fccId and cbsdSerialNumber strings`);
        }
      });
      d.admin.preloadRegistration(records, 'api');
      const items = records.map((r) => conditionalOut(d.db.get('SELECT * FROM conditional_reg WHERE fcc_id = ? AND serial = ?', r.fccId, r.cbsdSerialNumber)!));
      return { saved: items.length, items };
    },
  },
  {
    method: 'GET', path: '/registry/conditional/{fccId}/{serial}', operationId: 'getConditionalRegistration', tag: 'Registry', scope: 'read',
    summary: 'Get preloaded registration data', params: { ...fccIdParam, ...serialParam },
    responses: okRef('The record.', 'ConditionalRegistration'),
    handler: ({ d, params }) => conditionalOut(get(d, 'SELECT * FROM conditional_reg WHERE fcc_id = ? AND serial = ?', 'Preloaded registration', params.fccId, params.serial)),
  },
  {
    method: 'DELETE', path: '/registry/conditional/{fccId}/{serial}', operationId: 'deleteConditionalRegistration', tag: 'Registry', scope: 'write',
    summary: 'Remove preloaded registration data', params: { ...fccIdParam, ...serialParam },
    responses: noContentResp('Removed.'),
    handler: ({ d, params }) => {
      if (!d.db.run('DELETE FROM conditional_reg WHERE fcc_id = ? AND serial = ?', params.fccId, params.serial).changes) throw notFound('Preloaded registration');
      d.bus.changed('registry');
      return noContent();
    },
  },

  // ---------------------------------------------------------------- CPI users
  {
    method: 'GET', path: '/registry/cpi-users', operationId: 'listCpiUsers', tag: 'Registry', scope: 'read',
    summary: 'List CPI users',
    description: 'Certified Professional Installers whose signatures (cpiSignatureData) the SAS verifies.',
    query: pageQuery(),
    responses: ok('A page of CPI users.', pageOf('CpiUser')),
    handler: ({ d, query }) => sqlPage(d.db, 'cpi_users', new Where(), 'cpi_id', query, cpiOut),
  },
  {
    method: 'POST', path: '/registry/cpi-users', operationId: 'addCpiUser', tag: 'Registry', scope: 'write', errors: [404],
    summary: 'Add or update a CPI user',
    description: 'The public key may be given as a SubjectPublicKeyInfo PEM (`publicKey`), a certificate PEM (`publicKey` containing a certificate) or the id of a certificate in the store (`certId`). Same as the harness call injectdata/cpi_user.',
    body: {
      required: true,
      schema: S.obj({
        cpiId: S.str({ minLength: 1, maxLength: 256 }),
        name: S.str({ maxLength: 256 }),
        publicKey: S.str({ minLength: 1, description: 'PEM public key or certificate.' }),
        certId: S.str({ minLength: 1, description: 'Certificate in the store whose public key to use.' }),
      }, ['cpiId']),
      example: { cpiId: 'cpi-0001', name: 'Lab installer', certId: '<installer certificate id>' },
    },
    responses: { 200: { description: 'Updated.', schema: ref('CpiUser') }, 201: { description: 'Added.', schema: ref('CpiUser') } },
    handler: ({ d, body }) => {
      let key: string;
      if (body.certId) {
        const row = d.pki.getRow(body.certId);
        if (!row) throw notFound('Certificate');
        key = new crypto.X509Certificate(row.cert_pem).publicKey.export({ type: 'spki', format: 'pem' }) as string;
      } else if (body.publicKey) {
        key = body.publicKey.includes('BEGIN CERTIFICATE')
          ? new crypto.X509Certificate(body.publicKey).publicKey.export({ type: 'spki', format: 'pem' }) as string
          : body.publicKey;
      } else throw badRequest('Give publicKey or certId');
      const existed = !!d.db.get('SELECT 1 FROM cpi_users WHERE cpi_id = ?', body.cpiId);
      d.admin.injectCpiUser(body.cpiId, body.name ?? '', key, 'api');
      return upserted(existed, cpiOut(d.db.get('SELECT * FROM cpi_users WHERE cpi_id = ?', body.cpiId)!), `/registry/cpi-users/${encodeURIComponent(body.cpiId)}`);
    },
  },
  {
    method: 'GET', path: '/registry/cpi-users/{cpiId}', operationId: 'getCpiUser', tag: 'Registry', scope: 'read',
    summary: 'Get a CPI user', params: { cpiId: { description: 'CPI id.' } },
    responses: okRef('The CPI user.', 'CpiUser'),
    handler: ({ d, params }) => cpiOut(get(d, 'SELECT * FROM cpi_users WHERE cpi_id = ?', 'CPI user', params.cpiId)),
  },
  {
    method: 'DELETE', path: '/registry/cpi-users/{cpiId}', operationId: 'deleteCpiUser', tag: 'Registry', scope: 'write',
    summary: 'Remove a CPI user', params: { cpiId: { description: 'CPI id.' } },
    responses: noContentResp('Removed.'),
    handler: ({ d, params }) => {
      if (!d.db.run('DELETE FROM cpi_users WHERE cpi_id = ?', params.cpiId).changes) throw notFound('CPI user');
      d.bus.changed('registry');
      return noContent();
    },
  },
];
