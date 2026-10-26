// MeasReport validation (WINNF-SSC-0002 §7.1): Received Power reports.
//
//   measReport: { rcvdPowerMeasReports: [ { measFrequency, measBandwidth, measRcvdPower } ] }
//
// RECEIVED_POWER_WITHOUT_GRANT reports must cover the entire CBRS band in segments of
// at most 10 MHz; RECEIVED_POWER_WITH_GRANT reports cover one or more ranges <= 10 MHz.

export type MeasCheck =
  | { ok: true }
  | { ok: false; code: 102 | 103; params: string[]; message: string };

export function validateMeasReport(
  mr: any,
  opts: { fullBand: boolean; bandLow: number; bandHigh: number },
): MeasCheck {
  if (mr === null || typeof mr !== 'object' || Array.isArray(mr)) {
    return { ok: false, code: 103, params: ['measReport'], message: 'measReport must be an object' };
  }
  const indoor = mr.indoorLossGNSSMeasReport;
  if (mr.rcvdPowerMeasReports === undefined) {
    if (indoor !== undefined && !opts.fullBand) return validateIndoor(indoor);
    return { ok: false, code: 102, params: ['measReport.rcvdPowerMeasReports'], message: 'rcvdPowerMeasReports missing' };
  }
  const reps = mr.rcvdPowerMeasReports;
  if (!Array.isArray(reps)) {
    return { ok: false, code: 103, params: ['measReport.rcvdPowerMeasReports'], message: 'rcvdPowerMeasReports must be an array' };
  }
  const missing = new Set<string>();
  const invalid = new Set<string>();
  for (const r of reps) {
    if (!r || typeof r !== 'object') {
      invalid.add('measReport.rcvdPowerMeasReports');
      continue;
    }
    for (const k of ['measFrequency', 'measBandwidth', 'measRcvdPower']) {
      if (r[k] === undefined) missing.add(`measReport.rcvdPowerMeasReports.${k}`);
      else if (typeof r[k] !== 'number' || !Number.isFinite(r[k])) invalid.add(`measReport.rcvdPowerMeasReports.${k}`);
    }
  }
  if (missing.size) return { ok: false, code: 102, params: [...missing], message: 'Missing measurement report parameters' };
  for (const r of reps) {
    if (r.measBandwidth <= 0 || r.measBandwidth > 10e6) invalid.add('measReport.rcvdPowerMeasReports.measBandwidth');
    if (r.measFrequency < opts.bandLow || r.measFrequency + r.measBandwidth > opts.bandHigh) invalid.add('measReport.rcvdPowerMeasReports.measFrequency');
    if (r.measRcvdPower < -100 || r.measRcvdPower > -25) invalid.add('measReport.rcvdPowerMeasReports.measRcvdPower');
  }
  if (invalid.size) return { ok: false, code: 103, params: [...invalid], message: 'Invalid measurement report values' };
  if (opts.fullBand) {
    // Coverage of the whole band (sorted, contiguous, gaps not allowed).
    const segs = reps.map((r: any) => [r.measFrequency, r.measFrequency + r.measBandwidth] as [number, number]).sort((a: any, b: any) => a[0] - b[0]);
    let cursor = opts.bandLow;
    for (const [lo, hi] of segs) {
      if (lo > cursor) break;
      cursor = Math.max(cursor, hi);
    }
    if (cursor < opts.bandHigh) {
      return { ok: false, code: 102, params: ['measReport.rcvdPowerMeasReports'], message: 'Measurement report does not cover the entire CBRS band' };
    }
  }
  return { ok: true };
}

function validateIndoor(v: any): MeasCheck {
  if (!Array.isArray(v)) return { ok: false, code: 103, params: ['measReport.indoorLossGNSSMeasReport'], message: 'must be an array' };
  for (const r of v) {
    for (const k of ['indoorLoss', 'azimuthAngleWithGNSS', 'elevationAngleWithGNSS', 'technologyType']) {
      if (!r || r[k] === undefined) return { ok: false, code: 102, params: [`measReport.indoorLossGNSSMeasReport.${k}`], message: 'missing' };
    }
  }
  return { ok: true };
}
