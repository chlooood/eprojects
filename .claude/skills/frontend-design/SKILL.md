---
name: frontend-design
description: TerraCorridor UI rules - design tokens, layout, components and motion for web/dashboard.html. Load before changing any dashboard markup, CSS or chart code.
---

# TerraCorridor frontend design

Concept: **the alignment sheet.** Pipeline engineers read corridors as linear strips indexed by
kilometre post (KP). The dashboard is a digital alignment sheet: map on top, a KP-indexed strip
of stacked lanes along the bottom, an inspector on the right. Everything is linked: hover or
select in one place and it lights up in all three.

## Hard constraints
- One file: `web/dashboard.html`. No framework, no bundler. n8n serves the built file.
- Keep `/*__ENGINE__*/` and the exact Leaflet `<script src=...leaflet@1.9.4...>` tag (build.js matches both).
- External: Leaflet from unpkg, fonts from Google Fonts. Nothing else.
- Every number on screen comes from `ENGINE`. Never hard-code a figure in markup.
- Synthetic data must always show the amber "Synthetic demo data" pill.
- Missing data is `unverified` (hatched grey), never green.

## Tokens (`:root`)
| token | value | use |
|---|---|---|
| `--bg` `--s1` `--s2` `--s3` | `#0a0b0a` `#101210` `#161916` `#1d211d` | page, panels, raised, hover |
| `--line` `--line-2` | `#252925` `#323732` | hairlines, stronger dividers |
| `--ink` `--ink-2` `--ink-3` | `#eceee6` `#a5aa9f` `#6c7168` | text levels |
| `--green` `--amber` `--red` `--grey` | `#6fd08f` `#f2a93b` `#ff5d4f` `#5d625a` | risk tiers ONLY |
| `--build` | `#d6f35f` | solar/build layer ONLY |
| `--sub` | `#82c8ff` | substations / grid |

Tier colours mean risk and nothing else. Do not use red for errors in chrome; use `--ink` + text.
SVG and Leaflet need hex: use the `C` object in JS, which mirrors these tokens.

## Type
- `--sans` Instrument Sans: UI and prose.
- `--serif` Instrument Serif italic: wordmark and the selected KP heading only. Max two uses per screen.
- `--mono` JetBrains Mono, tabular nums: every number, KP id, unit, eyebrow label.
- Eyebrows: 10.5px mono uppercase, letter-spacing .12em, `--ink-3`.
- KPI values 26px mono, weight 500, tracking -0.03em.

## Pages (hash router, one file)
- `#/` **Overview**: the full-screen dashboard. Climate only: risk level, extreme-rain / freeze-thaw /
  wet-soil days, model agreement, largest high-risk stretch. No money, build or vegetation here.
  Strip uses climate lanes (change vs 1995-2025, ±100%).
- `#/triage[/KP]`: filterable queue | map with a floating detail card | strip.
- `#/segment/KP`: full report for one KP, prev/next.
- `#/money`: assumption sliders | net-value breakdown, failure-cost scenarios, lease.
- `#/build[/KP]`: build list | map in build layer | card.
- `#/log`: audit table + JSON download.
- One Leaflet map and one strip are moved between pages (`mount()`); never create a second map.

## Projection timeline
- Today (observed 1995-2025, every model held at baseline) → 2031 → 2036, with Play. Lives on the map.
- Transitions tween scores visually only; settled states always show real engine output.
- Basemap is natural-colour satellite (no greyscale filter), with an optional Map basemap.

## Hazards
- Four natural hazards, each its own 0-100 score: ground failure, river crossing, wildfire weather, drought.
  A km's tier is its WORST hazard; always show which one (`whyText`). No crossing = "not applicable", never low.
- Colours: fire `#ff8a5c`, dry `#d9b46a`, river `#5aa9ff` (crossing dots, ringed by their own tier colour).

## Purpose (every page should serve both halves)
- Protect the pipeline where climate makes the ground riskier, AND put stable right-of-way to work (solar + storage).
- Money page answers "Is it worth running?" with a computed recommendation, the combined (risk + operator lease)
  net value, and the one assumption the answer hinges on (break-even lease rate). Never show the risk half alone as the headline.

## Tone
- Calm and practical: plain sans page titles, no headline sentences, no highlighted prose, no hover-lift cards.
- Write for judges who are not geotechnical specialists: plain words (heavy rain, soaked ground, plant cover,
  "distance along pipeline"), a "?" tooltip on every summary number, one dismissible how-to-read line on Overview.
- Plain risk words: High / Medium / Low / Missing data. Legend says the action: send a crew / watch / inspect less.

## Layout
- Workspace pages fill the viewport; document pages (Segment, Money, Log) scroll, max 1200px.
- < 860px: single column, page scrolls, map 62vh, ledger 2 columns.
- Spacing scale 4/8/12/16/20/24. Panels pad 20px. Hairline 1px borders, no drop shadows except map overlays.
- Radius 10px cards, 6px controls, 999px pills.

## Components
- Segmented toggle (`.seg`) for horizon and layer. Keyboard: `h`, `b`.
- Ledger cell: eyebrow, mono value, one-line sub. Optional inline mini-viz.
- Strip lanes: Risk score (bars, thresholds 40/65 dashed), Tier band, Slope, NDVI change (diverging), Solar MW.
- Inspector tabs: Queue, Segment, Assumptions, Log. Assumptions are never hidden behind more than one click.
- Actions: Approve = filled ink button; Reject = outline; Override needs a reason (validated inline).

## Motion
- 160-240ms, `cubic-bezier(.2,.7,.1,1)`. Numbers tween on change. Strip bars grow once on load.
- All motion off under `prefers-reduced-motion`.

## Accessibility
- Every control reachable by keyboard; visible focus ring (`outline: 2px solid var(--ink)`).
- Tier is never colour-only: chip text or tooltip always names it.
- Contrast: body text on `--s1` >= 4.5:1 (`--ink-2` passes; `--ink-3` only for labels >= 10.5px uppercase).


## Segment record page (`web/platform.html`, added 2026-11-16)

The project grew from a geohazard dashboard into a compliance platform. This page has its own rules.

Concept: **the imagery is the page.** Satellite imagery runs edge to edge. Chrome sits at the edges. One panel tells
one kilometre's story. One strip is the whole line.

- **One signature move:** the compare line. Older imagery on the left; on the right, today or the outlook to 2028,
  2030 or 2035 (default 2035). Draggable anywhere along its height. Nothing else on the page competes with it.
- **The outlook is drawn only right of the line:** amber for homes with a permit or approval, dashed sand for the
  scenarios. Zoomed out, one label per neighbourhood plan; zoomed in, one per 400 m. Scenario numbers carry a `~`.
- **One panel, one step at a time:** What changed, Options, Decide, Record. Never show all four at once. The first
  screen is a kilometre name, one sentence, three numbers and one bar.
- **One strip:** a single row of cells, one per kilometre, coloured by class location status. No stacked lanes.
- **Type:** kilometre name in Instrument Serif italic at 64px. Lead sentence 19px. Numbers 34px mono. No uppercase
  eyebrows except the small location line above the title.
- **Markers:** one quiet dot per 200 m. White for homes added, amber where permits are issued, a ring where only
  approved. Never clusters of overlapping circles.
- **No cards inside the panel.** Hairlines between facts, a left rule for notes. Pills only for buttons.
- **Glass panels** over imagery: `rgba(10,11,10,.82)` with a 14px blur. Corners 14 to 16px.
- Imagery: Esri World Imagery Wayback releases, with attribution. Label years as publication dates.
- The page must be opened in a real browser. Sandboxed previews block the imagery tiles.

References studied (Awwwards maps collection, Nov 2026): Statskogmillionen (full-bleed dark map, controls only at
the edges), Lewa House wildlife map (satellite imagery beside one editorial panel), The Witcher map of the Continent
(a timeline along the bottom as the main navigation), Google Cloud Infrastructure (sparse labels, one accent),
Beyond the Fold (map and story side by side), Kopke port wine map (large serif over terrain), Misato Town (scroll
drives the map), plus Marseille by La Phase 5, Local Guides, Tavalo, Horizonte Village and two WebGL terrain maps.

