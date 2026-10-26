// Time helpers. The SAS-CBSD protocol (WINNF-TS-0016) expresses all times as
// UTC in the exact form YYYY-MM-DDThh:mm:ssZ (RFC 3339, no fractional seconds).

export function nowMs(): number {
  return Date.now();
}

export function toRfc3339(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Floor to whole seconds so stored times round-trip exactly through toRfc3339. */
export function floorSec(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

const RFC3339_STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function parseRfc3339Strict(s: unknown): number | null {
  if (typeof s !== 'string' || !RFC3339_STRICT.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
