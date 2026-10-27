# SASBench REST API guide

The SASBench API gives you everything the web console can do, and more, over HTTP. You can drive CBSDs and grants, send protocol requests, inject faults, manage the PKI and TLS, call the WInnForum harness admin API, change every setting, and read every log and table. Test rigs, CI pipelines and scripts get the same control an engineer has at the console.

This guide covers authentication, the conventions every endpoint follows, and worked examples for each area. Two companion documents go with it:

- [API-REFERENCE.md](API-REFERENCE.md) lists every endpoint, parameter, status code and schema. It is generated from the code.
- [API-ARCHITECTURE.md](API-ARCHITECTURE.md) explains how the API is built, its security model and how to extend it.

The running SAS also describes itself. `GET /api/v1/openapi.json` returns an OpenAPI 3.1 document that you can load into Swagger UI, Postman, Insomnia, or a client generator.

- [Quick start](#quick-start)
- [Authentication](#authentication)
- [Conventions](#conventions)
- [Recipes](#recipes)
  - [Drive a CBSD through the protocol](#drive-a-cbsd-through-the-protocol)
  - [CBSDs and grants: inspect and act](#cbsds-and-grants-inspect-and-act)
  - [Registry](#registry)
  - [Spectrum, protections, DPAs, PPAs and incumbents](#spectrum-protections-dpas-ppas-and-incumbents)
  - [Fault injection](#fault-injection)
  - [Wire log, events and the live stream](#wire-log-events-and-the-live-stream)
  - [Settings](#settings)
  - [Certificates and TLS](#certificates-and-tls)
  - [The WInnForum harness admin API](#the-winnforum-harness-admin-api)
  - [Operations: daily activities, triggers, reset, listeners](#operations-daily-activities-triggers-reset-listeners)
  - [Map tiles and terrain](#map-tiles-and-terrain)
  - [Configuration, backups and raw data](#configuration-backups-and-raw-data)
- [Client examples](#client-examples)
- [Environment variables](#environment-variables)
- [Troubleshooting](#troubleshooting)
- [Versioning](#versioning)

## Quick start

The API is served on the console port, under `/api/v1` (and on its own port too when `SAS_API_PORT` is set). Every endpoint except three public ones needs a user account or an API key. A new installation has one account: user name **`admin`**, password **`admin`**. Sign in to the console with it and change the password first (account menu, top right → **Your account**).

```bash
export API=http://<host>:8080/api/v1

curl -s $API/health                                   # public: no credentials
# {"status":"ok","version":"1.0.0","uptimeMs":151,"listeners":{"http":true,"https":true}}

curl -s -u admin:'your password' $API/status | jq     # HTTP Basic with a user name and password
```

For scripts, create an API key instead of using your password: in the console under **API keys**, or with the API itself:

```bash
curl -s -u admin:'your password' -X POST $API/tokens -H 'Content-Type: application/json' \
  -d '{"name": "my scripts", "scope": "write", "expiresInDays": 90}' | jq -r .token
# sasb_N4iBU4EJFYl0G-0jCVKK6YfaEHVkq6Vx
```

The examples in this guide leave the credentials out. To send the key with every `curl` in your shell, put it in a curl config file and point `CURL_HOME` at it:

```bash
export KEY=sasb_N4iBU4EJFYl0G-0jCVKK6YfaEHVkq6Vx
mkdir -p ~/.sasbench && printf 'header = "Authorization: Bearer %s"\n' "$KEY" > ~/.sasbench/.curlrc
export CURL_HOME=~/.sasbench        # curl now reads ~/.sasbench/.curlrc

curl -s $API/cbsds | jq '.items[] | {cbsdId, state}'
```

Register a Category A radio, take a grant and heartbeat, all without a radio:

```bash
curl -s -X POST $API/sas/registration -H 'Content-Type: application/json' -d '{
  "registrationRequest": [{
    "userId": "lab-user", "fccId": "TEST-FCC", "cbsdSerialNumber": "SN-0001", "cbsdCategory": "A",
    "airInterface": {"radioTechnology": "E_UTRA"}, "measCapability": [],
    "installationParam": {"latitude": 37.425, "longitude": -122.084, "height": 5, "heightType": "AGL",
                          "indoorDeployment": true, "antennaGain": 5, "eirpCapability": 26}
  }]}' | jq .body
```

`jq` is used throughout this guide to pull values out of responses. Every example also works without it.

## Authentication

### Users and roles

Everyone who uses the console or the API has a user account with one of three roles:

| Role | May do | API scope |
|---|---|---|
| **admin** | Everything, including user accounts, every API key and database backups | `write` + admin operations |
| **operator** | Runs the SAS: settings, CBSDs, grants, certificates, registry, faults, harness calls | `write` |
| **viewer** | Reads everything except private keys, backups, user accounts and other people's API keys | `read` |

The first start creates the account `admin` with the password `admin` and logs a warning; the console shows a banner until the password is changed. To start with another password, set `SAS_ADMIN_PASSWORD` before the first start ([INSTALL.md](INSTALL.md#users-and-api-keys)). Upgrading from a version with a single UI password: that password becomes the `admin` account's password.

There is always at least one enabled admin: the API refuses (409) to delete, disable or demote the last one, and nobody can delete their own account. User names are case-insensitive. Passwords need at least 8 characters and are stored as scrypt hashes.

### Ways in

| Method | How | Acts as |
|---|---|---|
| **Session** | The console's sign-in cookie (`sasb_session`), set by the sign-in form. Browsers only. | The signed-in user |
| **Password** | HTTP Basic: `curl -u user:password` | That user |
| **API key** | `Authorization: Bearer sasb_…` | The key's owner, limited to the key's scope |
| **Open** | Only with `SAS_AUTH=off` ([below](#switching-sign-in-off)) | Admin |

Public endpoints need no credentials: `GET /api/v1/`, `/health` and `/openapi.json`, for container health checks and service discovery.

```bash
# Who am I?
curl -s -H "Authorization: Bearer $KEY" $API/auth/whoami
# {"method":"token","scope":"write","role":"operator","userId":2,"username":"olivia","tokenId":"bd2b…","tokenName":"CI pipeline","authEnabled":true}
```

**Failed sign-ins.** A request without valid credentials gets `401` with `WWW-Authenticate` (Bearer, and Basic for clients that are not web pages). The error code is `unauthorized`, or `account_disabled` for a disabled user. After 10 wrong passwords from one address within 5 minutes, password checks from that address are refused with `429 too_many_attempts` and `Retry-After` until the window passes; this covers the sign-in form, HTTP Basic and password changes. API keys are not throttled.

**Password caching.** Checking a password is deliberately slow (scrypt), so a password that was accepted is remembered for 5 minutes per `Authorization` header. A password change or reset, disabling the user, or a role change takes effect on the next request regardless.

### API keys

Keys are for scripts, CI pipelines, dashboards and other applications. Every key belongs to a user and acts as that user, never with more access than the user has *now*: a `write` key of an operator who is later made a viewer acts as a viewer, and a disabled or deleted user's keys stop working.

```bash
curl -s -u olivia:'her password' -X POST $API/tokens -H 'Content-Type: application/json' \
  -d '{"name": "CI pipeline", "scope": "write", "expiresInDays": 90}'
```

```json
{
  "id": "bd2beeec-9eaa-4de0-8196-6ec6172dde70",
  "name": "CI pipeline",
  "scope": "write",
  "prefix": "sasb_N4iBU4",
  "createdAt": 1793081260358,
  "expiresAt": 1800857260357,
  "lastUsedAt": null,
  "lastUsedAddr": null,
  "userId": 2,
  "username": "olivia",
  "token": "sasb_N4iBU4EJFYl0G-0jCVKK6YfaEHVkq6Vx"
}
```

- **`token` is shown once.** The SAS stores only its SHA-256 hash, so a lost key cannot be recovered. Revoke it and create a new one.
- **Scope.** `read` (the default) or `write`. Viewers can create `read` keys only.
- **Expiry.** `expiresInDays` (1–3650) or an absolute `expiresAt` (epoch milliseconds or RFC 3339). Omit both for a key that does not expire.
- **Owner.** Your own account. Admins can pass `userId` to create a key for another user, for example a service account with the operator role.
- **Identification.** `prefix` (the first characters of the secret), `lastUsedAt` and `lastUsedAddr` tell you which key a client is using. Last use is recorded at most once a minute per key.
- **Management.** `GET /tokens` lists your keys (admins: every key), `GET /tokens/{id}` and `DELETE /tokens/{id}`. A delete revokes the key at once and closes its open live streams. Keys are created and revoked by people (a session or a password), not by other keys.

### Scopes

| | viewer, or a `read` key | operator, or an operator's `write` key | admin, or an admin's `write` key |
|---|---|---|---|
| Every `GET` that reads state: status, CBSDs, grants, logs, settings, certificates (public parts), spectrum, data tables… | yes | yes | yes |
| The live stream `GET /stream` | yes | yes | yes |
| Anything that changes state (`POST`, `PUT`, `PATCH`, `DELETE`) | **403** | yes | yes |
| Certificate downloads that contain a private key (`key`, `all-in-one`, `p12`, `bundle`…) | **403** | yes | yes |
| API keys `/tokens` | own keys (read keys only) | own keys | every key |
| Rows of the `api_tokens` table | **403** | yes | yes |
| Database backup `GET /system/backup` (contains private keys and password hashes) | **403** | **403** | yes |
| Users `/users`, and the rows of the `users` and `sessions` tables | **403** | **403** | yes |
| Your own password `POST /auth/password` | yes | yes | yes |

Each operation's scope (`public`, `read`, `write` or `admin`) is listed in [API-REFERENCE.md](API-REFERENCE.md) and as `x-sasbench-scope` in the OpenAPI document. A `read` key is the right credential for dashboards, monitoring and log collection.

The console's own pages follow the same rules: viewers can look at everything but change nothing, and cannot download private keys.

### Managing users

Admins manage accounts in the console (**Users**) or through the API:

```bash
# Create an operator; the response is the user (never the password)
curl -s -X POST $API/users -H 'Content-Type: application/json' \
  -d '{"username": "olivia", "password": "correct horse battery", "role": "operator", "displayName": "Olivia Ortiz"}'

curl -s $API/users | jq '.items[] | {id, username, role, enabled, lastLoginAt}'

# Change the role, disable, or set a new password (each signs the user out of the console)
curl -s -X PATCH $API/users/2 -H 'Content-Type: application/json' -d '{"role": "viewer"}'
curl -s -X PATCH $API/users/2 -H 'Content-Type: application/json' -d '{"enabled": false}'
curl -s -X PATCH $API/users/2 -H 'Content-Type: application/json' -d '{"password": "a new password"}'

# Console sessions, and signing a user out everywhere (API keys are not affected)
curl -s $API/users/2/sessions | jq
curl -s -X DELETE $API/users/2/sessions

# Delete the account with its sessions and API keys
curl -s -X DELETE $API/users/2
```

Anyone signed in with a password can change their own:

```bash
curl -s -u olivia:'old password' -X POST $API/auth/password -H 'Content-Type: application/json' \
  -d '{"currentPassword": "old password", "newPassword": "a better password"}'
```

Their other console sessions end; the one making the change stays signed in.

### The live stream and browsers

In the console, the session cookie authenticates the live stream. Other browser code using `EventSource` cannot set an `Authorization` header, so `GET /stream` also accepts an API key as a query parameter: `/api/v1/stream?access_token=sasb_…`. No other endpoint accepts `access_token`, because URLs end up in logs and browser history. A stream ends when its key is revoked or expires, or when its user signs out, is disabled or gets a new password.

### Forgotten passwords

An admin can set a new password for anyone under **Users**. If no admin can sign in, run the reset tool on the SAS host. It works while the SAS is running:

```bash
docker exec sasbench node server/src/tools/reset-password.ts admin            # prints a random password
docker exec sasbench node server/src/tools/reset-password.ts admin 'new pass'  # or sets this one
```

The account is enabled and signed out everywhere; its API keys keep working. A user name that does not exist is created as an admin.

### Switching sign-in off

`SAS_AUTH=off` in the environment opens the console and the API to anyone who can reach them, with full admin access, as in versions before user accounts. Use it only on an isolated bench. Presented API keys are still checked (a wrong one gets 401), user accounts still exist, and signing in still works. The console shows "Sign-in off" in the top bar.

## Conventions

### Requests

- **JSON in, JSON out.** Send `Content-Type: application/json`. Bodies are limited to 16 MB.
- **Strict validation.** API bodies, path parameters and query parameters are validated against the published schemas. Unknown body fields and unknown query parameters are refused with `400 validation_failed`, so a typo never silently does nothing.
- **Protocol payloads are not second-guessed.** The bodies of `/sas/{method}`, harness calls, preloaded registrations and incumbent records go to the SAS as they are. Protocol errors come back as protocol response codes (102, 103…), exactly as a radio would see them.
- **Partial updates.** `PATCH` changes only the fields you send. `PUT` replaces the whole resource, or creates it at that id.

### Units and formats

| Quantity | Unit |
|---|---|
| Frequencies | Hz (`3550000000`) |
| EIRP | dBm/MHz |
| Timestamps in responses | epoch milliseconds (`1793081251463`) |
| Time parameters (`since`, `until`, `expiresAt`, `grantExpireTime`) | epoch milliseconds or RFC 3339 (`2026-10-27T06:00:00Z`) |
| Field names | camelCase, except raw rows from `/data/tables/*`, which keep the database's snake_case |

### Status codes

| Status | Meaning |
|---|---|
| `200` | OK, with a body |
| `201` | Created. `Location` gives the new resource's URL. |
| `202` | Accepted: a background job started (tile and terrain downloads, daily activities with `wait=false`). Poll the job resource or watch the stream. |
| `204` | Done, no body (deletes) |
| `400` | Invalid request, or the SAS refused the operation |
| `401` | No valid credentials, or the user is disabled. The response carries `WWW-Authenticate`. |
| `403` | Authenticated but not allowed: a viewer or read key changing something, a non-admin managing users, or a browser origin that is not allowed |
| `404` | The resource does not exist, or no such route |
| `405` | The path exists but not with this method. `Allow` lists the methods. |
| `409` | The resource's state does not allow this (e.g. deleting a CA that still has certificates, starting a second download, a user name that is taken, removing the last admin) |
| `413` | Body over 16 MB |
| `429` | Too many wrong passwords from this address. Wait `Retry-After` seconds. |
| `500` | A bug. The event log has the stack trace. |

### Errors

Every error has the same shape:

```json
{
  "error": {
    "status": 400,
    "code": "validation_failed",
    "message": "method must be one of \"*\", \"registration\", \"spectrumInquiry\", \"grant\", \"heartbeat\", \"relinquishment\", \"deregistration\"",
    "requestId": "d93ae3da-1128-4d56-adf6-bd3b19ec7694",
    "details": [
      { "path": "method", "message": "must be one of \"*\", \"registration\", …" }
    ]
  }
}
```

| `code` | Status | When |
|---|---|---|
| `validation_failed` | 400 | A parameter or body field fails its schema. `details` lists each problem with its JSON path. |
| `invalid_json` | 400 | The body is not JSON |
| `bad_request` | 400 | The request is well-formed but cannot be carried out as given (e.g. `raw=true` with `transport=internal`) |
| `operation_failed` | 400 | The SAS refused the operation (e.g. a PEM that does not parse) |
| `unauthorized` | 401 | Missing, invalid or expired credentials |
| `account_disabled` | 401 | The user, or the owner of the API key, is disabled |
| `forbidden` | 403 | Not allowed for this role or key (see [Scopes](#scopes)) |
| `origin_not_allowed` | 403 | A browser request from a foreign origin tried to change something (see [Browsers and CORS](#browsers-and-cors)) |
| `host_not_allowed` | 403 | A web page reached the SAS by a host name it does not know (see [Browsers and CORS](#browsers-and-cors)) |
| `not_found` | 404 | The resource does not exist |
| `route_not_found` | 404 | No such endpoint. Often an id with an unencoded `/`. |
| `method_not_allowed` | 405 | Wrong method for this path |
| `conflict` | 409 | State conflict |
| `payload_too_large` | 413 | Body over 16 MB |
| `too_many_attempts` | 429 | Too many wrong passwords from this address |
| `internal_error` | 500 | A bug. Please report it with the `requestId`. |

Programs should branch on `status` and `code`. `message` is for people and may change.

### Request and operation ids

Every response carries `X-Request-Id`. Send your own `X-Request-Id` (letters, digits, `.`, `:`, `_`, `-`, up to 128 characters) and it is echoed back, which makes it easy to correlate with your test logs. Responses also carry `X-Operation-Id`, the `operationId` of the endpoint that handled the request, as named in the reference.

### Ids that contain "/"

CBSD ids (`TEST-FCC/b7ee…`), PPA ids (`zone/ppa/ui/…`), incumbent ids and some others contain `/`. In a path, percent-encode it as `%2F`:

```bash
CBSD='TEST-FCC/b7eeb0aceec6f6087a0c75b6f69289c95b3e191c'
ENC=$(jq -rn --arg v "$CBSD" '$v|@uri')        # TEST-FCC%2Fb7eeb0ac…
curl -s $API/cbsds/$ENC
```

Python: `urllib.parse.quote(cbsd_id, safe='')`. JavaScript: `encodeURIComponent(cbsdId)`. An id left unencoded produces `404 route_not_found` with a hint. The one exception is the harness method in `POST /harness/{method}`, which deliberately spans segments (`/harness/injectdata/fcc_id`).

### Lists and paging

Collections return a page:

```json
{ "items": [ … ], "total": 42, "limit": 100, "offset": 0 }
```

Use `limit` and `offset`; each endpoint's default and maximum `limit` are in the reference. Filters are query parameters, listed per endpoint in the reference. List-valued filters are comma-separated (`?level=warn,error`).

The wire log, the event log and a CBSD's own logs can hold hundreds of thousands of rows, so they page by cursor instead:

```json
{ "items": [ … ], "limit": 2, "order": "desc", "next": 5 }
```

- With no cursor, you get the newest entries first. Pass `next` as `before` to get the following (older) page. `next` is null on the last page.
- To poll for new entries, pass the highest id you have seen as `after`. The results are then oldest first, and `next` is the cursor for the next poll. When polling, `next` is never null: if nothing is new, it is the `after` you sent.

```bash
# Walk backwards through all heartbeat exchanges
next=; while :; do
  page=$(curl -s "$API/messages?method=heartbeat&limit=500${next:+&before=$next}")
  echo "$page" | jq -c '.items[]'
  next=$(echo "$page" | jq -r '.next // empty'); [ -z "$next" ] && break
done
```

### HEAD, OPTIONS and 405

Every `GET` endpoint also answers `HEAD` with headers only. `OPTIONS` on any existing API path returns `204` with `Allow`. A wrong method gets `405 method_not_allowed` with `Allow`.

### Long operations

- **Listener changes.** Settings that restart the SAS listeners (ports, TLS, certificates) restart them before the call returns. The response includes the new listener status, so the next request already sees the new configuration.
- **Background jobs** (`POST /map/download`, `POST /terrain/download`, `POST /operations/daily-activities?wait=false`) return `202` with the job state. Poll the matching `GET`, or watch the stream for `changed` events.

### Browsers and CORS

Scripts and tools send no `Origin` header and are unaffected by this section.

Browsers attach `Origin` to cross-site requests, and send the console's cookie or cached credentials with them. Without a check, any web page an engineer happened to open while signed in could script the SAS (cross-site request forgery). The API therefore refuses a request that changes something (any method other than `GET`, `HEAD`, `OPTIONS`) when its `Origin` is neither the SAS's own host nor an allowed origin. The refusal is `403 origin_not_allowed`.

To call the API from a web application on another origin, list that origin in `SAS_API_CORS_ORIGINS`, comma-separated:

```yaml
# docker-compose.yml
environment:
  SAS_API_CORS_ORIGINS: "http://dashboard.lab:3000,https://tools.lab"
```

Allowed origins get the CORS headers (`Access-Control-Allow-Origin`, preflight answers for `Authorization`, `Content-Type` and `X-Request-Id`, and the exposed `X-Request-Id`, `X-Operation-Id`, `Location` and `Content-Disposition` headers). `*` allows every origin. Use `*` only on an isolated lab network. Allowed origins authenticate with an API key (`Authorization` header); the session cookie is never sent cross-site.

**Host names.** A second browser attack, DNS rebinding, makes a page on an attacker's domain re-resolve to the SAS's address. The browser then treats the page as same-origin. To stop it, a request made by a web page must reach the SAS by one of these:

- an IP address (`http://172.16.0.45:8080`);
- `localhost`;
- a name in `SAS_HOSTNAMES` (or the host's own hostname).

A page that uses any other name gets `403 host_not_allowed`, unless its origin is listed in `SAS_API_CORS_ORIGINS`. A request counts as made by a page when it carries an `Origin` header, or a `Sec-Fetch-Site` header other than `none`. Scripts, tools and addresses typed into the browser are not affected, and neither are the public endpoints. If you open the API from a browser through a DNS name, add that name to `SAS_HOSTNAMES`.

## Recipes

These examples assume `API` is set and credentials are sent as in the [quick start](#quick-start) (an API key in `~/.sasbench/.curlrc`, or add `-u user:password` to each command).

### Drive a CBSD through the protocol

`POST /sas/{method}` sends SAS–CBSD protocol requests (WINNF-TS-0016): `registration`, `spectrumInquiry`, `grant`, `heartbeat`, `relinquishment` and `deregistration`. The body is exactly what a radio sends, batches included. The response wraps what the SAS answered:

```json
{
  "transport": "internal",
  "method": "grant",
  "version": "v1.2",
  "httpStatus": 200,
  "durationMs": 2,
  "body": { "grantResponse": [ { "cbsdId": "TEST-FCC/b7ee…", "grantId": "8044165021372334", "grantExpireTime": "2026-11-03T06:07:31Z", "heartbeatInterval": 60, "channelType": "GAA", "response": { "responseCode": 0, "responseMessage": "SUCCESS" } } ] },
  "error": null
}
```

A request the SAS rejects is still HTTP 200 here. The SAS's verdict is in `body`, as `responseCode` 103 and so on. API errors (4xx) are about the API call itself.

**Full life cycle:**

```bash
# 1. Register (Category A, indoor, with location)
CBSD=$(curl -s -X POST $API/sas/registration -H 'Content-Type: application/json' -d '{
  "registrationRequest": [{"userId": "lab-user", "fccId": "TEST-FCC", "cbsdSerialNumber": "SN-0001",
    "cbsdCategory": "A", "airInterface": {"radioTechnology": "E_UTRA"}, "measCapability": [],
    "installationParam": {"latitude": 37.425, "longitude": -122.084, "height": 5, "heightType": "AGL",
      "indoorDeployment": true, "antennaGain": 5, "eirpCapability": 26}}]}' \
  | jq -r '.body.registrationResponse[0].cbsdId')

# 2. What may it use?
curl -s -X POST $API/sas/spectrumInquiry -H 'Content-Type: application/json' \
  -d "{\"spectrumInquiryRequest\": [{\"cbsdId\": \"$CBSD\",
       \"inquiredSpectrum\": [{\"lowFrequency\": 3550000000, \"highFrequency\": 3700000000}]}]}" \
  | jq '.body.spectrumInquiryResponse[0].availableChannel'

# 3. Grant 3550–3560 MHz at 10 dBm/MHz
GRANT=$(curl -s -X POST $API/sas/grant -H 'Content-Type: application/json' \
  -d "{\"grantRequest\": [{\"cbsdId\": \"$CBSD\", \"operationParam\": {\"maxEirp\": 10,
       \"operationFrequencyRange\": {\"lowFrequency\": 3550000000, \"highFrequency\": 3560000000}}}]}" \
  | jq -r '.body.grantResponse[0].grantId')

# 4. Heartbeat (GRANTED → AUTHORIZED)
hb() { curl -s -X POST $API/sas/heartbeat -H 'Content-Type: application/json' \
  -d "{\"heartbeatRequest\": [{\"cbsdId\": \"$CBSD\", \"grantId\": \"$GRANT\", \"operationState\": \"$1\"}]}" \
  | jq -c '.body.heartbeatResponse[0] | {code: .response.responseCode, transmitExpireTime}'; }
hb GRANTED
hb AUTHORIZED

# 5. Relinquish and deregister
curl -s -X POST $API/sas/relinquishment -H 'Content-Type: application/json' \
  -d "{\"relinquishmentRequest\": [{\"cbsdId\": \"$CBSD\", \"grantId\": \"$GRANT\"}]}" | jq -c .body
curl -s -X POST $API/sas/deregistration -H 'Content-Type: application/json' \
  -d "{\"deregistrationRequest\": [{\"cbsdId\": \"$CBSD\"}]}" | jq -c .body
```

**The three transports** are chosen with `?transport=`:

| `transport` | Path | Fault rules | TLS, certificate role and identity checks, revocation | Wire log transport |
|---|---|---|---|---|
| `internal` (default) | Straight into the protocol engine | not applied | not applied | `internal` |
| `http` | Over loopback to the real SAS HTTP listener | applied | n/a | `http` |
| `https` | Over loopback to the real SAS HTTPS listener | applied | applied | `https` |

Use `internal` to set up state quickly. Use `http` or `https` when the test is about what goes over the wire: faults, TLS policy, mutual TLS.

**Mutual TLS as a given device.** Issue a CBSD certificate (see [Certificates and TLS](#certificates-and-tls)). Then present it with `clientCertId`. The SAS then checks it exactly as it checks a radio:

```bash
CERT=$(curl -s "$API/certs?kind=cbsd&q=SN-0001" | jq -r '.items[0].id')
curl -s -X POST "$API/sas/registration?transport=https&clientCertId=$CERT" \
  -H 'Content-Type: application/json' -d @registration.json | jq .body
curl -s "$API/messages?limit=1" | jq '.items[0] | {transport, certSubject, codes}'
# {"transport":"https","certSubject":"CN=TEST-FCC:SN-0001","codes":[0]}
```

**Malformed payloads.** `raw=true` (http or https only) sends `rawBody` byte for byte:

```bash
curl -s -X POST "$API/sas/registration?transport=http&raw=true" -H 'Content-Type: application/json' \
  -d '{"rawBody": "{\"registrationRequest\": [ {"}' | jq '{httpStatus, body}'
```

Other query parameters: `version` (the protocol version in the URL path, default the first supported version), and `timeoutMs` (how long to wait for the listener, default 30 s). If the HTTP or HTTPS listener is off, the call returns `409`. A connection error, reset or TLS handshake failure returns 200 with `httpStatus: null` and `error` set, because that is the result of the test.

### CBSDs and grants: inspect and act

```bash
curl -s "$API/cbsds?state=REGISTERED&category=B" | jq '.items[] | {cbsdId, fccId, serial, lastSeen}'
curl -s "$API/cbsds?q=SN-00" | jq .total          # substring of cbsdId, FCC ID, serial, user ID or notes
ENC=$(jq -rn --arg v "$CBSD" '$v|@uri')
curl -s $API/cbsds/$ENC | jq '{state, liveGrants, limits, availability, protections}'
curl -s $API/cbsds/$ENC/availability | jq      # what it could be granted now, and why not
curl -s "$API/cbsds/$ENC/messages?limit=20" | jq '.items[] | {method, codes, httpStatus}'
curl -s "$API/cbsds/$ENC/events?limit=20" | jq -r '.items[] | "\(.level) \(.message)"'
```

**Operator actions on a CBSD:**

```bash
# Notes, an EIRP cap (grant requests above it get 400 INTERFERENCE), measurement report requests
curl -s -X PATCH $API/cbsds/$ENC -H 'Content-Type: application/json' -d '{
  "notes": "Bench 3, firmware 25R2", "eirpCapDbmMhz": 20,
  "hbMeasConfig": ["RECEIVED_POWER_WITHOUT_GRANT"]}'

# SAS-initiated deregistration: the next request is answered with 105 DEREGISTER
curl -s -X POST $API/cbsds/$ENC/deregister -H 'Content-Type: application/json' -d '{"mode": "next-request"}'
# …or drop it now without telling the radio (later requests get 103)
curl -s -X POST $API/cbsds/$ENC/deregister -H 'Content-Type: application/json' -d '{"mode": "immediate"}'

# Manual approval mode (setting manualApproval): approve, then the radio's next registration succeeds
curl -s -X POST $API/cbsds/$ENC/approve

# Forget it entirely (CBSD, grants)
curl -s -X DELETE $API/cbsds/$ENC -o /dev/null -w '%{http_code}\n'    # 204
```

**Grants:**

```bash
curl -s "$API/grants?state=AUTHORIZED" | jq '.items[] | {grantId, cbsdId, low, high, maxEirp, heartbeatCount}'
G=$(jq -rn --arg v "$GRANT" '$v|@uri')

curl -s -X POST $API/grants/$G/suspend      # next heartbeat → 501 SUSPENDED_GRANT
curl -s -X POST $API/grants/$G/resume
curl -s -X PATCH $API/grants/$G -H 'Content-Type: application/json' -d '{"heartbeatInterval": 30}'
curl -s -X PATCH $API/grants/$G -H 'Content-Type: application/json' \
  -d '{"suggestedOperationParam": {"maxEirp": 5, "operationFrequencyRange": {"lowFrequency": 3570000000, "highFrequency": 3580000000}}}'
curl -s -X PATCH $API/grants/$G -H 'Content-Type: application/json' -d '{"grantExpireTime": "2026-12-01T00:00:00Z"}'
curl -s -X POST $API/grants/$G/terminate -H 'Content-Type: application/json' -d '{"reason": "interference test"}'
curl -s -X DELETE $API/grants/ended | jq .deleted     # purge ended grants
```

A heartbeat interval change is sent in the next successful heartbeat response and applies from then on. A suggested operation parameter is returned in every successful heartbeat while it is set. A termination takes effect immediately: the next heartbeat for the grant gets 500 TERMINATED_GRANT.

### Registry

The databases the SAS checks registrations against:

```bash
# FCC IDs (with the certified maximum EIRP) and user IDs
curl -s -X POST $API/registry/fcc-ids -H 'Content-Type: application/json' -d '{"fccId": "TEST-FCC", "maxEirp": 47}'
curl -s -X POST $API/registry/user-ids -H 'Content-Type: application/json' -d '{"userId": "lab-user"}'
curl -s "$API/registry/fcc-ids?q=TEST" | jq .items

# Blacklist a whole FCC ID or one device
curl -s -X POST $API/registry/blacklist -H 'Content-Type: application/json' \
  -d '{"fccId": "BAD-FCC", "serial": "SN-9", "reason": "recalled"}'

# Preloaded ("conditional") registration data, for Category B radios that send no location:
# one record, an array, or the harness's {"registrationData": [ … ]}
curl -s -X POST $API/registry/conditional -H 'Content-Type: application/json' -d '{
  "fccId": "TEST-FCC", "cbsdSerialNumber": "SN-0002", "cbsdCategory": "B",
  "airInterface": {"radioTechnology": "E_UTRA"},
  "installationParam": {"latitude": 39.74, "longitude": -104.99, "height": 12, "heightType": "AGL",
    "indoorDeployment": false, "antennaGain": 16, "antennaBeamwidth": 65, "antennaAzimuth": 180}}'
curl -s $API/registry/conditional/TEST-FCC/SN-0002 | jq .data

# CPI (professional installer) users: by public key or from an installer certificate in the store
curl -s -X POST $API/registry/cpi-users -H 'Content-Type: application/json' \
  -d "{\"cpiId\": \"cpi-0001\", \"name\": \"Lab installer\", \"certId\": \"$INSTALLER_CERT\"}"

# Everything at once
curl -s $API/registry | jq 'map_values(length)'
```

**CPI-signed installation data.** A Category B radio can carry `cpiSignatureData`. Produce it with an installer certificate from the store:

```bash
curl -s -X POST $API/cpi/sign -H 'Content-Type: application/json' -d "{
  \"installerCertId\": \"$INSTALLER_CERT\", \"fccId\": \"TEST-FCC\", \"cbsdSerialNumber\": \"SN-0002\",
  \"installationParam\": {\"latitude\": 37.4, \"longitude\": -122.1, \"height\": 10, \"heightType\": \"AGL\",
    \"indoorDeployment\": false, \"antennaGain\": 15, \"eirpCapability\": 40}}" | jq .cpiSignatureData
```

### Spectrum, protections, DPAs, PPAs and incumbents

```bash
curl -s $API/spectrum | jq 'keys'     # band plan, protections, PPAs, live grants, CBSD locations, incumbents
```

**Protections** remove spectrum from the CBSDs they cover. Grants they hit are suspended (501) or terminated (500) at their next heartbeat:

```bash
# Band-wide administrative block on 3550–3560 MHz (no geometry: every CBSD)
P=$(curl -s -X POST $API/protections -H 'Content-Type: application/json' -d '{
  "name": "Bench shield test", "kind": "ADMIN", "low": 3550000000, "high": 3560000000,
  "active": true, "action": "suspend"}' | jq -r .id)
PE=$(jq -rn --arg v "$P" '$v|@uri')

# A 10 km circle, terminate grants
curl -s -X POST $API/protections -H 'Content-Type: application/json' -d '{
  "name": "Radar site", "kind": "EXCLUSION", "low": 3550000000, "high": 3650000000,
  "latitude": 37.42, "longitude": -122.08, "radiusKm": 10, "active": true, "action": "terminate"}'

curl -s -X POST $API/protections/$PE/deactivate
curl -s -X POST $API/protections/$PE/activate -H 'Content-Type: application/json' \
  -d '{"channels": [[3550000000, 3555000000]]}'      # only a sub-channel
curl -s -X DELETE $API/protections/$PE
```

`geometry` takes any GeoJSON geometry, Feature or FeatureCollection. `PUT /protections/{id}` creates or replaces at a chosen id.

**DPAs** come from the NTIA KML files:

```bash
curl -s -X POST $API/dpas/load -H 'Content-Type: application/json' -d '{"file": "E-DPAs.kml"}'
curl -s "$API/dpas?limit=5" | jq '.items[] | {id, name, active}'
curl -s -X POST $API/dpas/East1/channels/activate -H 'Content-Type: application/json' \
  -d '{"lowFrequency": 3550000000, "highFrequency": 3560000000}'
curl -s -X POST $API/dpas/deactivate-all
curl -s -X DELETE $API/dpas | jq .deleted
```

**PPAs** (PAL Protection Areas):

```bash
# Operator-defined
curl -s -X POST $API/ppas -H 'Content-Type: application/json' -d "{
  \"name\": \"Lab PPA\", \"members\": [\"$CBSD\"],
  \"channels\": [{\"low\": 3600000000, \"high\": 3610000000, \"palId\": \"pal/lab/1\"}],
  \"geometry\": {\"type\": \"Polygon\", \"coordinates\": [[[-122.1,37.4],[-122.0,37.4],[-122.0,37.5],[-122.1,37.5],[-122.1,37.4]]]}}"

# From injected PAL records, as the harness does (trigger/create_ppa)
curl -s -X POST $API/ppas/from-pal -H 'Content-Type: application/json' \
  -d "{\"cbsdIds\": [\"$CBSD\"], \"palIds\": [\"pal/lab/1\"]}"
```

**Incumbents** are the injected data that protections and PPAs are derived from. These are the same kinds the harness injects: `fss`, `wisp`, `pal`, `zone`, `exclusion_zone`, `peer_sas`, `esc_sensor`, `sas_admin`, `fad_cbsd`, `database_url`, and others. Derived protections are rebuilt immediately:

```bash
curl -s -X POST $API/incumbents/fss -H 'Content-Type: application/json' -d '{
  "record": {"id": "zone/fss/lab/1", "deploymentParam": [{
    "installationParam": {"latitude": 39.0, "longitude": -98.5},
    "operationParam": {"operationFrequencyRange": {"lowFrequency": 3600000000, "highFrequency": 4200000000}}}]},
  "ttc": false}'
curl -s "$API/incumbents?kind=fss" | jq '.items[] | {kind, id}'
curl -s -X DELETE "$API/incumbents/fss/$(jq -rn '"zone/fss/lab/1"|@uri')"
```

The body format of each kind is documented under `injectIncumbent` in the reference.

### Fault injection

Fault rules change what the SAS **listeners** send. They apply to requests arriving over HTTP or HTTPS, from radios or from `/sas/{method}?transport=http|https`, never to `transport=internal`:

```bash
# The next heartbeat from SN-0001 gets 501 SUSPENDED_GRANT, once
curl -s -X POST $API/faults -H 'Content-Type: application/json' -d '{
  "name": "HB 501 once", "method": "heartbeat", "matchCbsd": "SN-0001",
  "action": "response_code", "responseCode": 501, "remaining": 1}'

# Every grant request: HTTP 503 with a body
curl -s -X POST $API/faults -H 'Content-Type: application/json' -d '{
  "method": "grant", "action": "http_status", "httpStatus": 503, "responseData": {"error": "busy"}}'

# Merge-patch every heartbeat response (here: force a 5 s heartbeat interval)
curl -s -X POST $API/faults -H 'Content-Type: application/json' -d '{
  "method": "heartbeat", "action": "patch", "responseData": {"heartbeatInterval": 5}}'

# Slow, dropped and broken answers
curl -s -X POST $API/faults -H 'Content-Type: application/json' -d '{"action": "delay", "delayMs": 4000}'
curl -s -X POST $API/faults -H 'Content-Type: application/json' -d '{"method": "registration", "action": "drop"}'
curl -s -X POST $API/faults -H 'Content-Type: application/json' -d '{"method": "spectrumInquiry", "action": "malformed"}'

curl -s "$API/faults?enabled=true" | jq '.items[] | {id, name, action, hits, remaining}'
curl -s -X PATCH $API/faults/3 -H 'Content-Type: application/json' -d '{"enabled": false}'
curl -s -X DELETE $API/faults | jq .deleted       # remove them all
```

| `action` | Effect | Needs |
|---|---|---|
| `response_code` | Replaces `responseCode` in each matching response object. Success-only fields are removed for a non-zero code. | `responseCode`. Optional: `responseMessage`, `responseData`. |
| `patch` | JSON merge patch of `responseData` into each matching response object | `responseData` (object) |
| `http_status` | Answers the whole request with this HTTP status and `responseData` as the body | `httpStatus` |
| `delay` | Waits before answering. Delays from several rules add up. | `delayMs` |
| `drop` | Closes the connection without answering | |
| `malformed` | Answers with truncated JSON | |

Rules apply in id order. `matchCbsd` matches any request whose cbsdId, fccId, serial number or grantId contains the text. `remaining` counts down and stops the rule at 0. `hits` counts how often a rule fired.

### Wire log, events and the live stream

The **wire log** keeps every exchange. List items are summaries. `GET /messages/{id}` adds the full request and response JSON:

```bash
curl -s "$API/messages?method=grant&errors=true&limit=10" | jq '.items[] | {id, ts, codes, httpStatus, error}'
curl -s "$API/messages?cbsdId=$ENC&since=2026-10-27T00:00:00Z" | jq '.items | length'
curl -s "$API/messages?code=103&transport=https" | jq '.items[].remoteAddr'
curl -s $API/messages/42 | jq '{request, response}'

# Export (NDJSON by default, or format=json), with the same filters
curl -s "$API/messages/export?since=2026-10-27T00:00:00Z" -o exchanges.ndjson
```

Filters: `method`, `transport`, `cbsdId`, `code` (a response code), `httpStatus`, `remoteAddr`, `errors=true` (failed exchanges only), `q` (text search in the request, response, error and client address), `since` and `until`.

The **event log** is the SAS's own account of what happened: state changes, policy decisions, warnings and operator actions, including actions taken through this API:

```bash
curl -s "$API/events?level=warn,error&limit=50" | jq -r '.items[] | "\(.ts) \(.level) [\(.category)] \(.message)"'
curl -s "$API/events?grantId=$GRANT" | jq .items
curl -s "$API/events/export?format=json" -o events.json
```

`DELETE /messages`, `DELETE /events` and `DELETE /messages/{id}` clear entries.

The **live stream** (`GET /stream`) is a Server-Sent Events feed of what the console sees:

| Event | Data |
|---|---|
| `hello` | Once, on connect: `{"requestId", "types", "serverTime"}` |
| `event` | A new event-log entry, with the same fields as `GET /events` items |
| `message` | A new exchange, with the same fields as `GET /messages` items |
| `changed` | `{"what": "cbsds" \| "grants" \| "settings" \| "certs" \| "spectrum" \| "faults" \| "registry" \| "map" \| "terrain" \| "status" \| …}`: re-read that resource |

A comment line (`: ping`) every 15 s keeps proxies from closing the connection. Choose types with `?types=event,message`.

The stream ends when its credentials stop being valid: the token is revoked or expires, or a password is set on an open SAS. It also ends when the client stops reading and more than 4 MB of events are waiting for it. Clients should reconnect; `EventSource` does this on its own after the `retry` delay (3 s).

```bash
curl -sN "$API/stream?types=message" | grep --line-buffered '^data:' | cut -c7- | jq -c '{method, codes, cbsdIds}'
```

```js
// Browser, with a read token
const es = new EventSource(`/api/v1/stream?types=event,changed&access_token=${token}`);
es.addEventListener('event', (e) => console.log(JSON.parse(e.data).message));
es.addEventListener('changed', (e) => refresh(JSON.parse(e.data).what));
```

### Settings

Every runtime setting is readable and changeable. Changes are validated against the settings schema and applied without a restart:

```bash
curl -s $API/settings | jq '.profile, (.settings | {heartbeatIntervalSec, registrationPolicy, tlsClientAuth})'
curl -s $API/settings/heartbeatIntervalSec
# {"key":"heartbeatIntervalSec","group":"Protocol","description":"heartbeatInterval returned in grant responses.","unit":"s","schema":{"type":"integer","minimum":1},"default":60,"value":60,"restartsListeners":false}

curl -s -X PATCH $API/settings -H 'Content-Type: application/json' \
  -d '{"heartbeatIntervalSec": 30, "maxGrantsPerCbsd": 4}' | jq '{changed, listenersRestarted}'
curl -s -X PUT $API/settings/requireKnownFccId -H 'Content-Type: application/json' -d '{"value": true}' | jq .changed

curl -s $API/settings/schema | jq '.items[] | {key, group, restartsListeners}'   # every setting described
curl -s $API/settings/profiles | jq '.items[] | {name, description}'
curl -s -X POST $API/settings/profiles/winnforum/apply | jq .changed              # lab, winnforum or open
curl -s -X POST $API/settings/reset                                              # back to defaults
```

`GET /settings` returns `{"settings": {…}, "profile": "lab"}`, where `profile` names the profile the settings match, or is null. `PATCH /settings` and `PUT /settings/{key}` return what changed, whether the listeners restarted, the resulting settings, the matching profile (if any) and the listener status. Cross-field rules are enforced. The HTTP and HTTPS ports must differ, and the band edges must be in order. Server certificates must exist, hold a private key and be of different key types (at most one RSA and one ECDSA), and the list cannot be emptied while HTTPS is enabled. Settings marked `restartsListeners` restart the SAS listeners before the call returns.

### Certificates and TLS

The lab PKI created on first start has a root CA and SAS, CBSD, Domain Proxy and Installer CAs. Everything about it is available:

```bash
curl -s "$API/certs?ca=true" | jq '.items[] | {id, kind, role, name}'
CBSD_CA=$(curl -s "$API/certs?kind=sub_ca&q=CBSD" | jq -r '.items[0].id')

# A device certificate for a radio (and register its FCC ID)
CERT=$(curl -s -X POST $API/certs/cbsd -H 'Content-Type: application/json' -d "{
  \"parentId\": \"$CBSD_CA\", \"fccId\": \"TEST-FCC\", \"serial\": \"SN-0001\",
  \"keyType\": \"ec256\", \"registerFccId\": true}" | jq -r .id)

# The radio bundle the console offers (zip: cert, keys in every format, chains, PKCS#12, SAS root)
curl -s "$API/certs/$CERT/download?format=bundle&password=cbrs" -o SN-0001.zip
# Single files
curl -s "$API/certs/$CERT/download?format=fullchain" -o device-fullchain.pem
curl -s "$API/certs/$CERT/download?format=key-traditional" -o device-key.pem
curl -s "$API/certs/$CERT/download?format=p12-legacy&password=cbrs" -o device-legacy.p12

# Many radios at once: one zip with a bundle per device
curl -s -X POST $API/certs/cbsd-batch -H 'Content-Type: application/json' -d "{
  \"parentId\": \"$CBSD_CA\", \"devices\": [{\"fccId\": \"TEST-FCC\", \"serial\": \"SN-0002\"},
  {\"fccId\": \"TEST-FCC\", \"serial\": \"SN-0003\"}]}" -o radios.zip
```

Download formats: `pem`, `crt`, `der`, `chain`, `fullchain`, `crl` (CAs only), and these key-bearing formats that need write access: `key`, `key-traditional`, `all-in-one`, `all-in-one-traditional`, `p12`, `p12-legacy`, `bundle`. `GET /certs/{id}` returns the certificate's details, PEM, chain and children.

Other issuers work the same way: `POST /certs/root`, `/certs/sub-ca` (`role`: `sas`, `cbsd`, `operator`, `installer`), `/certs/server`, `/certs/domain-proxy` and `/certs/installer`. Imports go through `POST /certs/import` (PEM, optional key and passphrase) and `/certs/import-p12` (base64 PKCS#12).

**The HTTPS listener's certificates and trust:**

```bash
curl -s $API/tls | jq                 # server certificates, trusted client CAs, listener state

# Issue an ECDSA server certificate for a new host name and present it. "add" puts it in place of the
# current ECDSA certificate and keeps the RSA one: the listener presents at most one of each key type.
SAS_CA=$(curl -s "$API/certs?kind=sub_ca&q=SAS" | jq -r '.items[0].id')
curl -s -X POST $API/certs/server -H 'Content-Type: application/json' -d "{
  \"parentId\": \"$SAS_CA\", \"CN\": \"sas.lab\", \"sans\": [\"sas.lab\", \"172.16.0.45\"],
  \"keyType\": \"ec256\", \"use\": \"add\"}"

# Or set the list explicitly (at most one RSA and one ECDSA); trust a CA for client certificates
curl -s -X PUT $API/tls/server-certs -H 'Content-Type: application/json' -d '{"ids": ["<rsa id>", "<ecdsa id>"]}'
curl -s -X PUT $API/tls/trusted-cas -H 'Content-Type: application/json' -d '{"ids": ["<ca id>"]}'

curl -s $API/trust-bundle -o sas-trust.pem        # every CA, for a radio's trust store
```

These calls restart or reload the HTTPS listener and return once it is back. A list with two certificates of the same key type is refused (`400 validation_failed`): OpenSSL holds one certificate per key type, and a second one would stop the listener from starting.

**Revocation:**

```bash
curl -s -X POST $API/certs/$CERT/revoke     # refused at the TLS handshake while tlsCheckCrl is on
curl -s "$API/certs/$CBSD_CA/download?format=crl" -o cbsd-ca.crl
curl -s -X POST $API/certs/$CERT/unrevoke
# CRLs from external CAs (e.g. the harness PKI), base64 PEM or DER
curl -s -X POST $API/crls -H 'Content-Type: application/json' \
  -d "{\"files\": [{\"name\": \"harness root\", \"data\": \"$(base64 -w0 root.crl)\"}]}"
```

### The WInnForum harness admin API

Every admin call the WInnForum test harness makes (WINNF-TS-0096) can be made here. The calls work even when `harnessAdminEnabled` is off and the harness listener endpoint is closed:

```bash
curl -s $API/harness/methods | jq -r '.items[] | "\(.method)  \(.description)"'

curl -s -X POST $API/harness/reset
curl -s -X POST $API/harness/injectdata/fcc_id -H 'Content-Type: application/json' -d '{"fccId": "HARNESS-FCC", "fccMaxEirp": 47}'
curl -s -X POST $API/harness/trigger/meas_report_in_heartbeat_response
curl -s -X POST $API/harness/trigger/daily_activities_immediately
curl -s -X POST $API/harness/get_daily_activities_status | jq .result
# {"method":"injectdata/fcc_id","result":null} is the shape: result is what the harness would receive
```

Each call is logged in the wire log as `admin/<method>`. `GET /harness/sas.cfg?host=172.16.0.45` returns a `sas.cfg` for the harness with this SAS's addresses.

Most harness calls also have a REST form (`/registry/*`, `/incumbents/*`, `/dpas/*`, `/ppas/from-pal`, `/operations/*`) that returns the resulting resource.

### Operations: daily activities, triggers, reset, listeners

```bash
curl -s $API/operations/state | jq      # daily activities, measurement triggers, PPA status, flags

curl -s -X POST "$API/operations/daily-activities"              # waits for the run (200)
curl -s -X POST "$API/operations/daily-activities?wait=false"   # 202, then poll:
curl -s $API/operations/daily-activities | jq
curl -s -X POST $API/operations/daily-activities/schedule

curl -s -X PUT $API/operations/measurement-triggers -H 'Content-Type: application/json' \
  -d '{"measInRegistration": true, "measInHeartbeat": false}'
curl -s -X PATCH $API/operations/flags -H 'Content-Type: application/json' -d '{"escConnected": false}'

# Wipe SAS state like the harness Reset call: CBSDs, grants, registry entries, injected incumbents,
# PPAs, protections, triggers and flags (and the logs, with clearLogs). Settings, certificates and
# fault rules are kept.
curl -s -X POST $API/operations/reset -H 'Content-Type: application/json' -d '{"confirm": "RESET", "clearLogs": true}'

curl -s $API/listeners | jq
curl -s -X POST $API/listeners/restart
curl -s -X POST $API/listeners/reload-tls    # swap certificates without dropping connections
```

### Map tiles and terrain

```bash
curl -s $API/map | jq                        # tile source configuration
curl -s $API/map/tilesets | jq '.items[] | {id, name, minZoom, maxZoom, sizeBytes, usable}'
curl -s $API/map/tilesets/<id>/tiles/8/52/98 -o tile.png

# Download a tile set for offline use: estimate, start, poll, cancel
curl -s "$API/map/download/estimate?bounds=-98.6,38.9,-98.3,39.1&minZoom=8&maxZoom=12" | jq
curl -s -X POST $API/map/download -H 'Content-Type: application/json' -d '{
  "url": "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
  "bounds": [-98.6, 38.9, -98.3, 39.1], "minZoom": 8, "maxZoom": 12, "name": "kansas-lab"}'
curl -s $API/map/download | jq .job
curl -s -X DELETE $API/map/download
```

Terrain (USGS 3DEP) feeds the Category A HAAT check:

```bash
curl -s $API/terrain | jq '{directory, tileCount, source}'
curl -s "$API/terrain/elevation?lat=39.0119&lon=-98.4842" | jq
curl -s "$API/terrain/haat?lat=39.0119&lon=-98.4842&height=6&heightType=AGL" | jq
curl -s "$API/terrain/tiles-needed?harness=true" | jq '.missing'
curl -s -X POST $API/terrain/download -H 'Content-Type: application/json' -d '{"around": [{"lat": 39.0119, "lon": -98.4842}]}'
curl -s $API/terrain/download | jq .job
```

### Configuration, backups and raw data

```bash
# Export the configuration (settings, registry, protections, PPAs, faults) and import it elsewhere
curl -s "$API/config/export?download=true" -o sasbench-config.json
curl -s -X POST $API/config/import -H 'Content-Type: application/json' -d @sasbench-config.json \
  | jq '{settingsChanged, settingsSkipped, rows}'

# A consistent copy of the whole SQLite database (admins only: it holds private keys and password hashes)
curl -s $API/system/backup -o sasbench-$(date +%F).db
```

An import keeps this installation's server certificates and trusted CAs, and never touches user accounts or API keys. It inserts or replaces rows and never deletes. To restore a backup, stop the container, replace `sas.db` in the data volume with the backup file, delete any `sas.db-wal` and `sas.db-shm` next to it, and start the container again ([INSTALL.md](INSTALL.md#backup-and-restore) shows how to reach the volume).

**Raw tables.** Every table in the database can be read, which is useful for anything the resource endpoints do not show:

```bash
curl -s $API/data/tables | jq -r '.items[] | "\(.name) \(.rows)"'
curl -s $API/data/tables/grants | jq '.columns[] | {name, type, primaryKey}'
curl -s "$API/data/tables/grants/rows?column=state&value=AUTHORIZED&order=created_at&desc=true&limit=10" | jq .items
curl -s "$API/data/tables/msg_log/rows?column=request&like=SN-0001" | jq .total
```

Private keys, password hashes, session ids and API key hashes read as `"[redacted]"` and cannot be filtered or sorted on. The rows of `api_tokens` need write access; the `users` and `sessions` tables are for admins. The data endpoints are read-only. Changes always go through the resource endpoints, so the SAS's own rules apply.

## Client examples

**Python** (standard library only):

```python
import json, urllib.parse, urllib.request

API = "http://172.16.0.45:8080/api/v1"
TOKEN = "sasb_…"

def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read() or "null")
    except urllib.error.HTTPError as e:
        err = json.load(e)["error"]
        raise RuntimeError(f"{err['status']} {err['code']}: {err['message']} ({err['requestId']})")

for c in call("GET", "/cbsds?state=REGISTERED")["items"]:
    cid = urllib.parse.quote(c["cbsdId"], safe="")
    grants = call("GET", f"/cbsds/{cid}/grants")["items"]
    print(c["cbsdId"], [(g["grantId"], g["state"]) for g in grants])

# Suspend every authorized grant
for g in call("GET", "/grants?state=AUTHORIZED")["items"]:
    call("POST", f"/grants/{urllib.parse.quote(g['grantId'], safe='')}/suspend")
```

**Node.js / TypeScript** (built-in `fetch`):

```ts
const API = 'http://172.16.0.45:8080/api/v1';
const headers = { Authorization: `Bearer ${process.env.SASBENCH_TOKEN}`, 'Content-Type': 'application/json' };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = r.status === 204 ? undefined : await r.json();
  if (!r.ok) throw new Error(`${data.error.code}: ${data.error.message}`);
  return data as T;
}

const fault = await call<{ id: number }>('POST', '/faults', { method: 'heartbeat', action: 'response_code', responseCode: 501, remaining: 1 });
// … run the radio test …
await call('DELETE', `/faults/${fault.id}`);
```

**Generated clients.** Point any OpenAPI 3.1 generator at the live document:

```bash
curl -s $API/openapi.json -o sasbench-openapi.json
npx @openapitools/openapi-generator-cli generate -i sasbench-openapi.json -g python -o sasbench-client
```

Every operation has a stable `operationId` (`listCbsds`, `suspendGrant`, `createFault`…), so generated method names do not change between releases.

## Environment variables

These affect the API. The full list is in [INSTALL.md](INSTALL.md#configuration).

| Variable | Default | Effect |
|---|---|---|
| `UI_PORT` | `8080` | Port of the console and the API |
| `SAS_API_PORT` | none | Also serve the API (only the API) on this port |
| `SAS_BIND_IP` | all addresses | The address every listener binds |
| `SAS_ADMIN_PASSWORD` | `admin` | Password of the `admin` account created on the first start. Ignored once accounts exist. |
| `SAS_AUTH` | on | `off` opens the console and the API to anyone, with admin access. See [Switching sign-in off](#switching-sign-in-off). |
| `SAS_API_CORS_ORIGINS` | none | Comma-separated browser origins allowed to call the API cross-site; `*` for any. See [Browsers and CORS](#browsers-and-cors). |
| `SAS_TERRAIN_SOURCE_URL` | USGS staged products | Mirror for `POST /terrain/download` (and the `npm run terrain` tool), with the USGS directory layout |
| `SAS_TERRAIN_DIR`, `SAS_TILES_DIR` | in the data directory | Where terrain tiles and offline map tiles live |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `404 route_not_found` for a CBSD or PPA | The id contains `/`. Percent-encode it (`%2F`). |
| `400 validation_failed: x is not a known query parameter` | A misspelled or unsupported query parameter. The reference lists the parameters of each endpoint. |
| `401 unauthorized` | No credentials, a wrong password, or an API key that is wrong, revoked or expired. `GET /auth/whoami` with the same credentials tells you who you are once they work. |
| `401 account_disabled` | The user (or the owner of the key) is disabled. An admin can enable the account under **Users**. |
| `403 forbidden` | The role or key does not allow it: a viewer or `read` key changing something or downloading a private key, or a non-admin calling `/users` or `/system/backup`. |
| `429 too_many_attempts` | 10 wrong passwords from this address in 5 minutes. Wait `Retry-After` seconds, or use an API key. |
| Locked out of every admin account | Run the [reset tool](#forgotten-passwords) on the SAS host. |
| `403 origin_not_allowed` | A browser page on another origin tried to change something. Add its origin to `SAS_API_CORS_ORIGINS`. |
| `403 host_not_allowed` | A browser page reached the SAS by a DNS name it does not know. Add the name to `SAS_HOSTNAMES`, use the IP address, or list the page's origin in `SAS_API_CORS_ORIGINS`. |
| `409 conflict` creating a protection or PPA | That id exists already. Use `PUT` to replace it. |
| `409 conflict` when changing listeners | A port is in use or the HTTPS listener has no usable certificate. `GET /listeners` shows the listener error. |
| A protocol request "worked" but the radio sees something else | `transport=internal` skips fault rules and TLS. Use `transport=http` or `https` to go through the listener. |
| A fault rule never fires | It only applies to listener traffic. Check `method`, `matchCbsd`, `enabled` and `remaining`, then `hits`. |
| Need to see what the API did | Every change made through the API appears in the event log, and protocol requests appear in the wire log. Search `GET /events?q=…`. |

## Versioning

The API is versioned in its path. Within `/api/v1`:

- Fields, endpoints, query parameters and enum values may be **added**. Clients should ignore fields they do not know.
- Nothing is removed or renamed, and no meaning changes, without a new version (`/api/v2`), which would then run alongside v1.

The console's own endpoints (`/api/*` outside `/api/v1`) are private to the console and may change in any release. Build on `/api/v1`.
