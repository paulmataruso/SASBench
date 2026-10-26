# CBRS Lab SAS

A self-hosted Spectrum Access System for bringing up and testing CBRS radios (CBSDs and Domain Proxies) in a lab. It implements the WInnForum SAS–CBSD protocol (**WINNF-TS-0016 v1.2**) and the TLS security profile (**WINNF-TS-0065**), plus the admin API of the WInnForum test harness. A web console shows every exchange and lets you change policy, grants and certificates while it runs.

> **This is a lab tool, not a certified SAS.** It has no FCC/WInnForum certification and must not be used to authorize transmissions outside a controlled test environment.

Everything runs in one container:

| Port | Purpose |
|------|---------|
| `8080` | Web UI and its REST API (`/api/...`) |
| `8000` | SAS–CBSD protocol over plain HTTP: `http://<host>:8000/v1.2/<method>` |
| `8443` | SAS–CBSD protocol over HTTPS with mutual TLS: `https://<host>:8443/v1.2/<method>` |

The test-harness admin API (`POST /admin/...`) is served on the two SAS ports.

---

## Quick start

### Docker Compose

```bash
docker compose up -d --build
# UI:   http://<host-ip>:8080
# SAS:  https://<host-ip>:8443/v1.2/   and   http://<host-ip>:8000/v1.2/
```

The compose file uses **host networking** (Linux), so the listeners bind directly on the host's ports 8080, 8000 and 8443.

On first start the SAS generates a lab PKI and two server certificates (RSA and ECDSA). Their SAN list holds `localhost`, `127.0.0.1`, the hostname and **every IPv4 address of the host** as IP-address entries, so radios can reach the SAS by bare IP as well as by name. Set **`SAS_HOSTNAMES`** for anything else the radios use, such as a DNS name or a NAT address. The list is checked on every start: if an address or name is missing (a new IP, a new `SAS_HOSTNAMES` entry), the auto-generated server certificates are reissued from the same SAS CA. Radios trust the CA, so they need nothing new.

On Docker Desktop (no host networking), remove `network_mode`, enable the `ports` block and put the host's IP in `SAS_HOSTNAMES`. The container cannot see the host's addresses there.

### docker run

```bash
docker build -t cbrs-lab-sas .
docker run -d --name cbrs-lab-sas --network host \
  -v cbrs-sas-data:/data \
  cbrs-lab-sas
```

With port mappings (`-p 8080:8080 -p 8000:8000 -p 8443:8443`) instead of `--network host`, the container only sees its bridge address. Add `-e SAS_HOSTNAMES=<host-ip>` so the server certificate covers the host's IP.

### Local development (Node 24+ and the `openssl` CLI)

```bash
npm install
npm --prefix web install
npm run build:web      # builds the UI into web/dist
npm start              # http://localhost:8080
```

`npm run dev` restarts the server on changes. For UI work, run `npm --prefix web run dev`: Vite serves on :5173 and proxies `/api` to :8080. The server is TypeScript run directly by Node 24's type stripping. It needs no build step and uses the built-in `node:sqlite`.

---

## Pointing a radio at the SAS

1. Open the UI. The **Overview** page lists the SAS URLs.
2. Configure the radio with:
   - `https://<host>:8443/v1.2/`, the production-like setup (mutual TLS); or
   - `http://<host>:8000/v1.2/`, no TLS, for first bring-up or radios without certificates.

   Most CBSDs append the method name (`registration`, `spectrumInquiry`, `grant`, `heartbeat`, `relinquishment`, `deregistration`) to the configured URL. Paths without a version segment (e.g. `/sas/registration`) are also accepted while **Accept version-less paths** is on (the default). Unsupported versions get HTTP 404.
3. For HTTPS, install a device certificate on the radio and the SAS root CA in its trust store (next section).
4. Watch the radio go through registration → grant → heartbeat in the UI. Each request and response is in the **Wire log** with full JSON.

## Certificates for the radio

On first start the SAS creates a lab PKI. It is stored in the database and kept across restarts.

```
CBRS Lab Root CA
├── CBRS Lab SAS CA            → "SAS server RSA (auto)" + "SAS server ECDSA (auto)"
├── CBRS Lab CBSD CA           → device certificates
├── CBRS Lab Domain Proxy CA   → domain proxy (operator) certificates
└── CBRS Lab Installer CA      → CPI (professional installer) certificates
```

Every CA carries the matching WInnForum certificate-policy OIDs (`1.3.6.1.4.1.46609.1.1.x`). Device certificates carry the radio's FCC ID and serial number as WInnForum `FCCID`/`SERIAL` otherNames, with CN `<fccId>:<serial>`.

**To make credentials for a radio:** on the **Certificates** page, issue a CBSD certificate for the radio's FCC ID and serial number, then download the **radio bundle** (`.zip`). It contains:

| File | Use |
|------|-----|
| `device-cert.pem` / `.der` | Device (TLS client) certificate |
| `device-key.pem` | Private key, PKCS#8 (`BEGIN PRIVATE KEY`) |
| `device-key-traditional.pem` | Private key, PKCS#1/SEC1 (`BEGIN RSA PRIVATE KEY`), for older firmware |
| `device-chain.pem` | Device certificate + CBSD CA |
| `device-fullchain.pem` | Device certificate + CBSD CA + root |
| `device-cert-and-key.pem` | Chain followed by the key, in one file |
| `device.p12` | PKCS#12 (AES); password `cbrs` unless you choose another |
| `device-legacy.p12` | PKCS#12 with 3DES/SHA-1 for older radios; same password |
| `client-issuer-root-ca.pem` | Root of the device certificate's chain |
| `sas-root-ca.pem` / `.crt` / `.der` | **Install on the radio**: trust anchor for the SAS server certificate |
| `sas-ca-chain.pem` | SAS issuing CA + root |
| `README.txt` | What each file is, plus the SAS URLs |

You can also:

- issue many devices at once (one `fccId,serial` per line; you get a zip of bundles);
- issue domain proxy and CPI installer certificates (an installer certificate also registers the CPI for signature checks);
- download single files in PEM, CRT, DER, chain, key or PKCS#12 form;
- import your own CAs, certificates, keys, PKCS#12 files and CRLs;
- revoke certificates and choose which certificates the HTTPS listener presents and which CAs it trusts for client authentication;
- download all CA certificates as one PEM: `GET /api/trust-bundle`.

The same operations exist on the REST API, for example `POST /api/certs/cbsd {"parentId": "<CBSD CA id>", "fccId": "...", "serial": "..."}` and then `GET /api/certs/<id>/download?format=bundle&password=cbrs`.

## TLS behaviour (WINNF-TS-0065)

- **TLS 1.2 only** by default.
- Only the WInnForum cipher suites: `AES128-GCM-SHA256`, `AES256-GCM-SHA384`, `ECDHE-ECDSA-AES128-GCM-SHA256`, `ECDHE-ECDSA-AES256-GCM-SHA384`, `ECDHE-RSA-AES128-GCM-SHA256`. An "extended" policy and Node's defaults can be selected in Settings for odd clients.
- Both an RSA and an ECDSA server certificate are presented, so ECDSA and RSA suites can both be negotiated.
- **Client certificates:**
  - `optional` (the default) requests one and records whether it verified;
  - `require` makes the handshake fail without a certificate from a trusted CA;
  - `none` does not ask.

  Turn on **Reject unverified client certificates** to answer HTTP 403 to certificates that fail verification when the mode is `optional`.
- **Revocation:** the whole client chain is checked on every connection against locally revoked certificates and imported CRLs. A revoked certificate gets HTTP 403. Sessions are never resumed, so every request is re-checked.
- **Role check:** before any other validation, CBSD-protocol requests whose certificate carries non-CBSD WInnForum policies (e.g. `ROLE_SAS`) get responseCode **104** (CERT_ERROR) for every element. In *strict* mode, `ROLE_CBSD` or `ROLE_OPERATOR` is also required.
- **Identity binding:** the FCC ID and serial in a CBSD certificate are compared with the registration request. With `certIdentityCheck` = `enforce`, a mismatch gets 104, and a cbsdId cannot be used by a different TLS identity than the one that registered it.

## Settings profiles

Settings are live-edited on the **Settings** page and stored in the database. Three profiles set many of them at once:

| Profile | Use |
|---------|-----|
| `lab` (default behaviour) | Bring-up of real radios: HTTP and HTTPS, optional client certificates, unknown FCC/user IDs accepted, CPI and identity problems logged as warnings, 7-day grants |
| `winnforum` | Matches the test harness: mutual TLS required, FCC and user IDs must be injected, strict CPI rules, cbsdId bound to the registering certificate, 15-minute grants, 200 s transmit window |
| `open` | No client certificates, no role or identity checks; for simulators and `curl` |

`SAS_PROFILE=<name>` applies a profile once, on the first start with an empty data volume.

## Features

- **Full protocol:** registration (including CPI-signed installation data, REG-conditional preloads, blacklists and FCC/user ID databases), spectrum inquiry, grant, heartbeat, relinquishment, deregistration.
  - Batched Domain Proxy requests are answered in order.
  - Re-registration keeps the same cbsdId and removes the old grants.
- **Grant control:** suspend (501 at the next heartbeat) and resume, terminate (500), change the heartbeat interval or expiry, suggest operation parameters.
- **CBSD control:** manual approval (new registrations get 200 REG_PENDING until approved), SAS-initiated deregistration (105 on the next request), force deregistration, per-CBSD EIRP caps, measurement-report configuration.
- **Incumbents and protection:**
  - Load the NTIA E-DPA/P-DPA KML files (bundled in `server/data/ntia`) and activate or deactivate DPAs per channel; active DPAs suspend affected grants.
  - PPAs (PAL Protection Areas), FSS earth stations with GWBL exclusion, WISP GWPZ, exclusion zones and administrator-defined protections.
- **Fault injection:** rewrite response codes, patch response fields, return HTTP errors, delay, drop the connection or send malformed JSON. Rules can match a method and/or a CBSD and run a limited number of times.
- **Diagnostics:**
  - Wire log with the full request and response JSON of every exchange, including TLS handshake failures and 403s, with NDJSON export.
  - Event log, and live updates in the UI over server-sent events.
  - A request console that sends hand-written requests through the engine.
- **Backup:** export/import configuration as JSON.

## Running the WInnForum test harness

The harness is at <https://github.com/Wireless-Innovation-Forum/Spectrum-Access-System>.

1. Apply the **WInnForum strict** profile (Settings), or start with `SAS_PROFILE=winnforum`.
2. Import the harness CA certificates on the **Certificates** page so its client certificates are trusted. Also import their CRLs if you run the security tests. Install the SAS root CA (`/api/trust-bundle`) as the harness's trusted CA.
3. Download a matching `sas.cfg` from `GET /api/harness/sas.cfg?host=<name-in-the-server-cert>`. Every base URL points at the HTTPS port, where the admin API (`/admin/reset`, `/admin/injectdata/...`, `/admin/trigger/...`, `/admin/get_daily_activities_status`, ...) is also served.
4. **Terrain for HAAT (REG test for Category A outdoor height).** The rule needs USGS NED 1-arc-second GridFloat tiles (`.flt` + `.hdr`, as in the WInnForum SAS-Data repository).
   - Put them in `/data/terrain`, or point `SAS_TERRAIN_DIR` at them.
   - Tiles are found by the `n40w101`-style key in the file name, e.g. `floatn40w101_1_std.flt`.
   - Without tiles the HAAT check is skipped, so the harness test that expects a HAAT rejection fails.

## Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `SAS_DATA_DIR` | `./data` (`/data` in Docker) | Database (`sas.db`), PKI working files, default terrain directory |
| `UI_PORT` | `8080` | Web UI / REST API port |
| `SAS_HTTP_PORT` | `8000` (setting) | Overrides the SAS HTTP port setting on every start |
| `SAS_HTTPS_PORT` | `8443` (setting) | Overrides the SAS HTTPS port setting on every start |
| `SAS_HOSTNAMES` | — | Extra comma-separated names/IPs for the auto-generated server certificates (checked on every start; the host's own IPs are always included) and shown as SAS URLs |
| `SAS_PROFILE` | — | `lab`, `winnforum` or `open`, applied once on first start |
| `SAS_UI_PASSWORD` | — | Protects the UI with HTTP Basic auth (any user name, this password); applied on every start |
| `SAS_TERRAIN_DIR` | `$SAS_DATA_DIR/terrain` | USGS NED GridFloat tiles for the HAAT check |
| `SAS_WEB_DIR` | `web/dist` | Location of the built UI |

## Data and persistence

All state lives in `$SAS_DATA_DIR` (the `/data` volume in Docker):

- `sas.db`, a SQLite database: settings, CBSDs, grants, PKI (certificates and private keys), registries, protections, logs;
- `tmp/`, scratch space for OpenSSL;
- `terrain/`, optional elevation tiles.

Back up the volume to keep your PKI. Deleting it regenerates a fresh one, and radios then need new certificates. Resetting the SAS (from the UI, or the harness's `POST /admin/reset`) clears CBSDs, grants, registries, protections/DPAs/PPAs and injected incumbent data, but keeps certificates, settings and logs.

## Tests

```bash
npm test         # integration tests: start the real server on free ports and exercise HTTP, HTTPS and the admin API
npm run typecheck
```

## Limitations

- No propagation or aggregate-interference model (no IAP or move lists). DPAs, PPAs and protections are enforced geometrically (inside the polygon or neighbourhood distance) and per frequency.
- PPA contours created by `trigger/create_ppa` are simplified (fixed-radius circles around the cluster), not the WInnForum PPA contour model.
- Single node: SAS–SAS exchange is limited to pulling peer full-activity dumps during daily activities.
- Spectrum inquiry ignores DPAs by default, as the harness expects; this can be changed in Settings.
- A client certificate that fails verification (untrusted CA, expired) ends the TLS connection without a TLS alert. Node.js verifies the client chain after the handshake and then closes the socket, so the radio sees the connection drop instead of an `unknown_ca` or `certificate_expired` alert. The connection is still refused, and the WInnForum security tests accept this.
- Without terrain tiles the Category A HAAT check is skipped. The server says so at startup and logs a warning for each registration it could not check.
