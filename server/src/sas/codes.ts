// WINNF-TS-0016 Table 39: response codes.
export const RC = {
  SUCCESS: 0,
  VERSION: 100,
  BLACKLISTED: 101,
  MISSING_PARAM: 102,
  INVALID_VALUE: 103,
  CERT_ERROR: 104,
  DEREGISTER: 105,
  REG_PENDING: 200,
  GROUP_ERROR: 201,
  UNSUPPORTED_SPECTRUM: 300,
  INTERFERENCE: 400,
  GRANT_CONFLICT: 401,
  TERMINATED_GRANT: 500,
  SUSPENDED_GRANT: 501,
  UNSYNC_OP_PARAM: 502,
} as const;

export const RC_NAME: Record<number, string> = Object.fromEntries(Object.entries(RC).map(([k, v]) => [v, k]));

export interface ResponseObj {
  responseCode: number;
  responseMessage?: string;
  responseData?: unknown;
}
