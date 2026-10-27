# SASBench user guide

How to connect radios, issue their certificates, control what the SAS does, and run the WInnForum test harness. For installation, see [INSTALL.md](INSTALL.md).

- [The console at a glance](#the-console-at-a-glance)
- [Connecting a radio](#connecting-a-radio)
- [Certificates for the radio](#certificates-for-the-radio)
- [TLS behaviour (WINNF-TS-0065)](#tls-behaviour-winnf-ts-0065)
- [Settings profiles](#settings-profiles)
- [What the SAS can do](#what-the-sas-can-do)
- [Map](#map)
- [Terrain (Category A HAAT)](#terrain-category-a-haat)
- [Running the WInnForum test harness](#running-the-winnforum-test-harness)
- [Automating with the REST API](#automating-with-the-rest-api)
- [Data and persistence](#data-and-persistence)
- [Limitations](#limitations)

## The console at a glance

| Page | What it is for |
|------|----------------|
| **Overview** | The SAS URLs to put in a radio, the CBSD rack (REG, GNT and HB LEDs and the transmit window of every radio), band occupancy, SAS state and a live feed of exchanges. |
| **CBSDs** | Every radio that has sent a registration request. Each one has a page with its grants, exchanges, events and raw registration, operator overrides (EIRP cap, measurement reports, notes) and actions: approve, send 105, deregister, delete. |
| **Grants** | Every grant with its channel, EIRP, heartbeats and expiry. Suspend, edit or terminate any of them. |
| **Spectrum** | The band plan (GAA, PAL, protections and grants on one frequency axis), the map of CBSDs and protection areas, and PPAs. |
| **Wire log** | Every request that reached the SAS, with the exact JSON exchanged. Filter by method, search, show errors only, export NDJSON, or replay a request in the console. |
| **Events** | The SAS's own account of what happened: state changes, policy decisions, warnings about lenient checks, operator actions. |
| **Request console** | Send hand-written SAS–CBSD requests into the engine, as a radio would, from per-method templates. Shows the same request as a `curl` command. |
| **Fault injection** | Rules that rewrite what the SAS listeners put on the wire, plus one-click quick faults. |
| **Certificates** | The lab PKI: radio certificate kits, CA, server, domain proxy and installer certificates, imports, CRLs, and step-by-step instructions for Nokia AirScale BBUs. |
| **Registry** | FCC ID and user ID databases, the blacklist, conditional registration (preloaded installation data), CPI users, and signing CPI data. |
| **Settings** | Profiles, listeners and TLS, protocol, registration and spectrum policy, test harness, map, UI and logs, and maintenance (export, import, reset). |

**Following a CBSD.** Pick a radio in the **Follow a CBSD** box at the top of every page. It is highlighted everywhere it appears, and the Grants, Wire log and Events pages get a **Followed CBSD only** switch.

**Reading the rack LEDs.** REG is the registration state, GNT the grant state and HB the heartbeat. Green means registered, authorized or on time; amber means pending, suspended or late; red means terminated or an error; blue means granted but not yet authorized to transmit; grey means none. The heartbeat LED follows each radio's own heartbeat interval: it turns amber when a heartbeat is late and grey when the radio has gone quiet.

## Connecting a radio

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
SASBench Root CA
├── SASBench SAS CA            → "SAS server RSA (auto)" + "SAS server ECDSA (auto)"
├── SASBench CBSD CA           → device certificates
├── SASBench Domain Proxy CA   → domain proxy (operator) certificates
└── SASBench Installer CA      → CPI (professional installer) certificates
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
| `open` | No client certificates, no role or identity checks, and radios that send no location still register; for simulators, `curl` and quick bring-up |

`SAS_PROFILE=<name>` applies a profile once, on the first start with an empty data volume.

### Radios that send no location

Many Category B radios (Nokia AirScale, for one) register without installation data, expecting a CPI-signed block or SAS-side data. The **Radio sends no location** setting (Settings → Registration policy) decides what happens when nothing is preloaded for the radio:

- **Hold:** 200 REG_PENDING until the data is preloaded (Registry → Conditional registration). This is the WInnForum behaviour, used by `lab` and `winnforum`.
- **Register anyway:** used by `open`. The location stays unknown: the radio counts as inside every active protection area and is not drawn on the map.

Either way the SAS uses everything the radio does send. Preloaded data only fills fields the radio leaves out, and CPI-signed data overrides both.

## What the SAS can do

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

## Map

The Spectrum page map shows CBSDs, protection areas and PPAs. Choose its base map in **Settings → Map**:

- **Built-in basemap (default).** North America drawn from Natural Earth data: coastlines, lakes, country and state borders, highways, urban areas and city names. It ships with the UI and needs no internet access. It is always drawn underneath, so the map is never blank, even when another source fails or does not cover the view.
- **Offline tiles.** Raster tiles from the tile store, `/data/tiles` (`SAS_TILES_DIR`). The store accepts:
  - MBTiles files (`*.mbtiles`) with PNG, JPEG or WebP tiles. Vector MBTiles (`pbf`) are not supported.
  - Folders laid out as `<name>/<z>/<x>/<y>.png` (or `.jpg`/`.webp`).

  Copy them in with `docker cp lab.mbtiles sasbench:/data/tiles/`, then press **Rescan**.
- **Online tile server.** Any XYZ URL template with `{z}`, `{x}` and `{y}`. `{-y}` (TMS) and `{s}` also work. The presets are the USGS National Map (Topo, Imagery, Imagery + Topo), which is public domain and needs no API key.

**Downloading an area for offline use.** Settings → Map → *Download an area* saves tiles from a tile server into a new MBTiles file in the store. The area can be the registered CBSDs plus a margin, or a box you enter. Pick the zoom range, start the download, and switch the map to the file once it finishes. A download is limited to 100,000 tiles. Zoom 6–14 around a few sites is typically 1,000–5,000 tiles (20–100 MB).

OpenStreetMap's tile servers forbid bulk downloading ([tile usage policy](https://operations.osmfoundation.org/policies/tiles/)), so the downloader refuses them. They can still be used as a light-use online source. To use OSM data offline, render or obtain your own MBTiles file and copy it into the store.

To rebuild the built-in basemap from Natural Earth data, see [DEVELOPMENT.md](DEVELOPMENT.md#rebuilding-the-built-in-basemap).

## Terrain (Category A HAAT)

A Category A CBSD installed outdoors may not have its antenna more than 6 m above average terrain (HAAT, FCC 96.43(b)). The SAS computes HAAT the way the WInnForum reference model does: 8 radials, 50 points each from 3 to 16 km. It reads 1-arc-second elevation tiles from `/data/terrain` (`SAS_TERRAIN_DIR`) and rejects a violation with 103 (INVALID_VALUE). Where no tile covers a location, the check is skipped and the registration logs a warning. Only Category A outdoor registrations use terrain.

Fetch tiles from USGS (3DEP, public domain; 40–70 MB per 1°×1° tile):

```bash
# Docker
docker exec sasbench node server/src/tools/fetch-terrain.ts --around 39.74,-104.99
docker exec sasbench node server/src/tools/fetch-terrain.ts --harness

# Local
npm run terrain -- n39w078 n39w077
```

- `--around LAT,LON` fetches every tile a HAAT check at that point reads.
- `--harness` fetches the 25 tiles (1.2 GB) for the CBSD locations in the WInnForum harness's CBSD-facing suites.
- Tiles can also be named directly after their north-west corner, such as `n39w078`.

The running SAS picks new tiles up within 30 seconds. It reads two formats, and recognises a tile by the `n39w078` part of its file name:

- USGS GeoTIFF (`USGS_1_n39w078.tif`), the format USGS publishes;
- NED GridFloat (`.flt` + `.hdr`), as in the WInnForum Common-Data repository the reference models use.

## Running the WInnForum test harness

The harness is at <https://github.com/Wireless-Innovation-Forum/Spectrum-Access-System>.

1. Apply the **WInnForum strict** profile (Settings), or start with `SAS_PROFILE=winnforum`.
2. Import the harness CA certificates on the **Certificates** page so its client certificates are trusted. Also import their CRLs if you run the security tests. Install the SAS root CA (`GET /api/v1/trust-bundle?which=roots`) as the harness's trusted CA.
3. Download a matching `sas.cfg` from `GET /api/v1/harness/sas.cfg?host=<name-in-the-server-cert>`. Every base URL points at the HTTPS port, where the admin API (`/admin/reset`, `/admin/injectdata/...`, `/admin/trigger/...`, `/admin/get_daily_activities_status`, ...) is also served.
4. **Terrain for the HAAT check (REG.7).** Fetch the harness tiles with `node server/src/tools/fetch-terrain.ts --harness` (see [Terrain](#terrain-category-a-haat)). Without them the HAAT check is skipped, and REG.7, which expects a HAAT rejection, fails.

## Automating with the REST API

Everything on these pages can also be done through the REST API at `/api/v1`, on the console port. That includes:

- sending protocol requests as a radio would (internally, or through the real HTTP and HTTPS listeners with a lab client certificate);
- suspending grants and injecting faults;
- issuing certificates;
- making harness admin calls;
- changing settings;
- following the wire log live.

Test rigs use the API to set up the SAS before a radio test and to check what happened afterwards.

```bash
curl -s http://<host>:8080/api/v1/status | jq
curl -sN "http://<host>:8080/api/v1/stream?types=message"     # live exchanges
```

While no UI password is set, the API is open like the console. With a password, use HTTP Basic or create API tokens with `read` or `write` scope (`POST /api/v1/tokens`). See the [API guide](API.md) for authentication, conventions and recipes, and the [API reference](API-REFERENCE.md) for every endpoint.

## Data and persistence

All state lives in `$SAS_DATA_DIR` (the `/data` volume in Docker):

- `sas.db`, a SQLite database: settings, CBSDs, grants, PKI (certificates and private keys), registries, protections, logs;
- `tmp/`, scratch space for OpenSSL;
- `terrain/`, optional elevation tiles;
- `tiles/`, the offline map tile store.

Back up the volume to keep your PKI. Deleting it regenerates a fresh one, and radios then need new certificates. Resetting the SAS (from the UI, or the harness's `POST /admin/reset`) clears CBSDs, grants, registries, protections/DPAs/PPAs and injected incumbent data, but keeps certificates, settings and logs.

Backing up and restoring the volume is described in [INSTALL.md](INSTALL.md#backup-and-restore).

## Limitations

- No propagation or aggregate-interference model (no IAP or move lists). DPAs, PPAs and protections are enforced geometrically (inside the polygon or neighbourhood distance) and per frequency.
- PPA contours created by `trigger/create_ppa` are simplified (fixed-radius circles around the cluster), not the WInnForum PPA contour model.
- Single node: SAS–SAS exchange is limited to pulling peer full-activity dumps during daily activities.
- Spectrum inquiry ignores DPAs by default, as the harness expects; this can be changed in Settings.
- A client certificate that fails verification (untrusted CA, expired) ends the TLS connection without a TLS alert. Node.js verifies the client chain after the handshake and then closes the socket, so the radio sees the connection drop instead of an `unknown_ca` or `certificate_expired` alert. The connection is still refused, and the WInnForum security tests accept this.
- Without terrain tiles the Category A HAAT check is skipped. The server says so at startup and logs a warning for each registration it could not check. See [Terrain](#terrain-category-a-haat) for fetching them.
