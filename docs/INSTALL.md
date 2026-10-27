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

  All of them can be moved, and the public REST API can also get a port of its own; see [Configuration](#configuration).

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

Open `http://<host-ip>:8080` and sign in as **`admin`** with password **`admin`**. Change that password straight away: account menu (top right) → **Your account**. The **Overview** page lists the exact URLs to put in a radio.

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

The console and the REST API on `8080` always ask for a user account or an API key, but it is still wise to allow `8080` only from your own subnet. If you set `SAS_API_PORT`, open that port too, and if you [change the ports](#configuration), open those instead. Ports `8000` and `8443` carry the SAS protocol itself and need no sign-in: radios are identified by their certificates (WINNF-TS-0065).

## Configuration

Settings that belong to the host (the name radios use, the bind address, ports, the starting profile and the first admin password) are environment variables. With Docker Compose they go in a **`.env` file** next to `docker-compose.yml`:

```bash
cp .env.example .env
nano .env              # uncomment and set what you need
docker compose up -d   # recreates the container with the new values
```

`.env.example` describes every variable. Run `docker compose up -d` after each change: it notices the new values and recreates the container (`docker compose restart` does not re-read `.env`). A variable left empty (`NAME=`) counts as not set. A typical lab `.env`:

```bash
SAS_FQDN=sas.lab.example.com
SAS_BIND_IP=192.168.10.5
SAS_PROFILE=lab
SAS_ADMIN_PASSWORD=a-long-passphrase
```

Everything else (TLS policy, registration policy, grant timing, map source and more) is changed live on the **Settings** page and stored in the database. User accounts and API keys are managed in the console; see [Users and API keys](#users-and-api-keys).

**Addressing**

| Variable | Default | Meaning |
|----------|---------|---------|
| `SAS_FQDN` | — | The FQDN or IP address radios use to reach the SAS. It becomes the common name and first subject alternative name of the auto-generated server certificates (they are reissued on the next start if it is missing), and the **Overview** shows the SAS endpoints with this name. |
| `SAS_BIND_IP` | `0.0.0.0` (all) | The address every listener binds: web console, REST API, SAS HTTP and SAS HTTPS. Must be an address of this machine. The **Overview** shows it next to `SAS_FQDN`; when it is not set, the Overview shows the host's main address. |
| `SAS_HOSTNAMES` | — | More comma-separated names or addresses for the server certificates, such as a NAT address or a DNS alias. The host's own addresses are always included. Checked on every start. |

**Ports**

| Variable | Default | Meaning |
|----------|---------|---------|
| `UI_PORT` | `8080` | Web console and REST API (the public REST API is served here under `/api/v1`). |
| `SAS_API_PORT` | — | An extra port that serves only the public REST API (`/api/v1`), so it can be firewalled or proxied apart from the console. The API stays on `UI_PORT` as well. |
| `SAS_HTTP_PORT` | `8000` | The port radios use for the SAS protocol over plain HTTP. While it is set, it replaces the port in **Settings → Listeners & TLS**, which can then not be changed there. Remove it and the port set in Settings applies again. |
| `SAS_HTTPS_PORT` | `8443` | The port radios use for the SAS protocol over HTTPS (mutual TLS), on the same terms as `SAS_HTTP_PORT`. |

The SAS ports can be any free port, including `443` and `80` for radios that expect a SAS URL without a port (`https://sas.lab.example/v1.2/`): the Docker image may bind ports below 1024. Every listener needs a port of its own; SASBench does not start when two of these variables name the same port, and says which. `docker logs sasbench` shows the port each SAS listener is on. The **Overview**, the radio bundles and the harness `sas.cfg` use the ports in effect.

**Profile and sign-in**

| Variable | Default | Meaning |
|----------|---------|---------|
| `SAS_PROFILE` | — | Settings profile to start with: `lab`, `winnforum` or `open`. Applied on the first start and again whenever the value changes; changes made in Settings afterwards are kept across restarts. |
| `SAS_PROFILE_APPLY` | — | `always` re-applies `SAS_PROFILE` on every start, undoing Settings changes to the profile's settings at each restart. |
| `SAS_ADMIN_PASSWORD` | `admin` | Password of the `admin` account created on the first start. Read only then; later password changes happen in the console or with the [reset tool](#forgotten-passwords). |
| `SAS_AUTH` | — | `off` switches sign-in off: anyone who can reach the console or the API has full admin access. Only for isolated benches. |

**Data and other settings**

| Variable | Default | Meaning |
|----------|---------|---------|
| `SAS_TERRAIN_DIR` | `/data/terrain` | Elevation tiles for the Category A HAAT check. |
| `SAS_TILES_DIR` | `/data/tiles` | Offline map tile store. |
| `SAS_DATA_DIR` | `/data` | Database, PKI working files and the default terrain and tile folders. |
| `SAS_WEB_DIR` | `web/dist` | Location of the built web console. |
| `SAS_API_CORS_ORIGINS` | — | Comma-separated browser origins allowed to call the REST API from another site (`*` for any). Scripts and tools need nothing. See [Browsers and CORS](API.md#browsers-and-cors). |
| `SAS_TERRAIN_SOURCE_URL` | USGS | A mirror of the USGS 3DEP staged products, with the same layout, for terrain downloads. |
| `TZ` | `UTC` | Time zone for log timestamps (set in `docker-compose.yml`). |

### Users and API keys

The console and the REST API need a user account or an API key. The first start creates one account, **`admin`**, with the password `admin` (or `SAS_ADMIN_PASSWORD`). Until it is changed, a banner across the console says so.

- **Change your password** under account menu (top right) → **Your account**.
- **Add people** on the **Users** page (admins only). Each account has a role: *Admin* (everything, including users), *Operator* (runs the SAS, no user management) or *Viewer* (read-only).
- **Give scripts and other applications an API key** on the **API keys** page. A key is shown once, acts as the user who owns it and can be read-only. Send it as `Authorization: Bearer sasb_…`. The [API guide](API.md#authentication) has the details.

The SAS protocol ports (`8000`, `8443`) are not behind sign-in: radios identify themselves with certificates, as the specifications require. The WInnForum harness admin API on those ports (`/admin/…`) is not either; turn it off in **Settings → Test harness** outside harness runs.

#### Forgotten passwords

An admin can set a new password for anyone on the **Users** page. If nobody can sign in, set one from the host:

```bash
docker exec sasbench node server/src/tools/reset-password.ts admin             # prints a new random password
docker exec sasbench node server/src/tools/reset-password.ts admin 'new pass'  # or choose one
```

The account is enabled again if it was disabled, and its sessions end. It works while SASBench runs. Without Docker, run the same command from the source folder.

### Addresses and certificates

On first start SASBench creates a lab PKI and two SAS server certificates (RSA and ECDSA). Their subject alternative names hold `localhost`, `127.0.0.1`, the hostname and every IPv4 address of the host, so radios can reach the SAS by bare IP as well as by name.

Set the name or address radios use as `SAS_FQDN`: it becomes the certificates' common name and their first subject alternative name. Add anything else (a DNS alias, a NAT address) to `SAS_HOSTNAMES`. The list is checked on every start. If a name or address is missing, for example because the host got a new IP, the server certificates are reissued from the same SAS CA. Radios trust the CA, not the server certificate, so they need nothing new.

## Other ways to run it

### docker run

```bash
docker build -t sasbench .
docker run -d --name sasbench --restart unless-stopped --network host \
  -v sasbench-data:/data \
  sasbench
```

Pass settings with `--env-file .env`, or one by one with `-e`, for example `-e SAS_FQDN=sas.lab.local -e SAS_ADMIN_PASSWORD=change-me`.

### Docker Desktop (macOS and Windows)

Docker Desktop has no host networking, so publish the ports instead. In `docker-compose.yml`, remove `network_mode: host` and uncomment the `ports:` block. The mappings follow `UI_PORT`, `SAS_HTTP_PORT` and `SAS_HTTPS_PORT` from `.env`, so set ports there rather than in Settings, which the mappings cannot follow. In `.env`, set `SAS_FQDN` to the host's LAN IP or name. The container cannot see the host's addresses, so without it the server certificate would not cover the address the radios use. Leave `SAS_BIND_IP` unset: inside the container the listeners must bind every address.

```yaml
    # network_mode: host
    ports:
      - "${UI_PORT:-8080}:${UI_PORT:-8080}"
      - "${SAS_HTTP_PORT:-8000}:${SAS_HTTP_PORT:-8000}"
      - "${SAS_HTTPS_PORT:-8443}:${SAS_HTTPS_PORT:-8443}"
```

```bash
# .env
SAS_FQDN=192.168.1.50
```

The same applies to `docker run` with `-p` mappings instead of `--network host`.

### From source

Needs Node.js 24 or later and the `openssl` command-line tool.

```bash
npm install
npm --prefix web install
npm run build:web      # builds the web console into web/dist
npm start              # http://localhost:8080, sign in as admin / admin
```

Set the same variables in the environment (`export SAS_FQDN=…`) before `npm start`. Data goes to `./data` unless `SAS_DATA_DIR` says otherwise. See [DEVELOPMENT.md](DEVELOPMENT.md) for the development workflow.

## First steps

1. **Sign in** at `http://<host-ip>:8080` as `admin` / `admin`, and change the password under account menu → **Your account**. Add accounts for colleagues on the **Users** page.
2. **Check the URLs** on the **Overview** page. They use `SAS_FQDN` and the address SASBench listens on.
3. **Pick a profile** on the **Settings** page. `Lab` (the default) suits real radios; `WInnForum test harness` matches the official harness; `Open` turns off certificate and identity checks for simulators and quick bring-up.
4. **Make credentials for the radio** on the **Certificates** page: issue a CBSD certificate for its FCC ID and serial number and download the radio bundle. The page also has step-by-step instructions for Nokia AirScale BBUs.
5. **Point the radio** at `https://<host>:8443/v1.2/` (or `http://<host>:8000/v1.2/` for first bring-up without TLS).
6. **Watch it register**, take a grant and heartbeat on the **Overview** and **CBSDs** pages. Every exchange is in the **Wire log** with its full JSON. Once it has registered, **Registry → Registered radios** copies its FCC ID, user ID and registration data into the registry in one click, so it keeps registering when you enforce the registry (see [Registry](GUIDE.md#registry)).

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

**Upgrading from a version without user accounts.** The first start after the upgrade creates the `admin` account. Its password is `SAS_ADMIN_PASSWORD` if set, otherwise the old UI password (`SAS_UI_PASSWORD`, or the one set in Settings), otherwise `admin`. `SAS_UI_PASSWORD` is not read after that, so remove it. API tokens made before the upgrade keep working. Scripts that sent the old UI password with any user name must now use the user name `admin`, or better, an API key.

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

**The sign-in page will not accept the password.** On a new install it is `admin` / `admin`, or `SAS_ADMIN_PASSWORD` if that was set on the first start; changing `SAS_ADMIN_PASSWORD` later has no effect. After 10 failed attempts from one address, sign-in from it pauses for a few minutes. Use the [reset tool](#forgotten-passwords) if nobody knows the password.

**The console does not open.** Check `docker compose ps` and `docker logs sasbench`. If a port is already taken, the log names it. Find the other process with `sudo ss -ltnp | grep -E ':(8080|8000|8443) '`, or move SASBench with `UI_PORT`, `SAS_HTTP_PORT` and `SAS_HTTPS_PORT`.

**`docker logs` says a SAS listener is not listening.** The line gives the reason. *Port … is already in use by another program*: choose another port, or stop that program. *No permission for port …*: ports below 1024 need the `CAP_NET_BIND_SERVICE` capability. The Docker image has it; on a source install, run `sudo setcap cap_net_bind_service=+ep "$(command -v node)"` or use a port above 1023. The **Overview** and **Events** pages show the same.

**The container stops at once with `exec node failed: Operation not permitted`.** The container runs without the `NET_BIND_SERVICE` capability, for example with `cap_drop: [ALL]`. Add it back with `cap_add: [NET_BIND_SERVICE]`.

**The radio cannot connect over HTTPS.**
- The radio must trust the SAS root CA. Install `sas-root-ca.pem` from the radio bundle, or the CAs shown on the **Certificates** page.
- The name or IP in the radio's SAS URL must be in the server certificate. Add it to `SAS_HOSTNAMES` and restart.
- Failed TLS handshakes also appear in the **Wire log**.
- Try `http://<host>:8000/v1.2/` first to separate network problems from TLS problems.

**The radio registers but stays pending.** Many Category B radios send no installation data. In the `Lab` profile they wait at `REG_PENDING` until their location is preloaded on the **Registry** page, or until you switch **Settings → Registration policy → Radio sends no location** to *Register anyway*. See [Radios that send no location](GUIDE.md#radios-that-send-no-location).

**"No terrain tiles" at startup.** This is information, not an error: the Category A outdoor HAAT check is skipped until tiles are added.

**The container stops at startup with "SAS_BIND_IP … is not an address of this machine".** `SAS_BIND_IP` must be one of the host's own addresses (`ip -br addr`), or unset. With port mappings instead of host networking, leave it unset.

**Docker Desktop: radios cannot reach the SAS.** Host networking is not available there; use [port mappings](#docker-desktop-macos-and-windows) and set `SAS_FQDN`.
