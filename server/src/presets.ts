import type { Settings } from './settings.ts';

// Named setting profiles applied from the Settings page.

export interface Preset {
  label: string;
  description: string;
  patch: Partial<Settings>;
}

export const PRESETS: Record<string, Preset> = {
  lab: {
    label: 'Lab (permissive)',
    description: 'For bring-up of real radios: HTTP and HTTPS, client certificates optional, unknown FCC/user IDs accepted, '
      + 'CPI and identity problems logged as warnings, 7-day grants.',
    patch: {
      sasHttpEnabled: true, sasHttpsEnabled: true, tlsClientAuth: 'optional', rejectUnverifiedClientCert: false,
      tlsMinVersion: 'TLSv1.2', tlsMaxVersion: 'TLSv1.2', tlsCipherPolicy: 'winnforum', tlsCheckCrl: true, certRoleCheck: 'lenient',
      acceptVersionlessPaths: true, versionErrorAsResponseCode: false,
      heartbeatIntervalSec: 60, transmitExpireSec: 240, grantExpireSec: 7 * 86400,
      requireKnownFccId: false, requireKnownUserId: false, registrationPolicy: 'lenient', certIdentityCheck: 'warn',
      manualApproval: false, haatCheck: true, rejectIndoorCatB: true, acceptMicrodegrees: true, strictOperationState: false,
      siqIncludeDpa: false, siqChannelization: 'none', harnessAdminEnabled: true,
    },
  },
  winnforum: {
    label: 'WInnForum test harness (strict)',
    description: 'Matches WINNF-TS-0061 expectations: mutual TLS required (TLS 1.2, WInnForum ciphers, CRLs), FCC and user IDs '
      + 'must be injected, strict CPI rules, cbsdId bound to the registering certificate, 15-minute grants, 200 s transmit window.',
    patch: {
      sasHttpsEnabled: true, tlsClientAuth: 'require', rejectUnverifiedClientCert: true,
      tlsMinVersion: 'TLSv1.2', tlsMaxVersion: 'TLSv1.2', tlsCipherPolicy: 'winnforum', tlsCheckCrl: true, certRoleCheck: 'lenient',
      supportedVersions: ['v1.2'], acceptVersionlessPaths: false, versionErrorAsResponseCode: false,
      heartbeatIntervalSec: 60, transmitExpireSec: 200, grantExpireSec: 900,
      requireKnownFccId: true, requireKnownUserId: true, registrationPolicy: 'strict', missingInstallParams: 'pending', certIdentityCheck: 'enforce',
      manualApproval: false, haatCheck: true, rejectIndoorCatB: true, acceptMicrodegrees: false, strictOperationState: false,
      siqIncludeDpa: false, siqChannelization: 'none', harnessAdminEnabled: true, defaultFccMaxEirp: 47,
      maxEirpCatA: 20, maxEirpCatB: 37, gaaRanges: [{ low: 3550e6, high: 3700e6 }], maxGrantBandwidthHz: 150e6,
      grantFrequencyStepHz: 0, responseDelayMs: 0,
    },
  },
  open: {
    label: 'Open (no security)',
    description: 'Everything accepted: no client certificates requested, no role/identity checks, and radios that send no location still register. Useful with simulators and curl.',
    patch: {
      sasHttpEnabled: true, sasHttpsEnabled: true, tlsClientAuth: 'none', rejectUnverifiedClientCert: false, certRoleCheck: 'off',
      certIdentityCheck: 'off', requireKnownFccId: false, requireKnownUserId: false, registrationPolicy: 'lenient',
      missingInstallParams: 'register', acceptVersionlessPaths: true, haatCheck: false, acceptMicrodegrees: true,
    },
  },
};
