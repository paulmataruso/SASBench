import type { Bus } from './bus.ts';
import type { Db, Row } from './db.ts';
import { jparse } from './db.ts';
import type { SasAdmin } from './sas/admin.ts';

// Copy what a radio sent when it registered into the registry, so it stays known when the
// registry is enforced ("Require known FCC ID / user ID", conditional registration): its FCC ID,
// its user ID, and its registration parameters as REG-Conditional preload data.

export interface RegistryCtx {
  db: Db;
  admin: SasAdmin;
  bus: Bus;
  /** Max EIRP for an FCC ID added here: the default unknown FCC IDs already get. */
  defaultMaxEirp: number;
}

export interface RegistryAddOptions {
  /** Add the FCC ID (default true). An FCC ID already listed keeps its max EIRP. */
  fccId?: boolean;
  /** Add the user ID (default true). */
  userId?: boolean;
  /** Preload the registration parameters (default true). */
  registration?: boolean;
  /** Overwrite registration data already preloaded for this device (default false). */
  replace?: boolean;
}

export interface RegistryEntry {
  cbsdId: string;
  fccId: string;
  serial: string;
  userId: string | null;
  state: string;
  /** What the registry already holds for this device. */
  inRegistry: { fccId: boolean; userId: boolean; registration: boolean };
}

export interface RegistryAddResult extends RegistryEntry {
  added: { fccId: boolean; userId: boolean; registration: boolean };
  notes: string[];
}

// The registration fields the engine reads from preload data (see sas/registration.ts, step 7).
const PRELOAD_FIELDS = ['cbsdCategory', 'airInterface', 'installationParam', 'measCapability', 'callSign', 'groupingParam', 'cbsdInfo'];

/** What the registry holds for one CBSD row. */
export function entryOf(db: Db, c: any): RegistryEntry {
  return {
    cbsdId: c.cbsd_id, fccId: c.fcc_id, serial: c.serial, userId: c.user_id ?? null, state: c.state,
    inRegistry: {
      fccId: !!db.get('SELECT 1 FROM fcc_ids WHERE fcc_id = ?', c.fcc_id),
      userId: !!c.user_id && !!db.get('SELECT 1 FROM user_ids WHERE user_id = ?', c.user_id),
      registration: !!db.get('SELECT 1 FROM conditional_reg WHERE fcc_id = ? AND serial = ?', c.fcc_id, c.serial),
    },
  };
}

/** Every CBSD the SAS has a record of, with what the registry holds for it. */
export function registryEntries(db: Db): RegistryEntry[] {
  return db.all('SELECT cbsd_id, fcc_id, serial, user_id, state FROM cbsds ORDER BY created_at').map((c) => entryOf(db, c));
}

/** The REG-Conditional record for a CBSD: the parameters it registered with. */
export function preloadRecord(c: Row): Record<string, unknown> {
  const eff = jparse<Record<string, unknown>>(c.effective, {}) ?? {};
  const reg = jparse<Record<string, unknown>>(c.registration, {}) ?? {};
  const out: Record<string, unknown> = { fccId: c.fcc_id, cbsdSerialNumber: c.serial };
  for (const k of PRELOAD_FIELDS) {
    const v = eff[k] ?? reg[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Add one CBSD to the registry; null when there is no such CBSD. */
export function addCbsdToRegistry(x: RegistryCtx, cbsdId: string, o: RegistryAddOptions = {}): RegistryAddResult | null {
  const { db, admin } = x;
  const c = db.get('SELECT * FROM cbsds WHERE cbsd_id = ?', cbsdId);
  if (!c) return null;
  const before = entryOf(db, c);
  const added = { fccId: false, userId: false, registration: false };
  const notes: string[] = [];
  if (o.fccId !== false) {
    if (before.inRegistry.fccId) notes.push('The FCC ID is already in the registry');
    else {
      admin.injectFccId(c.fcc_id, x.defaultMaxEirp);
      added.fccId = true;
    }
  }
  if (o.userId !== false) {
    if (!c.user_id) notes.push('The CBSD has no user ID');
    else if (before.inRegistry.userId) notes.push('The user ID is already in the registry');
    else {
      admin.injectUserId(c.user_id);
      added.userId = true;
    }
  }
  if (o.registration !== false) {
    if (before.inRegistry.registration && !o.replace) notes.push('Registration data is already preloaded for this device (replace overwrites it)');
    else {
      admin.preloadRegistration([preloadRecord(c)], 'cbsd');
      added.registration = true;
    }
  }
  const what = [added.fccId && 'FCC ID', added.userId && 'user ID', added.registration && 'registration data'].filter(Boolean);
  if (what.length) x.bus.event('info', 'admin', `Added ${c.fcc_id} / ${c.serial} to the registry: ${what.join(', ')}`, c.cbsd_id);
  return { ...entryOf(db, c), added, notes };
}

/** Add several CBSDs (all of them when `cbsdIds` is omitted); unknown ids are reported, not fatal. */
export function addCbsdsToRegistry(x: RegistryCtx, cbsdIds: string[] | undefined, o: RegistryAddOptions = {}) {
  const ids = cbsdIds ?? x.db.all('SELECT cbsd_id FROM cbsds ORDER BY created_at').map((r) => r.cbsd_id as string);
  const results: RegistryAddResult[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const r = addCbsdToRegistry(x, id, o);
    if (r) results.push(r);
    else unknown.push(id);
  }
  return { results, unknown };
}
