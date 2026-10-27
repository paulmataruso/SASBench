# Installing SASBench

SASBench runs as one Docker container that holds the SAS, its web console and a SQLite database. This guide covers installing it on a lab machine, configuring it, keeping it up to date and removing it.

- [Requirements](#requirements)
- [Install with Docker Compose (recommended)](#install-with-docker-compose-recommended)
- [Open the firewall](#open-the-firewall)
- [Configuration](#configuration)
- [Other ways to run it](#other-ways-to-run-it)
- [First steps](#first-steps)
- [Optional data: terrain and map tiles](#optional-data-terrain-and-map-tiles)
- [Upgrading](#upgrading)
- [Backup and restore](#backup-and-restore)
- [Uninstalling](#uninstalling)
- [Troubleshooting](#troubleshooting)

## Requirements

- **A Linux host** on the same network as the radios: a laptop or small server beside the bench is enough. A fixed IP address is easiest; see [Addresses and certificates](#addresses-and-certificates).
- **Docker Engine with the Compose plugin** (`docker compose`). Docker Desktop on macOS or Windows also works, with [port mappings](#docker-desktop-macos-and-windows) instead of host networking.
- **Ports** the radios and browsers can reach:

  | Port | Used by | Purpose |
  |------|---------|---------|
  | `8080` | Browsers | Web console and its REST API |
  | `8000` | Radios | SAS–CBSD protocol over plain HTTP |
  | `8443` | Radios | SAS–CBSD protocol over HTTPS (WINNF-TS-0065) |

- **Disk:** the image and database need little space. Terrain tiles are 40–70 MB each if you add them (the full WInnForum harness set is about 1.2 GB), and offline map downloads are typically 20–100 MB.
- **Internet access** only for the first build (base image and npm packages) and, if you want them, for terrain and map downloads. SASBench itself runs offline.

## Install with Docker Compose (recommended)

```bash
git clone https://github.com/paulmataruso/SASBench.git
cd SASBench
docker compose up -d --build
```

The first build takes a few minutes. When it finishes:

```bash
docker compose ps          # STATUS shows "healthy" after about a minute
docker logs sasbench       # startup log: listeners, certificates, the web console URL
```

Open `http://<host-ip>:8080`. The **Overview** page lists the exact URLs to put in a radio.

The compose file uses **host networking**: the listeners bind directly to the host's ports 8080, 8000 and 8443, the SAS sees each radio's real source address, and the host's own IP addresses go into the server certificate automatically.

## Open the firewall

If the host runs a firewall, allow the three ports.

```bash
# Ubuntu / Debian (ufw)
sudo ufw allow 8080,8000,8443/tcp

# RHEL / Fedora / Rocky (firewalld)
sudo firewall-cmd --permanent --add-port={8080,8000,8443}/tcp
sudo firewall-cmd --reload
```

To keep the console and REST API private, allow `8080` only from your own subnet and set a [UI password](#configuration).

## Configuration

Settings that belong to the host live in the `environment:` block of `docker-compose.yml`. Uncomment what you need, then run `docker compose up -d` again. Everything else (TLS policy, profiles, grant timing, map source and more) is changed live on the **Settings** page and stored in the database.

```yaml
    environment:
      SAS_HOSTNAMES: "sas.lab.local"   # extra names/IPs radios use to reach the SAS
      SAS_PROFILE: "lab"               # lab | winnforum | open, applied on first start
      SAS_UI_PASSWORD: "change-me"     # HTTP Basic auth on the console and REST API (any user name)
      TZ: "UTC"
```

| Variable | Default | Meaning |
|----------|---------|---------|
| `SAS_HOSTNAMES` | — | Extra comma-separated names or IPs for the auto-generated server certificates, also shown as SAS URLs. The host's own IPs are always included. Checked on every start. |
| `SAS_PROFILE` | — | `lab`, `winnforum` or `open`. Applied once, on the first start with an empty data volume. |
| `SAS_UI_PASSWORD` | — | Protects the web console and the REST API with HTTP Basic auth (any user name, this password). Applied on every start. API tokens work alongside it; see the [API guide](API.md#authentication). |
| `UI_PORT` | `8080` | Web console and REST API port. |
| `SAS_HTTP_PORT` | `8000` | SAS HTTP port. Overrides the port set in Settings on every start. |
| `SAS_HTTPS_PORT` | `8443` | SAS HTTPS port. Overrides the port set in Settings on every start. |
| `SAS_TERRAIN_DIR` | `/data/terrain` | Elevation tiles for the Category A HAAT check. |
| `SAS_TILES_DIR` | `/data/tiles` | Offline map tile store. |
| `SAS_DATA_DIR` | `/data` | Database, PKI working files and the default terrain and tile folders. |
| `SAS_WEB_DIR` | `web/dist` | Location of the built web console. |
| `SAS_API_CORS_ORIGINS` | — | Comma-separated browser origins allowed to call the REST API from another site (`*` for any). Scripts and tools need nothing. See [Browsers and CORS](API.md#browsers-and-cors). |
| `SAS_TERRAIN_SOURCE_URL` | USGS | A mirror of the USGS 3DEP staged products, with the same layout, for terrain downloads. |
| `TZ` | `UTC` | Time zone for log timestamps. |

### Addresses and certificates

On first start SASBench creates a lab PKI and two SAS server certificates (RSA and ECDSA). Their subject alternative names hold `localhost`, `127.0.0.1`, the hostname and every IPv4 address of the host, so radios can reach the SAS by bare IP as well as by name.

Add anything else the radios use (a DNS name, a NAT address) to `SAS_HOSTNAMES`. The list is checked on every start. If a name or address is missing, for example because the host got a new IP, the server certificates are reissued from the same SAS CA. Radios trust the CA, not the server certificate, so they need nothing new.

## Other ways to run it

### docker run

```bash
docker build -t sasbench .
docker run -d --name sasbench --restart unless-stopped --network host \
  -v sasbench-data:/data \
  sasbench
```

Pass settings with `-e`, for example `-e SAS_HOSTNAMES=sas.lab.local -e SAS_UI_PASSWORD=change-me`.

### Docker Desktop (macOS and Windows)

Docker Desktop has no host networking, so publish the ports instead. In `docker-compose.yml`, remove `network_mode: host`, uncomment the `ports:` block, and set `SAS_HOSTNAMES` to the host's LAN IP. The container cannot see the host's addresses, so without it the server certificate would not cover the IP the radios use.

```yaml
    # network_mode: host
    ports:
      - "8080:8080"
      - "8000:8000"
      - "8443:8443"
    environment:
      SAS_HOSTNAMES: "192.168.1.50"
```

The same applies to `docker run` with `-p` mappings instead of `--network host`.

### From source

Needs Node.js 24 or later and the `openssl` command-line tool.

```bash
npm install
npm --prefix web install
npm run build:web      # builds the web console into web/dist
npm start              # http://localhost:8080
```

Data goes to `./data` unless `SAS_DATA_DIR` says otherwise. See [DEVELOPMENT.md](DEVELOPMENT.md) for the development workflow.

## First steps

1. **Open the console** at `http://<host-ip>:8080` and check the URLs on the **Overview** page.
2. **Pick a profile** on the **Settings** page. `Lab` (the default) suits real radios; `WInnForum test harness` matches the official harness; `Open` turns off certificate and identity checks for simulators and quick bring-up.
3. **Make credentials for the radio** on the **Certificates** page: issue a CBSD certificate for its FCC ID and serial number and download the radio bundle. The page also has step-by-step instructions for Nokia AirScale BBUs.
4. **Point the radio** at `https://<host>:8443/v1.2/` (or `http://<host>:8000/v1.2/` for first bring-up without TLS).
5. **Watch it register**, take a grant and heartbeat on the **Overview** and **CBSDs** pages. Every exchange is in the **Wire log** with its full JSON.

The [User guide](GUIDE.md) covers each of these in detail.

## Optional data: terrain and map tiles

**Terrain.** A Category A CBSD installed outdoors may not have its antenna more than 6 m above average terrain. SASBench checks this when elevation tiles are present, and skips the check (with a warning) when they are not. Fetch the USGS tiles around your site:

```bash
docker exec sasbench node server/src/tools/fetch-terrain.ts --around 39.74,-104.99
```

**Map tiles.** The Spectrum page map always has a built-in offline basemap of North America. For street-level detail, download an area on **Settings → Map**, or copy an MBTiles file into the tile store:

```bash
docker cp lab.mbtiles sasbench:/data/tiles/
```

Both are described in the [User guide](GUIDE.md#map).

## Upgrading

```bash
cd SASBench
git pull
docker compose up -d --build
```

The database, PKI and downloaded tiles live in the data volume and are kept. Radios reconnect on their next request.

## Backup and restore

Everything SASBench knows is in the data volume: settings, CBSDs, grants, logs and, most importantly, the **PKI**. Back it up before you hand certificates to radios you care about. If the volume is lost, a new PKI is generated and every radio needs new certificates.

Docker Compose names the volume after the folder you cloned into, for example `sasbench_sas-data`. To find it:

```bash
docker volume ls | grep sas-data
```

Back up (stop the container first so the database is consistent):

```bash
docker compose stop
docker run --rm -v sasbench_sas-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/sasbench-data.tgz -C /data .
docker compose start
```

Restore into an empty volume:

```bash
docker compose stop
docker run --rm -v sasbench_sas-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/sasbench-data.tgz -C /data'
docker compose start
```

While SASBench runs, `GET /api/v1/system/backup` returns a consistent copy of the whole database without stopping it (see the [API guide](API.md#configuration-backups-and-raw-data)).

To copy just the configuration (settings, registries, protections, PPAs and fault rules, but not certificates, CBSDs or logs) to another install, use **Settings → Maintenance → Export JSON** and **Import JSON**, or `GET /api/v1/config/export` and `POST /api/v1/config/import`.

## Uninstalling

```bash
docker compose down        # removes the container; keeps the data volume
docker compose down -v     # also deletes the data volume, including the PKI
```

Then delete the cloned folder and, if you like, the image: `docker image rm sasbench:latest`.

## Troubleshooting

**The console does not open.** Check `docker compose ps` and `docker logs sasbench`. If a port is already taken, the log names it. Find the other process with `sudo ss -ltnp | grep -E ':(8080|8000|8443) '`, or move SASBench with `UI_PORT`, `SAS_HTTP_PORT` and `SAS_HTTPS_PORT`.

**The radio cannot connect over HTTPS.**
- The radio must trust the SAS root CA. Install `sas-root-ca.pem` from the radio bundle, or the CAs shown on the **Certificates** page.
- The name or IP in the radio's SAS URL must be in the server certificate. Add it to `SAS_HOSTNAMES` and restart.
- Failed TLS handshakes also appear in the **Wire log**.
- Try `http://<host>:8000/v1.2/` first to separate network problems from TLS problems.

**The radio registers but stays pending.** Many Category B radios send no installation data. In the `Lab` profile they wait at `REG_PENDING` until their location is preloaded on the **Registry** page, or until you switch **Settings → Registration policy → Radio sends no location** to *Register anyway*. See [Radios that send no location](GUIDE.md#radios-that-send-no-location).

**"No terrain tiles" at startup.** This is information, not an error: the Category A outdoor HAAT check is skipped until tiles are added.

**Docker Desktop: radios cannot reach the SAS.** Host networking is not available there; use [port mappings](#docker-desktop-macos-and-windows) and set `SAS_HOSTNAMES`.
