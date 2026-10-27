import crypto from 'node:crypto';
import { DEFAULT_SETTINGS, LISTENER_KEYS, type Settings } from '../../../settings.ts';
import { PRESETS } from '../../../presets.ts';
import { detectProfile } from '../../../api.ts';
import { validateTemplate } from '../../../map/tiles.ts';
import type { Route, V1Deps } from '../http.ts';
import { conflict, invalid } from '../http.ts';
import { S, ref, validate } from '../schema.ts';
import { COMPONENTS } from '../components.ts';
import { SETTINGS_META, describeSettings, settingKeys, settingsPatchSchema } from '../settingsMeta.ts';
import { ok, okRef } from './common.ts';

// Runtime settings: read, change (validated against settingsMeta), profiles, defaults.

/**
 * RSA or ECDSA: the HTTPS listener (OpenSSL) holds one certificate per key type, and a second
 * certificate of the same type stops it from starting ("key values mismatch").
 */
export function serverKeyType(certPem: string): string {
  const t = new crypto.X509Certificate(certPem).publicKey.asymmetricKeyType ?? 'unknown';
  return t === 'rsa' || t === 'rsa-pss' ? 'RSA' : t === 'ec' ? 'ECDSA' : t.toUpperCase();
}

/** Checks that span settings or need the database; throws 400 with the offending key. Changes nothing. */
export function checkSettings(d: V1Deps, patch: Partial<Settings>) {
  for (const k of Object.keys(patch)) if (!Object.hasOwn(SETTINGS_META, k)) throw invalid(k, 'is not a setting');
  const next = { ...d.settings.get(), ...patch };
  if (next.sasHttpPort === next.sasHttpsPort) throw invalid('sasHttpsPort', 'must differ from sasHttpPort');
  for (const [k, v] of Object.entries(patch)) {
    const variable = d.settings.envVariable(k);
    if (variable && JSON.stringify(v) !== JSON.stringify(d.settings.get()[k as keyof Settings])) {
      throw conflict(`${k} is set by ${variable} in .env; change it there and start SASBench again (docker compose up -d)`);
    }
  }
  if (!(next.bandLowHz < next.bandHighHz)) throw invalid('bandHighHz', 'must be above bandLowHz');
  next.gaaRanges.forEach((r, i) => {
    if (!(r.low < r.high)) throw invalid(`gaaRanges[${i}]`, 'low must be below high');
  });
  if (patch.mapTileUrl !== undefined) {
    try {
      validateTemplate(patch.mapTileUrl);
    } catch (e: any) {
      throw invalid('mapTileUrl', e.message);
    }
  }
  if (patch.serverCertIds && !patch.serverCertIds.length && next.sasHttpsEnabled) throw invalid('serverCertIds', 'must not be empty while the HTTPS listener is enabled');
  // Removing certificates from a list that already breaks the rule is allowed (it cannot make it worse).
  const current = d.settings.get().serverCertIds;
  const onlyRemoves = !!patch.serverCertIds?.every((id) => current.includes(id));
  if (patch.serverCertIds && new Set(patch.serverCertIds).size !== patch.serverCertIds.length) throw invalid('serverCertIds', 'contains the same certificate twice');
  const keyTypes = new Map<string, string>();
  for (const id of patch.serverCertIds ?? []) {
    const row = d.pki.getRow(id);
    if (!row) throw invalid('serverCertIds', `contains unknown certificate ${id}`);
    if (!row.key_pem) throw invalid('serverCertIds', `certificate ${id} has no private key`);
    const type = serverKeyType(row.cert_pem);
    if (keyTypes.has(type) && !onlyRemoves) throw invalid('serverCertIds', `holds two ${type} certificates (${keyTypes.get(type)} and ${id}); the HTTPS listener presents at most one per key type`);
    keyTypes.set(type, id);
  }
  for (const id of patch.trustedClientCaIds ?? []) {
    if (!d.pki.getRow(id)) throw invalid('trustedClientCaIds', `contains unknown certificate ${id}`);
  }
}

/** Apply a validated patch; waits for a listener restart when one was triggered. */
export async function applySettings(d: V1Deps, patch: Partial<Settings>, label?: string) {
  checkSettings(d, patch);
  const changed = d.settings.update(patch);
  if (changed.length) d.bus.event('info', 'settings', label ?? `Settings changed: ${changed.join(', ')}`);
  d.bus.changed('settings');
  const restarted = changed.some((k) => LISTENER_KEYS.includes(k));
  if (restarted) await d.sas.idle();
  return { changed, listenersRestarted: restarted, settings: d.settings.get(), profile: detectProfile(d.settings.get()), listeners: d.sas.getStatus() };
}

const keyParam = { key: { description: 'Setting name, e.g. heartbeatIntervalSec (see GET /settings/schema).', schema: S.enum(settingKeys) } };

export const settingsRoutes: Route[] = [
  {
    method: 'GET', path: '/settings', operationId: 'getSettings', tag: 'Settings', scope: 'read',
    summary: 'Get all settings',
    description: 'Current values of every runtime setting, the matching settings profile, if any, and the settings that environment variables set (.env).',
    responses: ok('Settings.', S.obj({
      settings: ref('Settings'), profile: S.nullable(S.str()),
      fromEnv: S.obj({}, [], {
        additionalProperties: S.str(),
        description: 'Settings an environment variable sets, with the variable, e.g. {"sasHttpsPort": "SAS_HTTPS_PORT"}. They cannot be changed through the API.',
      }),
    }, ['settings', 'profile', 'fromEnv'])),
    handler: ({ d }) => ({ settings: d.settings.get(), profile: detectProfile(d.settings.get()), fromEnv: d.settings.fromEnv() }),
  },
  {
    method: 'PATCH', path: '/settings', operationId: 'updateSettings', tag: 'Settings', scope: 'write',
    summary: 'Change settings',
    description: 'Send only the settings to change. Every value is checked against its type and range before anything is applied. Changing a listener or TLS setting restarts the SAS listeners; the response is sent once they are back. A setting that an environment variable sets (`fromEnv` in GET /settings) cannot be changed: 409.',
    body: { required: true, schema: settingsPatchSchema, example: { heartbeatIntervalSec: 30, missingInstallParams: 'register' } },
    responses: okRef('What changed and the resulting settings.', 'SettingsChange'),
    errors: [409],
    handler: ({ d, body }) => applySettings(d, body),
  },
  {
    method: 'GET', path: '/settings/schema', operationId: 'getSettingsSchema', tag: 'Settings', scope: 'read',
    summary: 'Describe every setting',
    description: 'For each setting: group, meaning, unit, JSON schema (type, allowed values, range), default, current value and whether changing it restarts the listeners.',
    responses: ok('Setting descriptions.', S.obj({ items: S.arr(ref('SettingDescription')) }, ['items'])),
    handler: ({ d }) => ({ items: describeSettings(d.settings.get(), d.settings.fromEnv()) }),
  },
  {
    method: 'GET', path: '/settings/profiles', operationId: 'listSettingsProfiles', tag: 'Settings', scope: 'read',
    summary: 'List settings profiles',
    description: 'The named profiles (lab, winnforum, open) with the settings each one sets, and which one matches the current settings.',
    responses: ok('Profiles.', S.obj({ items: S.arr(ref('SettingsProfile')), active: S.nullable(S.str()) }, ['items', 'active'])),
    handler: ({ d }) => ({
      items: Object.entries(PRESETS).map(([name, p]) => ({ name, label: p.label, description: p.description, settings: p.patch })),
      active: detectProfile(d.settings.get()),
    }),
  },
  {
    method: 'POST', path: '/settings/profiles/{name}/apply', operationId: 'applySettingsProfile', tag: 'Settings', scope: 'write',
    summary: 'Apply a settings profile',
    description: 'Sets every setting the profile defines; other settings keep their values.',
    params: { name: { description: 'Profile name.', schema: S.enum(Object.keys(PRESETS)) } },
    responses: okRef('What changed and the resulting settings.', 'SettingsChange'),
    handler: ({ d, params }) => {
      const p = PRESETS[params.name];
      return applySettings(d, { ...p.patch }, `Applied settings profile "${p.label}"`);
    },
  },
  {
    method: 'POST', path: '/settings/reset', operationId: 'resetSettings', tag: 'Settings', scope: 'write',
    summary: 'Restore default settings',
    description: 'Every setting returns to its default except the server certificates, trusted client CAs and listener ports.',
    responses: okRef('What changed and the resulting settings.', 'SettingsChange'),
    handler: ({ d }) => {
      const keep: Array<keyof Settings> = ['serverCertIds', 'trustedClientCaIds', 'sasHttpPort', 'sasHttpsPort'];
      const patch: Partial<Settings> = {};
      for (const k of settingKeys) if (!keep.includes(k)) (patch as any)[k] = DEFAULT_SETTINGS[k];
      return applySettings(d, patch, 'Settings restored to defaults');
    },
  },
  {
    method: 'GET', path: '/settings/{key}', operationId: 'getSetting', tag: 'Settings', scope: 'read',
    summary: 'Get one setting',
    params: keyParam,
    responses: okRef('The setting with its description.', 'SettingDescription'),
    handler: ({ d, params }) => describeSettings(d.settings.get(), d.settings.fromEnv()).find((s) => s.key === params.key),
  },
  {
    method: 'PUT', path: '/settings/{key}', operationId: 'putSetting', tag: 'Settings', scope: 'write',
    summary: 'Change one setting',
    params: keyParam,
    body: { required: true, schema: S.obj({ value: S.any({ description: 'New value; must match the setting\'s schema.' }) }, ['value']), example: { value: 30 } },
    responses: okRef('What changed and the resulting settings.', 'SettingsChange'),
    handler: ({ d, params, body }) => {
      const key = params.key as keyof Settings;
      const issues = validate(SETTINGS_META[key].schema, body.value, COMPONENTS, 'value');
      if (issues.length) throw invalid(issues[0].path, issues[0].message);
      return applySettings(d, { [key]: body.value } as Partial<Settings>);
    },
  },
];
