# Development

## Setup

Needs Node.js 24 or later and the `openssl` command-line tool.

```bash
npm install
npm --prefix web install
npm run build:web      # builds the web console into web/dist
npm start              # http://localhost:8080, data in ./data
```

- `npm run dev` restarts the server when its files change.
- For work on the web console, also run `npm --prefix web run dev`. Vite serves the console on `:5173` and proxies `/api` to `:8080`.

The server is TypeScript run directly by Node 24's type stripping, so it needs no build step. It uses the built-in `node:sqlite`, and its only runtime dependency is `fflate`.

## Project layout

```
server/src/
  index.ts          entry point: listeners, PKI bootstrap, web console
  api.ts            REST API used by the console (/api/...)
  sas/              protocol engine: registration, grants, heartbeats, policy,
                    CPI checks, fault injection, terrain (HAAT), harness admin API
  net/              SAS HTTP/HTTPS listeners (WINNF-TS-0065 TLS profile)
  pki/              lab PKI and X.509 helpers
  map/              offline map tile store and area downloads
  tools/            command-line tools (fetch-terrain.ts)
server/data/ntia/   NTIA E-DPA and P-DPA definitions (KML)
server/test/        integration tests
web/src/            React console: pages/, components/, lib/
scripts/            third-party notices generator, basemap builder
docs/               installation, user guide, screenshots
```

The console's visual design is documented in [DESIGN.md](../DESIGN.md).

## Checks

```bash
npm run typecheck        # server
npm --prefix web run typecheck
npm test                 # integration tests (about a minute)
npm run notices:check    # third-party notices are up to date
```

The tests start the real server on free ports and exercise the SAS–CBSD protocol over HTTP and HTTPS (including mutual TLS and revocation), the harness admin API, terrain reading and the map tile store.

The same checks, plus a Docker image build, run on every push to `main` and every pull request: see [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## Third-party notices

`THIRD_PARTY_NOTICES.md` lists every third-party component that ships with SASBench, with its license text:

- the npm packages of the server and the web console bundle;
- the runtime in the container image (Node.js, OpenSSL, tini, Alpine packages);
- the map and incumbent data (Natural Earth, NTIA DPAs, USGS).

The console serves the same file at `/third-party-notices.txt`, linked from Settings → Maintenance. The Docker image also has it at `/app/THIRD_PARTY_NOTICES.md`, with the Node.js license and the installed Alpine packages in `/app/licenses/`.

The file is generated from the installed packages. Regenerate it after changing dependencies:

```bash
npm run notices         # rewrite THIRD_PARTY_NOTICES.md and web/public/third-party-notices.txt
npm run notices:check   # fail if they are out of date
```

## Rebuilding the built-in basemap

`npm run basemap` rebuilds the built-in basemap (`web/public/basemap/north-america.json`) from Natural Earth with `scripts/build-basemap.sh`. It needs Node.js, `curl` and internet access, and downloads about 130 MB. The generated file is committed, so this is only needed to change the basemap.
