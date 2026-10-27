# Changelog

## 1.0.0 (unreleased)

First release.

- SAS–CBSD protocol (WINNF-TS-0016 v1.2): registration with CPI-signed installation data, conditional registration and FCC/user ID databases, spectrum inquiry, grant, heartbeat, relinquishment and deregistration, with batched Domain Proxy requests.
- SAS listeners that tolerate radio quirks: HTTP/1.1 requests without a `Host` header (Sercomm NR radios send none) and, while the setting is on, paths without a protocol version.
- TLS profile (WINNF-TS-0065): TLS 1.2 with the WInnForum cipher suites, RSA and ECDSA server certificates, optional or required client certificates, role and identity checks, CRLs and local revocation.
- Lab PKI created on first start, with radio certificate bundles in PEM, DER, PKCS#1, PKCS#8 and PKCS#12 (current and legacy) and step-by-step instructions for Nokia AirScale BBUs.
- Grant and CBSD control: suspend, terminate, heartbeat interval and expiry changes, manual approval, SAS-initiated deregistration (105), per-CBSD EIRP caps and measurement-report configuration.
- Incumbents and protection: NTIA E-DPA and P-DPA definitions, PPAs, FSS earth stations with GWBL exclusion, WISP GWPZ, exclusion zones and administrator-defined protections; Category A HAAT check from USGS terrain tiles.
- Fault injection: rewritten response codes, patched response fields, HTTP errors, delays, dropped connections and malformed JSON, per method and per CBSD.
- WInnForum test harness admin API, a strict settings profile and a generated `sas.cfg`.
- Web console: CBSD rack with live LEDs, band plan and map, wire log with full JSON and NDJSON export, events, request console, certificates, registry and live settings.
- Offline map: built-in North America basemap, offline MBTiles and tile folders, and area downloads from a tile server.
- REST API at `/api/v1` (176 operations): CBSDs and grants, protocol requests over the internal path or the real HTTP/HTTPS listeners (with lab client certificates), registry, spectrum and incumbents, fault rules, wire and event logs with a live Server-Sent Events stream, PKI and TLS, harness admin calls, every setting, map and terrain, configuration export/import, database backup and read-only access to every table. Read-only and read-write API keys owned by users, an OpenAPI 3.1 description, a guide, a generated reference with a real `curl` example and response for every operation, and an architecture document.
- User accounts: sign-in for the console and the REST API (first start: `admin` / `admin`, or `SAS_ADMIN_PASSWORD`), admin, operator and viewer roles, a Users page to add, edit, disable and delete accounts and end their sessions, a Your account page for changing your password, an API keys page, a throttle on failed sign-ins, and `reset-password.ts` for when nobody can sign in. `SAS_AUTH=off` switches sign-in off for isolated benches.
- Registry: radios that have registered can be added to the registry (FCC ID, user ID and registration data) in one click, from Registry → Registered radios, the CBSDs page or a CBSD's page.
- Deployment settings in a `.env` file (`.env.example`): `SAS_FQDN` (the name in the SAS server certificates and on the Overview), `SAS_BIND_IP`, `SAS_API_PORT` (the REST API on a port of its own), `SAS_HTTP_PORT` and `SAS_HTTPS_PORT` (the radio ports, any free port including 80 and 443; locked in Settings while set), and `SAS_PROFILE` applied on first start and whenever it changes (`SAS_PROFILE_APPLY=always` for every start). The Overview shows the SAS endpoints by FQDN and the address in use, without `localhost`.
- One Docker container with host networking, SQLite storage and a health check.
- Radio compatibility list ([RADIOS.md](RADIOS.md)), starting with the Nokia AirScale AMIA + ASIA + AZQC on SBTS25R2.
