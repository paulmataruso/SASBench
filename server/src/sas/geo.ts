// Geometry helpers for protection zones: great-circle distance, point-in-polygon
// for GeoJSON (Multi)Polygons, and distance from a point to a polygon boundary.

const R_EARTH_KM = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

type Ring = number[][]; // [lon, lat][]

function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Polygons as arrays of rings (first ring outer, rest holes). */
export function polygonsOf(geom: any): Ring[][] {
  if (!geom) return [];
  if (geom.type === 'FeatureCollection') return (geom.features ?? []).flatMap((f: any) => polygonsOf(f.geometry));
  if (geom.type === 'Feature') return polygonsOf(geom.geometry);
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  if (geom.type === 'GeometryCollection') return (geom.geometries ?? []).flatMap((g: any) => polygonsOf(g));
  return [];
}

export function pointInGeometry(lat: number, lon: number, geom: any): boolean {
  for (const poly of polygonsOf(geom)) {
    if (!poly.length || !pointInRing(lon, lat, poly[0])) continue;
    if (poly.slice(1).some((hole) => pointInRing(lon, lat, hole))) continue;
    return true;
  }
  return false;
}

/** Approximate minimum distance (km) from a point to a polygon (0 if inside). */
export function distanceToGeometryKm(lat: number, lon: number, geom: any): number {
  if (pointInGeometry(lat, lon, geom)) return 0;
  let best = Infinity;
  for (const poly of polygonsOf(geom)) {
    for (const ring of poly) {
      for (let i = 0; i + 1 < ring.length; i++) {
        best = Math.min(best, distanceToSegmentKm(lat, lon, ring[i][1], ring[i][0], ring[i + 1][1], ring[i + 1][0]));
      }
    }
  }
  return best;
}

function distanceToSegmentKm(lat: number, lon: number, lat1: number, lon1: number, lat2: number, lon2: number): number {
  // Local equirectangular projection around the query point is accurate to well under 1% at these scales.
  const kx = 111.32 * Math.cos(rad(lat));
  const ky = 110.574;
  const ax = (lon1 - lon) * kx, ay = (lat1 - lat) * ky;
  const bx = (lon2 - lon) * kx, by = (lat2 - lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = ax + t * dx, py = ay + t * dy;
  const approx = Math.hypot(px, py);
  // refine with great-circle distance to the projected point
  const plon = lon + px / kx, plat = lat + py / ky;
  return Number.isFinite(approx) ? distanceKm(lat, lon, plat, plon) : Infinity;
}

/** Parse KML Placemarks with Polygon coordinates and ExtendedData into GeoJSON-ish objects. */
export function parseKmlPlacemarks(kml: string): Array<{ name: string; data: Record<string, string>; geometry: any }> {
  const out: Array<{ name: string; data: Record<string, string>; geometry: any }> = [];
  const pmRe = /<Placemark[\s\S]*?<\/Placemark>/g;
  for (const pm of kml.match(pmRe) ?? []) {
    const name = (/<name>([\s\S]*?)<\/name>/.exec(pm)?.[1] ?? '').trim();
    const data: Record<string, string> = {};
    for (const m of pm.matchAll(/<(?:Data|SimpleData) name="([^"]+)">\s*(?:<value>)?([\s\S]*?)(?:<\/value>)?\s*<\/(?:Data|SimpleData)>/g)) {
      data[m[1]] = m[2].trim();
    }
    const polys: Ring[][] = [];
    for (const poly of pm.match(/<Polygon[\s\S]*?<\/Polygon>/g) ?? []) {
      const rings: Ring[] = [];
      const outer = /<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/.exec(poly)?.[1];
      if (outer) rings.push(parseCoords(outer));
      for (const m of poly.matchAll(/<innerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g)) rings.push(parseCoords(m[1]));
      if (rings.length) polys.push(rings);
    }
    if (polys.length) out.push({ name, data, geometry: { type: 'MultiPolygon', coordinates: polys } });
  }
  return out;
}

function parseCoords(s: string): Ring {
  return s.trim().split(/\s+/).map((t) => t.split(',').slice(0, 2).map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
}
