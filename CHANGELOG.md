# Changelog

## 1.0.0 (unreleased)

First release.

- SAS–CBSD protocol (WINNF-TS-0016 v1.2): registration with CPI-signed installation data, conditional registration and FCC/user ID databases, spectrum inquiry, grant, heartbeat, relinquishment and deregistration, with batched Domain Proxy requests.
- TLS profile (WINNF-TS-0065): TLS 1.2 with the WInnForum cipher suites, RSA and ECDSA server certificates, optional or required client certificates, role and identity checks, CRLs and local revocation.
- Lab PKI created on first start, with radio certificate bundles in PEM, DER, PKCS#1, PKCS#8 and PKCS#12 (current and legacy) and step-by-step instructions for Nokia AirScale BBUs.
- Grant and CBSD control: suspend, terminate, heartbeat interval and expiry changes, manual approval, SAS-initiated deregistration (105), per-CBSD EIRP caps and measurement-report configuration.
- Incumbents and protection: NTIA E-DPA and P-DPA definitions, PPAs, FSS earth stations with GWBL exclusion, WISP GWPZ, exclusion zones and administrator-defined protections; Category A HAAT check from USGS terrain tiles.
- Fault injection: rewritten response codes, patched response fields, HTTP errors, delays, dropped connections and malformed JSON, per method and per CBSD.
- WInnForum test harness admin API, a strict settings profile and a generated `sas.cfg`.
- Web console: CBSD rack with live LEDs, band plan and map, wire log with full JSON and NDJSON export, events, request console, certificates, registry and live settings.
- Offline map: built-in North America basemap, offline MBTiles and tile folders, and area downloads from a tile server.
- One Docker container with host networking, SQLite storage and a health check.
