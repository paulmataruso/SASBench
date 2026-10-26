import type { Db, Row } from '../db.ts';
import { jparse } from '../db.ts';
import type { Settings } from '../settings.ts';
import { distanceKm, distanceToGeometryKm, pointInGeometry } from './geo.ts';

// Spectrum policy: which frequencies a CBSD may use, as what channel type, at what
// EIRP — combining the configured GAA band plan, PAL Protection Areas and active
// incumbent protections (DPA / ESC / FSS / exclusion zones / admin blocks).

export interface Range { low: number; high: number }

export interface CbsdView {
  cbsdId: string;
  fccId: string;
  serial: string;
  category: 'A' | 'B' | string | null;
  lat: number | null;
  lon: number | null;
  heightAgl: number | null;
  indoor: boolean | null;
  eirpCapability: number | null; // dBm/10MHz
  eirpCapDbmMhz: number | null;  // admin per-CBSD cap, dBm/MHz
}

export interface PpaInfo {
  id: string;
  name: string;
  channels: Array<{ low: number; high: number; palId?: string; licenseExpiration?: number | null }>;
  members: string[];
  geometry: any | null;
  expiration: number | null;
}

export interface ProtectionHit {
  id: string;
  name: string;
  kind: string;
  action: 'suspend' | 'terminate';
  ranges: Range[];
}

export const overlaps = (a: Range, b: Range) => a.low < b.high && a.high > b.low;
export const contains = (outer: Range, inner: Range) => inner.low >= outer.low && inner.high <= outer.high;

export function cbsdViewFromRow(r: Row): CbsdView {
  const eff = jparse<any>(r.effective, {});
  const ip = eff.installationParam ?? {};
  return {
    cbsdId: r.cbsd_id, fccId: r.fcc_id, serial: r.serial, category: eff.cbsdCategory ?? r.category ?? null,
    lat: num(ip.latitude), lon: num(ip.longitude),
    heightAgl: ip.heightType === 'AGL' ? num(ip.height) : num(ip.height),
    indoor: typeof ip.indoorDeployment === 'boolean' ? ip.indoorDeployment : null,
    eirpCapability: num(ip.eirpCapability), eirpCapDbmMhz: r.eirp_cap_dbm_mhz ?? null,
  };
}

function num(v: any): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export class Policy {
  private db: Db;
  private getSettings: () => Settings;

  constructor(db: Db, getSettings: () => Settings) {
    this.db = db;
    this.getSettings = getSettings;
  }

  // ---------------------------------------------------------------- EIRP

  /** Max EIRP per 10 MHz allowed for this CBSD (dBm/10MHz): min(FCC certified, eirpCapability, category limit). */
  maxEirpPer10MHz(c: CbsdView): number {
    const s = this.getSettings();
    const fcc = this.db.get('SELECT max_eirp FROM fcc_ids WHERE fcc_id = ?', c.fccId);
    const fccMax = typeof fcc?.max_eirp === 'number' ? fcc.max_eirp : s.defaultFccMaxEirp;
    const catMax = c.category === 'A' ? s.maxEirpCatA + 10 : s.maxEirpCatB + 10;
    let lim = Math.min(fccMax, catMax);
    if (c.eirpCapability != null) lim = Math.min(lim, c.eirpCapability);
    return lim;
  }

  /** Max grantable EIRP (dBm/MHz) after admin caps. */
  maxEirpDbmMhz(c: CbsdView): number {
    let v = this.maxEirpPer10MHz(c) - 10;
    if (c.eirpCapDbmMhz != null) v = Math.min(v, c.eirpCapDbmMhz);
    return v;
  }

  // ---------------------------------------------------------------- PPA

  ppas(): PpaInfo[] {
    const now = Date.now();
    return this.db.all('SELECT * FROM ppas').map((r) => ({
      id: r.id, name: r.name, channels: jparse(r.channels, []), members: jparse(r.members, []),
      geometry: jparse(r.geometry, null), expiration: r.expiration ?? null,
    })).filter((p) => p.expiration == null || p.expiration > now);
  }

  /** PPAs relevant to a range: membership-based PAL eligibility and non-member exclusion. */
  palContext(c: CbsdView, r: Range): { memberPpas: PpaInfo[]; excludingPpas: PpaInfo[] } {
    const memberPpas: PpaInfo[] = [];
    const excludingPpas: PpaInfo[] = [];
    for (const p of this.ppas()) {
      if (!p.channels.some((ch) => overlaps(ch, r))) continue;
      const member = p.members.includes(c.cbsdId);
      const inside = p.geometry && c.lat != null && c.lon != null ? pointInGeometry(c.lat, c.lon, p.geometry) : !p.geometry;
      if (member) memberPpas.push(p);
      else if (inside && p.geometry) excludingPpas.push(p);
    }
    return { memberPpas, excludingPpas };
  }

  // ---------------------------------------------------------------- Protections

  protections(): Row[] {
    return this.db.all('SELECT * FROM protections WHERE active = 1');
  }

  /** Active protections that affect this CBSD and overlap the range. */
  protectionHits(c: CbsdView, r: Range): ProtectionHit[] {
    const hits: ProtectionHit[] = [];
    for (const p of this.protections()) {
      const ranges = activeRanges(p).filter((x) => overlaps(x, r));
      if (!ranges.length) continue;
      if (!this.affects(p, c)) continue;
      hits.push({ id: p.id, name: p.name, kind: p.kind, action: p.action === 'terminate' ? 'terminate' : 'suspend', ranges });
    }
    return hits;
  }

  affects(p: Row, c: CbsdView): boolean {
    const geom = jparse<any>(p.geometry, null);
    const hood = jparse<any>(p.neighborhood, null);
    if (geom) {
      if (c.lat == null || c.lon == null) return true;
      const d = distanceToGeometryKm(c.lat, c.lon, geom);
      return d <= neighborhoodKm(hood, c, p.radius_km ?? 0);
    }
    if (p.latitude != null && p.longitude != null && p.radius_km != null) {
      if (c.lat == null || c.lon == null) return true;
      return distanceKm(c.lat, c.lon, p.latitude, p.longitude) <= p.radius_km;
    }
    return true; // band-wide
  }

  // ---------------------------------------------------------------- Availability

  /**
   * Available spectrum for a CBSD as non-overlapping segments with channel type and max EIRP.
   * PAL segments: channels of PPAs the CBSD belongs to. GAA: configured GAA ranges minus
   * PAL channels of PPAs that contain the CBSD (non-member) minus active protections.
   */
  availability(c: CbsdView): Array<Range & { channelType: 'PAL' | 'GAA'; maxEirp: number }> {
    const s = this.getSettings();
    const band: Range = { low: s.bandLowHz, high: s.bandHighHz };
    const maxEirp = this.maxEirpDbmMhz(c);
    let blocked: Range[] = [];
    for (const p of this.protections()) if (this.affects(p, c)) blocked.push(...activeRanges(p));

    const pal: Range[] = [];
    const exclude: Range[] = [];
    for (const p of this.ppas()) {
      const member = p.members.includes(c.cbsdId);
      const inside = p.geometry && c.lat != null && c.lon != null ? pointInGeometry(c.lat, c.lon, p.geometry) : false;
      for (const ch of p.channels) {
        if (member) pal.push({ low: ch.low, high: ch.high });
        else if (inside) exclude.push({ low: ch.low, high: ch.high });
      }
    }
    const out: Array<Range & { channelType: 'PAL' | 'GAA'; maxEirp: number }> = [];
    for (const seg of subtract(merge(pal.map((x) => clip(x, band)).filter(Boolean) as Range[]), blocked)) {
      out.push({ ...seg, channelType: 'PAL', maxEirp });
    }
    const gaa = subtract(subtract(subtract(merge(s.gaaRanges.map((x) => clip(x, band)).filter(Boolean) as Range[]), pal), exclude), blocked);
    for (const seg of gaa) out.push({ ...seg, channelType: 'GAA', maxEirp });
    return out.sort((a, b) => a.low - b.low);
  }

  /**
   * Spectrum inquiry channels for one inquired range R (WINNF-TS-0016 §8.4, harness SIQ rules):
   *  - exclusions E: active protections affecting the CBSD (DPAs only when siqIncludeDpa),
   *    and PAL channels of PPAs that contain the CBSD but do not list it in their cluster;
   *  - PAL: one unsplit channel per PAL channel of a PPA the CBSD belongs to (clipped to R, minus E);
   *  - GAA: R ∩ GAA plan − E − reserved PAL ranges, as maximal contiguous ranges.
   */
  siqChannels(c: CbsdView, r: Range): Array<Range & { channelType: 'PAL' | 'GAA'; maxEirp: number }> {
    const s = this.getSettings();
    const maxEirp = this.maxEirpDbmMhz(c);
    const blocked: Range[] = [];
    for (const p of this.protections()) {
      if (p.kind === 'DPA' && !s.siqIncludeDpa) continue;
      if (!this.affects(p, c)) continue;
      blocked.push(...activeRanges(p).map((x) => clip(x, r)).filter(Boolean) as Range[]);
    }
    const reserved: Range[] = [];
    const palOut: Array<Range & { channelType: 'PAL'; maxEirp: number }> = [];
    for (const p of this.ppas()) {
      const member = p.members.includes(c.cbsdId);
      const inside = p.geometry && c.lat != null && c.lon != null ? pointInGeometry(c.lat, c.lon, p.geometry) : false;
      for (const ch of p.channels) {
        const f = clip(ch, r);
        if (!f) continue;
        if (member) {
          reserved.push(f);
          for (const seg of subtract([f], blocked)) palOut.push({ ...seg, channelType: 'PAL', maxEirp });
        } else if (inside) {
          blocked.push(f);
        }
      }
    }
    const gaaPlan = merge(s.gaaRanges.map((x) => clip(x, r)).filter(Boolean) as Range[]);
    const gaa = subtract(subtract(gaaPlan, blocked), reserved).map((x) => ({ ...x, channelType: 'GAA' as const, maxEirp }));
    const pal = palOut.filter((a, i) => palOut.findIndex((b) => b.low === a.low && b.high === a.high) === i);
    return [...pal, ...gaa].sort((a, b) => a.low - b.low);
  }

  /** Is the range entirely within GAA-available spectrum (ignoring PAL/protections)? */
  inGaaPlan(r: Range): boolean {
    const s = this.getSettings();
    return merge(s.gaaRanges).some((g) => contains(g, r));
  }

  /** Suggest an alternative operating range of the same bandwidth for a rejected/suspended grant. */
  suggest(c: CbsdView, r: Range, avoid: Range[] = []): { maxEirp: number; operationFrequencyRange: { lowFrequency: number; highFrequency: number } } | null {
    const bw = r.high - r.low;
    const avail = this.availability(c).filter((a) => a.channelType === 'GAA' || a.channelType === 'PAL');
    const maxEirp = this.maxEirpDbmMhz(c);
    // candidate starting points on a 5 MHz raster, nearest to the request first
    const cands: Range[] = [];
    for (const a of avail) {
      for (let lo = Math.ceil(a.low / 5e6) * 5e6; lo + bw <= a.high; lo += 5e6) cands.push({ low: lo, high: lo + bw });
    }
    const pick = cands.filter((x) => !avoid.some((v) => overlaps(v, x)))
      .sort((a, b) => Math.abs(a.low - r.low) - Math.abs(b.low - r.low))[0];
    if (!pick) return null;
    return { maxEirp, operationFrequencyRange: { lowFrequency: pick.low, highFrequency: pick.high } };
  }
}

export function activeRanges(p: Row): Range[] {
  if (!p.active) return [];
  const ch = jparse<Array<[number, number]> | null>(p.channels, null);
  if (ch && ch.length) return ch.map(([low, high]) => ({ low, high }));
  return [{ low: p.low_freq, high: p.high_freq }];
}

/** DPA neighbourhood distance per CBSD class (WInnForum move_list.py logic, KML v1.0.7 fields). */
export function neighborhoodKm(hood: any, c: CbsdView, fallback: number): number {
  if (!hood) return fallback;
  const h = c.heightAgl ?? 0;
  const pick = (k: string) => (typeof hood[k] === 'number' && Number.isFinite(hood[k]) ? hood[k] : null);
  let v: number | null;
  if (c.category === 'A') {
    if (c.indoor) v = h > 6 ? pick('catA_Indoor_NeighborhoodDistanceKm') : pick('catA_Indoor_6m_NeighborhoodDistanceKm');
    else v = h > 6 ? pick('catA_Outdoor_NeighborhoodDistanceKm') : pick('catA_Outdoor_6m_NeighborhoodDistanceKm');
    v ??= pick('catANeighborhoodDistanceKm');
  } else {
    v = h > 6 ? pick('catBNeighborhoodDistanceKm') : pick('catB_6m_NeighborhoodDistanceKm');
    v ??= pick('catBNeighborhoodDistanceKm');
  }
  return v ?? fallback;
}

export function merge(rs: Range[]): Range[] {
  const s = [...rs].filter((r) => r.high > r.low).sort((a, b) => a.low - b.low);
  const out: Range[] = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r.low <= last.high) last.high = Math.max(last.high, r.high);
    else out.push({ ...r });
  }
  return out;
}

export function subtract(base: Range[], cut: Range[]): Range[] {
  let cur = merge(base);
  for (const c of merge(cut)) {
    const next: Range[] = [];
    for (const r of cur) {
      if (!overlaps(r, c)) {
        next.push(r);
        continue;
      }
      if (r.low < c.low) next.push({ low: r.low, high: c.low });
      if (r.high > c.high) next.push({ low: c.high, high: r.high });
    }
    cur = next;
  }
  return cur;
}

export function clip(r: Range, b: Range): Range | null {
  const low = Math.max(r.low, b.low);
  const high = Math.min(r.high, b.high);
  return high > low ? { low, high } : null;
}
