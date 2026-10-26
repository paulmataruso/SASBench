---
version: 1
slug: "web-src-app-tsx"
primary_target: "web/src/App.tsx"
related_targets: []
---

# Surface: SAS operations console (web/)

Mode: Operate. Unattended run: the direction was not put to the user; assumptions are labelled.

Audience/job: RF lab engineer bringing up CBRS radios: copy the SAS URL, issue and download radio certificates, watch registration → grant → heartbeat live, inspect any exchange verbatim, force SAS behaviour (suspend, terminate, 105, DPA, faults), tune policy.
Key states: no radios yet (first-run: show URLs and cert kit), radio heart-beating, grant suspended, error responses, listener down, harness running.

## Direction contract

FORM: Lab rack elevation, seed:9fef165e872032bd (assigned grounded candidate 6 of 7).

THESIS: The console is the rack the radios live in: every CBSD is a 1U front-panel row with status LEDs driven by real wire events. Refuses the grey SaaS admin with KPI cards and a single accent.

OWN-WORLD: Anodized rack-black rail (cool blue-black) holds navigation; cool aluminium-tinted ground; flat white panel faces ruled by hairlines; module headers as small silkscreen strips (Barlow Condensed caps, tracked); UI text Barlow; IDs, JSON, timers JetBrains Mono with tabular figures. LED vocabulary: green AUTHORIZED/ok, amber GRANTED/pending/suspended, red terminated/error, off = none. Patch-cable colour code (orange, green, blue, brown, slate, violet…) gives each CBSD one identity colour reused in band plan and map. Flat: no screws, brushed textures or bezels.

STORY: Within one viewport the engineer knows where to point the radio, which radios are talking right now, and what spectrum they hold.

FIRST VIEWPORT: Left rail nav; endpoint strip (copyable HTTPS/HTTP URLs, listener LEDs, TLS mode); rack of CBSD rows; band occupancy strip 3550–3700 MHz; live wire log column.

SIGNATURE: HB LED flashes on every heartbeat as it arrives over SSE; TX LED carries a draining bar counting down to transmitExpireTime.

RISK: LEDs drift into skeuomorphic costume; keep them 8px flat dots with a soft glow only while lit.

Raises (from challengers): follow-a-CBSD focus that persists across pages (wayfinding); rows whose state changed hold a marker until seen (gate board); hairline module grid with header strips, no whitespace inflation (high-density web). Declined: streaming wall, catalog sleeve, type specimen.
