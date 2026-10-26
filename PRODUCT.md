# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: Node 24 server (TypeScript run via type stripping, `node:sqlite`) serving a React 18 + Vite + Tailwind CSS single-page app; everything ships as one Docker container. Chosen because the UI is a dense, stateful operations console and the user asked for a single container.

## Users

RF / lab engineers who bring up and test CBRS radios (CBSDs, Category A and B, and domain proxies) on a bench or in a lab network. They sit next to the radio, its console and packet captures, and use this SAS to see exactly what the radio sent, what the SAS answered and why, and to force specific SAS behaviours (suspensions, terminations, error codes, DPA activations) on demand. Secondary use (inferred): running the official WInnForum test harness against the server.

## Product Purpose

A self-hosted Spectrum Access System that implements the WInnForum SAS–CBSD protocol (WINNF-TS-0016, TS-0065 security, SSC-0002 extensions) faithfully enough that real radios behave as they would against a commercial SAS, while exposing every decision and setting. Success: a radio registers, gets grants and heartbeats over HTTP or mutual-TLS HTTPS, and the engineer can generate and download the certificates the radio needs, change policy live, and diagnose every exchange without reading server logs.

## Positioning

Unlike a commercial SAS (no visibility, no control) or a stub (always "success"), this SAS follows the specification and the harness's expectations exactly and lets the operator inspect and override each outcome: per-request message log with full JSON, fault injection per method/CBSD, incumbent simulation (DPAs from NTIA KML, FSS/GWBL, PPAs), and a built-in lab PKI that produces radio credential bundles.

## Operating Context

- Used on a lab LAN, usually on a laptop or small server beside the radios; the radio is pointed at `https://<host>:8443/v1.2/` or `http://<host>:8000/v1.2/`.
- The engineer flips between the radio's own UI/CLI, this console and Wireshark. Sessions are long; the console stays open on a second monitor and updates live.
- Typical loop: generate/upload certs → configure radio → watch registration/grant/heartbeat → change a setting or inject a condition → watch the radio react.
- Terms of art are used verbatim: cbsdId, grantId, responseCode numbers (0, 100–105, 200, 201, 300, 400, 401, 500–502), GRANTED/AUTHORIZED, transmitExpireTime, PAL/GAA, PPA, DPA, FCC ID, CPI.

## Capabilities and Constraints

- Protocol: registration, spectrumInquiry, grant, heartbeat, relinquishment, deregistration; batched (domain proxy) requests; versioned paths.
- Transport: HTTP and HTTPS concurrently; HTTPS TLS 1.2 with WInnForum cipher suites, optional/required client certificates, CRL checks, certificate role checks (104).
- PKI: create root and sub-CAs, issue SAS server (RSA + ECDSA), CBSD, domain proxy and installer certificates; import certificates, keys, PKCS#12 and CRLs; export PEM/DER/PKCS#12/zip bundles for radios.
- WInnForum test-harness admin API (`/admin/...`) on the SAS listeners.
- Settings are live-editable and grouped into profiles (Lab, WInnForum strict, Open).
- No propagation model (no aggregate interference / IAP calculations); HAAT needs optional terrain tiles.
- Single user or small team; optional UI password (HTTP Basic). No multi-tenant concerns.

## Evidence on Hand

No screenshots, logos, customers or testimonials exist. Do not fabricate brand marks, customer names or certification claims (the product is not WInnForum-certified).

## Product Principles

1. Show the wire truth: every request and response is inspectable verbatim, with the reason for each non-zero responseCode.
2. Spec first, overrides explicit: default behaviour follows the specifications; anything that deviates (faults, lenient policy) is visibly flagged.
3. Live and immediate: changes take effect without restarts and the console reflects state within a second.
4. Lab ergonomics: the shortest path from "new radio on the bench" to "radio authorized" — certificates, URLs and IDs one click away.

## Accessibility & Inclusion

No product-specific requirement established (inferred). Keep WCAG AA contrast and full keyboard operability as the baseline.
