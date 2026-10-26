import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Ppa, Protection } from '../../lib/types';

// Shared types and helpers for the Spectrum page.

export interface SpectrumGrant {
  grantId: string;
  cbsdId: string;
  state: 'GRANTED' | 'AUTHORIZED';
  suspended: boolean;
  low: number;
  high: number;
  maxEirp: number;
  channelType: string;
  lat: number | null;
  lon: number | null;
}

export interface SpectrumCbsd {
  cbsdId: string;
  fccId: string;
  serial: string;
  category: string | null;
  lat: number | null;
  lon: number | null;
  indoor: boolean | null;
}

export interface IncumbentRow {
  id: string;
  data: any;
}

export interface SpectrumData {
  band: { low: number; high: number };
  gaaRanges: Array<{ low: number; high: number }>;
  protections: Protection[];
  ppas: Ppa[];
  grants: SpectrumGrant[];
  cbsds: SpectrumCbsd[];
  incumbents: { fss: IncumbentRow[]; wisp: IncumbentRow[]; pal: IncumbentRow[]; escSensors: IncumbentRow[]; peerSas: IncumbentRow[] };
}

/** Frequency ranges a protection currently blocks (empty when inactive). */
export function activeRanges(p: Protection): Array<[number, number]> {
  if (!p.active) return [];
  if (p.channels && p.channels.length) return p.channels.map((c) => [c[0], c[1]] as [number, number]);
  return [[p.low, p.high]];
}

export function protectionTone(p: Protection): 'warn' | 'bad' | 'off' {
  if (!p.active) return 'off';
  return p.action === 'terminate' ? 'bad' : 'warn';
}

export const KIND_ORDER = ['DPA', 'ESC', 'FSS_GWBL', 'GWPZ', 'EXCLUSION_ZONE', 'EXCLUSION', 'FSS', 'ADMIN'];

export const KIND_LABEL: Record<string, string> = {
  DPA: 'DPA', ESC: 'ESC', FSS_GWBL: 'FSS+GWBL', GWPZ: 'GWPZ', EXCLUSION_ZONE: 'Excl. zone', EXCLUSION: 'Exclusion', FSS: 'FSS', ADMIN: 'Admin',
};

export function kindRank(k: string) {
  const i = KIND_ORDER.indexOf(k);
  return i < 0 ? KIND_ORDER.length : i;
}

/** Area description of a protection. */
export function areaOf(p: Protection): 'polygon' | 'circle' | 'band-wide' {
  if (p.geometry) return 'polygon';
  if (p.latitude != null && p.longitude != null && p.radiusKm != null) return 'circle';
  return 'band-wide';
}

/** GeoJSON polygon approximating a circle (n vertices) around lat/lon. */
export function circlePolygon(lat: number, lon: number, km: number, n = 64) {
  const R = 6371.0088;
  const d = km / R;
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  const ring: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const b = (2 * Math.PI * (i % n)) / n;
    const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
    const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    ring.push([+((lo2 * 180) / Math.PI).toFixed(6), +((la2 * 180) / Math.PI).toFixed(6)]);
  }
  return { type: 'Polygon', coordinates: [ring] };
}

/** Resolve a palette token (e.g. "p3", "warn") to an rgb() string usable by canvas / SVG attributes. */
export function cssRgb(token: string, alpha = 1): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--${token}`).trim();
  if (!v) return `rgba(128,128,128,${alpha})`;
  const [r, g, b] = v.split(/\s+/);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Bumps whenever the colour theme changes (explicit toggle or OS preference). */
export function useThemeVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const bump = () => setV((x) => x + 1);
    const mo = new MutationObserver(bump);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', bump);
    return () => {
      mo.disconnect();
      mq.removeEventListener('change', bump);
    };
  }, []);
  return v;
}

/** Observed content width of an element. */
export function useWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setW(Math.floor(entries[0].contentRect.width)));
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Greedy lane packing: items sorted by low edge, each placed in the first lane it fits. */
export function packLanes<T extends { low: number; high: number }>(items: T[]): T[][] {
  const lanes: T[][] = [];
  const ends: number[] = [];
  for (const it of [...items].sort((a, b) => a.low - b.low || a.high - b.high)) {
    let i = ends.findIndex((e) => e <= it.low);
    if (i < 0) {
      i = lanes.length;
      lanes.push([]);
      ends.push(0);
    }
    lanes[i].push(it);
    ends[i] = it.high;
  }
  return lanes;
}

export const hz = (mhzText: string) => Math.round(Number(mhzText) * 1e6);

/** Merge adjacent / overlapping ranges. */
export function mergeRanges(r: Array<[number, number]>): Array<[number, number]> {
  const s = [...r].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [l, h] of s) {
    const last = out[out.length - 1];
    if (last && l <= last[1]) last[1] = Math.max(last[1], h);
    else out.push([l, h]);
  }
  return out;
}

export function rfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
