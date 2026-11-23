# NGTL route data

`osm-ab-ngtl.geojson` holds the NGTL lines that OpenStreetMap explicitly tags
with an NGTL / NOVA Gas operator: 6 ways, about 505 km, all in north-central
Alberta (Fort Saskatchewan area north to Wandering River and Athabasca). One
36 km way runs alongside another as a loop, so the corridor is about 470 km.

That is roughly 2% of the 24,119 km NGTL system. Every other NGTL kilometre is
"route not mapped" — nothing is inferred from untagged gas lines.

Source: © OpenStreetMap contributors, ODbL 1.0
(https://www.openstreetmap.org/copyright). Extracted from the Geofabrik
Alberta and British Columbia downloads dated 2026-11-21 with
`scripts/osm-pipelines-extract.js`. Derived data must stay under ODbL and keep
this credit.

Not used: the CER Pipeline Profiles line (vendor data, no redistribution) and
the AER Enhanced Pipeline file (has no operating NGTL; provincially regulated
lines only).
