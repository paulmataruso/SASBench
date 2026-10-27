---
name: SASBench
description: Self-hosted Spectrum Access System console, built as the equipment rack the radios live in.
colors:
  rail: "#14181f"
  rail-2: "#1e232d"
  rail-3: "#2c333f"
  rail-fg: "#e2e7ee"
  rail-mute: "#8b96a6"
  ground: "#e7eaef"
  panel: "#ffffff"
  panel-2: "#f5f7f9"
  panel-3: "#edf0f4"
  line: "#dadfe6"
  line-strong: "#bac2cd"
  ink: "#131921"
  ink-2: "#3c4757"
  ink-3: "#5a6676"
  primary: "#14181f"
  primary-hover: "#2c333f"
  primary-fg: "#f0f3f7"
  sel: "#2457c5"
  sel-soft: "#e6edfb"
  sel-ink: "#1d45a0"
  ok: "#1ea054"
  ok-soft: "#e2f4e9"
  ok-ink: "#116a36"
  warn: "#e29810"
  warn-soft: "#fcf2da"
  warn-ink: "#805000"
  bad: "#dc343c"
  bad-soft: "#fce7e7"
  bad-ink: "#a61c24"
  info: "#3472de"
  info-soft: "#e7effc"
  info-ink: "#1e50a6"
  led-off: "#cdd3dc"
  patch-orange: "#e8711c"
  patch-green: "#2f9e44"
  patch-blue: "#1772c6"
  patch-brown: "#8d5a2b"
  patch-slate: "#5c6b7a"
  patch-violet: "#7b4fd6"
  patch-rose: "#d6336c"
  patch-teal: "#0f9488"
typography:
  headline:
    fontFamily: "Barlow, system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 600
    lineHeight: "28px"
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Barlow, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "22px"
  body:
    fontFamily: "Barlow, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: "20px"
    fontFeature: "'tnum' 1"
  body-sm:
    fontFamily: "Barlow, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: "18px"
  label:
    fontFamily: "Barlow Condensed, Barlow, system-ui, sans-serif"
    fontSize: "10.5px"
    fontWeight: 600
    lineHeight: "14px"
    letterSpacing: "0.09em"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: "16px"
    fontFeature: "'zero' 1, 'tnum' 1"
rounded:
  sm: "2px"
  DEFAULT: "3px"
  md: "4px"
  lg: "6px"
  full: "9999px"
spacing:
  hair: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-fg}"
    typography: "{typography.body}"
    rounded: "{rounded.DEFAULT}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.DEFAULT}"
    padding: "0 12px"
    height: "32px"
  button-secondary-hover:
    backgroundColor: "{colors.panel-2}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.DEFAULT}"
    padding: "0 12px"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "{colors.panel-3}"
    textColor: "{colors.ink}"
  button-danger:
    backgroundColor: "{colors.bad}"
    textColor: "#ffffff"
    rounded: "{rounded.DEFAULT}"
    padding: "0 12px"
    height: "32px"
  button-sm:
    typography: "{typography.body-sm}"
    padding: "0 8px"
    height: "28px"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.DEFAULT}"
    padding: "5px 8px"
  module:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.DEFAULT}"
    padding: "12px"
  module-header:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    padding: "4px 12px"
    height: "34px"
  table-row:
    typography: "{typography.body-sm}"
    padding: "4px 12px"
    height: "36px"
  tag:
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 6px"
    height: "20px"
  rail-nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.rail-fg}"
    rounded: "{rounded.DEFAULT}"
    padding: "0 10px"
    height: "32px"
  rail-nav-item-active:
    backgroundColor: "{colors.rail-3}"
    textColor: "#ffffff"
  led:
    backgroundColor: "{colors.led-off}"
    rounded: "{rounded.full}"
    size: "8px"
---

# Design System: SASBench

## Overview

**Creative North Star: "The Lab Rack Elevation"**

The console is drawn as a front elevation of an equipment rack. A cool blue-black anodized rail runs down the left edge and carries navigation and listener status; the working area is an aluminium-tinted ground on which flat white panel faces sit, each ruled by hairlines and topped by a silkscreened header strip. Every radio (CBSD) is a single dense row in that rack, and its state is read from small front-panel LEDs that change as wire events arrive over SSE, not from cards, KPIs or charts.

Density is high and deliberate: a 13.5px body, 36px table rows, 12px module padding, 16px gutters. The type system splits three ways: Barlow for interface text, Barlow Condensed in tracked caps for the printed legends, and JetBrains Mono with slashed zero and tabular figures for every identifier, timer, frequency and JSON payload. Colour is functional: neutrals for the hardware, a four-state LED vocabulary for status, one blue for selection and focus, and an eight-colour patch-cable code that gives each CBSD a single identity colour reused across the rack, band plan and map.

The material is flat. There are no screws, brushed textures, bezels or skeuomorphic depth; the only glow in the system belongs to a lit LED. Light and dark themes are both first-class and follow `prefers-color-scheme` unless overridden with `data-theme`.

**Key Characteristics:**
- Dark rail plus light panels: the hardware frame and the faces it holds.
- Silkscreen legends (condensed, tracked caps) label modules, table heads and readout keys.
- 8px flat LEDs as the main status signal; a soft glow only while lit.
- Patch-cable identity colour per CBSD, shared across every view.
- Mono with tabular figures for all machine values.
- Hairline borders and tonal panel steps; near-zero shadow.

## Colors

The palette is cool-neutral hardware with saturated signal colours reserved for LEDs, tags and patch identity. All colours are defined as RGB triplets on `:root`, with a full dark-theme set, and are consumed through `rgb(var(--token) / alpha)`.

### Primary
- **Anodized Rail Black** (rail): the navigation rail background, and also the primary-button fill (primary). In dark theme the primary button inverts to a pale aluminium (`#dee4ec`) so it stays the strongest control.
- **Rail Steps** (rail-2, rail-3): rail hover and active nav item; rail dividers.
- **Rail Legend** (rail-fg, rail-mute): rail text and the muted silkscreen of rail group labels and listener ports.

### Secondary
- **Selection Blue** (sel, sel-soft, sel-ink): the single interaction colour. Focus rings, the active tab underline, switch-on state, followed-row background (sel-soft), inline links (sel-ink), text caret and selection tint. It is never a status colour.

### Tertiary
- **LED Signal Set** (ok, warn, bad, info): each comes as a trio. The base hue lights LEDs and drain bars; `-soft` fills tags and notes; `-ink` is the text colour on those fills and for status numerals. Mapping is fixed: ok = AUTHORIZED / listening / success; warn = suspended / pending / 105 / 501; bad = terminated / error / listener down; info = GRANTED but not yet authorized.
- **LED Off** (led-off): an unlit LED. "Off" is a real state (none, disabled), not an absence.
- **Patch-Cable Code** (patch-orange through patch-teal, CSS `--p0`..`--p7`): one colour per CBSD, chosen by hashing its ID. It appears as the 10px swatch at the start of each rack row, as the fill of that CBSD's grant blocks in the band strip and band plan, and as map markers. Suspended grants show the same colour as a 135-degree stripe of full and 45% alpha. Text set on a patch fill uses its partner token `--p0-fg`..`--p7-fg` (through `patchFg()`): ink on the pale orange, green and teal patches in the light theme, white on the others, and near-black on every patch in the dark theme.
- **CBSD names:** wherever a CBSD is named it reads `FCC ID / serial` in mono, with its swatch, linked to its page (`CbsdName`). When space runs short the FCC ID truncates first, so the serial (what tells two bench units apart) stays readable; the full cbsdId is in the title.

### Neutral
- **Aluminium Ground** (ground): the page background behind all panels.
- **Panel Faces** (panel, panel-2, panel-3): panel is the module face; panel-2 is header strips, table heads, JSON wells and dialog footers; panel-3 is row hover, unselected tracks and neutral tags.
- **Hairlines** (line, line-strong): line rules modules, rows and tabs; line-strong outlines inputs, secondary buttons and segmented controls.
- **Ink Steps** (ink, ink-2, ink-3): primary text, secondary text and labels, then muted metadata and silkscreen legends.

### Named Rules
**The LED Vocabulary Rule.** Status colour means exactly one thing everywhere: green authorized/ok, amber pending/suspended, red terminated/error, blue granted-not-transmitting, grey off. Don't reuse these hues for decoration or emphasis.

**The One Cable Per Radio Rule.** A CBSD's patch colour is its identity across every page. Use `patchColor(cbsdId)`; never assign patch colours by list position or reuse them for anything that is not a CBSD.

**The Selection Is Not Status Rule.** Blue `sel` marks focus, selection and links only. A GRANTED grant uses `info`, which is a different token even though the hue is close.

## Typography

**Display Font:** none. The largest type is the 21px page headline.
**Body Font:** Barlow (with system-ui, sans-serif), weights 400 / 500 / 600 / 700.
**Label Font:** Barlow Condensed (with Barlow), weights 500 / 600, in uppercase.
**Mono Font:** JetBrains Mono (with ui-monospace), weights 400 / 500.

**Character:** Barlow's engineered grotesque reads like equipment documentation, and its condensed cut is the silkscreen printed on the rack. The mono carries the wire truth: IDs, codes, MHz, timers and JSON.

The scale is a fixed px ramp with paired line heights: 10.5/14, 11.5/16, 12.5/18, 13.5/20, 15/22, 17/24, 21/28, 26/32. The body carries `tnum` globally; mono adds a slashed zero.

### Hierarchy
- **Headline** (600, 21px/28px, -0.01em): page titles in the page header, with an optional 12.5px ink-3 sub-line capped at 80ch.
- **Title** (600, 15px/22px): drawer and dialog titles, empty-state titles (500), and the product name in the rail.
- **Body** (400, 13.5px/20px): default interface text, inputs, buttons, nav items, readout values.
- **Body Small** (400, 12.5px/18px): table cells, field labels (500, ink-2), notes, small buttons.
- **Label / Silkscreen** (600, 10.5px/14px, 0.09em, uppercase, Barlow Condensed, ink-3): module headers (bumped to 11.5px, ink-2), table heads, readout keys, sub-block legends inside panels. Rail group labels use 0.12em in rail-mute. Tags use the condensed face at 11.5px, 500 weight, 0.04em.
- **Mono** (400 to 500, 11.5px; 10.5px for timers, tick labels and code tags): cbsdId / FCC ID / serial, grant ranges, response codes, timestamps, URLs (12.5px), JSON (11.5px/18px).

### Named Rules
**The Silkscreen Legend Rule.** Condensed tracked caps label a thing that sits right below or beside them: a module, a column, a readout value, a block of data. They are legends, not decoration.

**The Machine Values Are Mono Rule.** Anything a radio sent or a spec defines (IDs, codes, frequencies, EIRP, timers, URLs, payloads) is set in JetBrains Mono with tabular figures, so columns line up and zeros can't be read as O.

## Layout

The shell is a full-viewport flex row: the rail on the left, then a 48px top bar over a scrolling main area. The rail is 56px wide with icons only from `md` (768px) up, grows to 216px with labels at `lg` (1024px), and below `md` becomes a 240px slide-in drawer over a rail-tinted scrim.

Content is capped at 1680px and padded 16px (24px x 20px from `lg`). Pages stack modules with 16px gaps. The overview uses a main column with a fixed side column: 380px at `xl` (1280px) and 440px at `2xl` (1536px), which holds the live wire log.

Spacing works on a 4px base, and the steps actually reused are 4, 8, 12, 16 and 24px. Module bodies use 12px padding, table cells 12px horizontal padding, and controls 8 to 12px. Vertical rhythm is the "1U" row: 36px table rows, 34px module header strips, 32px buttons and nav items, 28px small buttons. Whitespace is not used for emphasis; grouping comes from hairlines and header strips.

**The 1U Rhythm Rule.** Rows are 36px, controls are 32px (28px small), header strips are 34px. New dense lists use the same heights so the rack keeps one cadence.

## Elevation & Depth

Depth comes from tone, not shadow. Ground, panel and the panel-2 / panel-3 steps separate surfaces; hairlines do the rest. Resting modules carry only a barely-visible two-layer contact shadow. A real lift is reserved for things that float above the rack: drawers, dialogs, toasts and map popups.

### Shadow Vocabulary
- **Panel contact** (`box-shadow: 0 1px 2px rgb(var(--shadow) / 0.06), 0 1px 1px rgb(var(--shadow) / 0.04)`): resting modules and the selected segment of a segmented control.
- **Pop** (`box-shadow: 0 12px 32px -8px rgb(var(--shadow) / 0.28), 0 2px 6px rgb(var(--shadow) / 0.12)`): drawers, confirm dialogs, toasts.
- **Focus halo** (`box-shadow: 0 0 0 3px rgb(var(--sel) / 0.18)`): focused text fields, with the border switching to sel.
- **LED glow** (`box-shadow: 0 0 5px rgb(var(--led-c) / 0.55)`): lit LEDs only. Unlit LEDs get a 1px inset ring at 12% instead.

### Named Rules
**The Flat Faces Rule.** Panels are flat at rest. Only floating layers (drawer, dialog, toast, popup) use the pop shadow, and only a lit LED glows.

## Shapes

Corners are machined, not soft: 3px by default on modules, buttons, inputs and notes; 2px on tags, segments, band blocks and swatches; 4px on dialogs; 6px is the largest step. Circles are reserved for LEDs, change marks, the switch, and the 3px TX drain track. Every container is outlined by a 1px hairline; the rail-side drawer has a single left border. Suspended spectrum is hatched with a repeating diagonal stripe rather than greyed out.

## Components

### Buttons
Compact, flat and bordered: they read like panel switches.
- **Shape:** 3px corners, 1px border, 32px tall with 12px side padding (small: 28px / 8px). Icon-only buttons are square. Icons are 14px Lucide at stroke 2, with a 6px gap.
- **Primary:** rail black fill with pale text (inverted in dark theme); hover steps to rail-3.
- **Secondary (default):** panel face, line-strong border, ink text; hover darkens the border to ink-3 and fills panel-2; active panel-3.
- **Ghost:** transparent and ink-2; hover fills panel-3 and darkens text. Used for copy buttons and toolbar actions.
- **Danger / Danger-ghost:** bad fill with white text, hover brightness 110%; or transparent with bad-ink text and a bad-soft hover.
- **States:** 150ms colour transitions; disabled at 50% opacity; loading swaps the icon for a spinner.

### Tags
- **Style:** 20px tall, 2px corners, 1px tinted border, `-soft` fill with `-ink` text per tone (ok, warn, bad, info, sel, off). Text is Barlow Condensed with slight tracking, or mono at 10.5px for numeric tags.
- **Variants:** grant-state tags follow the LED vocabulary (and append "SUSPENDED"); response-code tags show the number in mono plus its condensed name; HTTP tags are neutral below 300, warn below 500, bad above. Transport tags (HTTP, HTTPS, INTERNAL) are neutral mono tags: they name a path, not a state.

### Modules (cards / containers)
- **Corner Style:** 3px.
- **Background:** panel face; header strip in panel-2.
- **Shadow Strategy:** panel contact only (see Elevation).
- **Border:** 1px line around the module and under the header.
- **Header:** at least 34px, silkscreen title in ink-2, optional 11.5px meta text, right-aligned actions.
- **Internal Padding:** 12px, or flush for tables and lists.

### Inputs / Fields
- **Style:** panel fill, 1px line-strong border, 3px corners, 5px x 8px padding, 13.5px text. Selects use a custom 10x6 chevron; textareas switch to mono 12.5px with spellcheck off.
- **Hover:** border to ink-3.
- **Focus:** border to sel plus the 3px sel halo at 18%.
- **Error / Disabled:** `aria-invalid` turns the border to bad, and the message below is 11.5px bad-ink. Disabled is a panel-2 fill with ink-3 text.
- **Label:** 12.5px, 500 weight, ink-2, 4px above; hints are 11.5px ink-3. `Field` labels its control (`htmlFor`/`id`) and wires the hint or error with `aria-describedby`; a control that carries its own `aria-label` (one of a min/max pair) keeps the hint but not the id.
- **Switch:** 32x18 pill; on is sel fill, off is panel-3 with a line-strong border, and the 12px white knob slides over 150ms.
- **Segmented:** a panel-2 trough with line-strong border; the selected segment is a raised panel face with panel contact shadow and a line-strong ring. Arrow keys, Home and End move the selection (roving tabindex), as they do on Tabs. When the options cannot fit one row they lay out as an even grid (the console's six methods as 3 + 3), never a clipped scroller.
- **Focus:** a 2px sel outline at 2px offset; on the rail the outline is rail-sel so it reads on the dark ground.

### Navigation
- **Rail:** rail background, a 48px brand row with the rack mark, and groups (Operate / Diagnose / Configure) headed by rail-mute silkscreen. Items are 32px, 3px corners, 13.5px; hover is rail-2; active is rail-3 with white text and a light-blue icon. Count badges are right-aligned tabular numerals. The footer shows an LED, condensed label and mono port for each listener, plus the version line.
- **Tabs:** 36px, a 2px underline in sel when active, line-strong on hover, optional mono count chip.
- **Top bar:** the followed-CBSD chip (or, when nothing is followed, a "Follow a CBSD…" picker), the settings-profile tag (warn on the open profile, off otherwise), the live LED and the theme switch. On phones it carries the page title, and the rail opens as a modal sheet that traps focus and closes on Escape. A "Skip to content" link is the first tab stop.
- **Followed-only filter:** pages that list per-CBSD records (grants, wire log, events) offer a "Followed CBSD only" switch, shown only while a CBSD is followed.

### Data Tables
Hairline rules between rows, 36px rows, sticky panel-2 silkscreen heads, hover panel-3 at 70%, and a sel-soft fill for the selected (followed) row. Body text is 12.5px.

### CBSD Rack Row (signature)
Each radio is one 1U table row. From left to right: the 10px patch swatch (2px corners) and a change mark slot; three LEDs (REG, GNT, HB) spaced 19px apart under condensed column heads; the TX indicator; the mono `FCC ID / serial` link with category and state tags and a muted 11.5px detail line; the held spectrum as mono ranges; and the last-seen age. The HB LED replays a 900ms white-hot flash on every heartbeat received.

The LEDs read from the radio's own schedule. HB uses the shortest heartbeat interval among its active grants (60s when unknown): ok while the last heartbeat is within 1.5x that interval plus 5s, warn when it is late or the last answer was 501 or 105, bad on any other non-zero code, and off once it is more than 3x the interval plus 5s old. On the CBSDs page the rack runs in detail mode: the sub-line adds deployment, user ID, location and height, and Last seen and Follow columns join on the right. On phones each row stacks into a labelled LED line above the name.

### LED
An 8px flat circle. Unlit it is led-off with a 12% inset ring; lit it takes ok, warn, bad or info with a 5px glow at 55%. Colour changes transition over 200ms. The flash keyframe starts white with a 12px halo and settles by 35%, using `cubic-bezier(0.16, 1, 0.3, 1)`. With reduced motion, the flash shortens to 1ms.

### TX Drain Indicator
An LED followed by a 40x3px rounded track in line, filled with ok (warn under 15s) in proportion to the time left before transmitExpireTime, then a 46px mono countdown. The fill width eases linearly over 1s per tick.

### Band Strip
A 3550 to 3700 MHz occupancy strip. An 8px panel-3 track shows GAA availability in line-strong at 70%. Below it, 18px lanes hold grant blocks in each CBSD's patch colour with white mono MHz labels; non-authorized grants drop to 60% opacity and suspended grants are hatched. Mono tick labels sit every 10 MHz, and an empty state is a dashed hairline box.

### Band Plan
The spectrum page's full plan: GAA, PAL, protection and grant lanes on one MHz axis. The GAA lane is neutral, because availability is not a status: available ranges are an opaque 50% mix of line-strong into panel, drawn over a hatched "not available" track. Grant blocks are opaque patch colour with `--pN-fg` labels reading `serial · N dBm`; keyboard focus thickens the block outline to 2.5px in sel.

### Live Wire Column
The overview's right column streams exchanges newest first and fills the column's height. Consecutive good heartbeats from one CBSD fold into a single line that updates in place with a xN count; a non-zero response code or any other method gets its own row, and a new row for that CBSD ends the fold. Pause holds incoming rows and offers "Resume (N new)".

### Change Mark
A 7px hollow ring (1.5px inset, sel) beside a row whose state changed, which stays until the row is hovered, focused or touched. It is selection blue rather than an LED hue, because a change is news, not a fault. It enters with a 400ms scale-in.

### Feedback
- **Note / ErrorNote:** 3px box with a tone `-soft` fill, tinted border and 12.5px `-ink` text.
- **Toast:** bottom-right, max 380px, panel face with pop shadow and a leading LED as the tone signal. Slides in 8px over 200ms; errors stay 7s, others 3.5s.
- **Drawer:** right-side, 640px by default, with a 48px panel-2 header and a rail-tinted 30% scrim. Slides in 24px over 220ms.
- **Skeleton:** a panel-3 to line shimmer over 1.4s with 3px corners.
- **Empty:** centred, 24px stroke-1.5 icon in ink-3, 15px title, 12.5px ink-3 copy capped at 60ch.
- **JSON view:** panel-2 well with a hairline border and mono 11.5/18. Keys are sel-ink, strings ok-ink, numbers warn-ink, booleans and null patch-violet.

## Do's and Don'ts

### Do:
- **Do** show live state with 8px LEDs in the fixed vocabulary (ok / warn / bad / info / off), and keep the glow to lit LEDs only.
- **Do** mark every CBSD with its patch-cable colour from `patchColor(cbsdId)`, wherever it appears (rack swatch, band blocks, map).
- **Do** label modules, table columns and readout keys with silkscreen legends (Barlow Condensed, 10.5px, 600, uppercase, 0.09em).
- **Do** set IDs, codes, frequencies, timers, URLs and JSON in JetBrains Mono with tabular figures.
- **Do** build new surfaces from modules: panel face, 1px line border, 3px corners, a 34px panel-2 header strip, 12px body padding.
- **Do** keep to the 1U rhythm: 36px rows, 32px controls, 16px gutters between modules.
- **Do** define any new colour as an RGB triplet on `:root` with a dark-theme value, and consume it through the Tailwind role names.
- **Do** honour `prefers-reduced-motion`: flashes collapse and slide or scale entrances are removed.

### Don't:
- **Don't** add KPI stat cards, hero numbers or charts that duplicate what the rack and band strip already show.
- **Don't** dress the rack up as hardware. No screws, brushed metal, bezels, decorative gradients or 3D LEDs; faces stay flat. The only gradients allowed are functional: the diagonal hatch on suspended spectrum and the skeleton shimmer.
- **Don't** use status hues (ok, warn, bad, info) or patch colours for decoration, or use sel blue to signal status.
- **Don't** put a shadow on a resting panel beyond panel contact; the pop shadow belongs to floating layers only.
- **Don't** round containers past 6px; circles are reserved for LEDs, marks, switches and drain tracks.
- **Don't** set font sizes off the px ramp or hard-code colours outside the token set.
