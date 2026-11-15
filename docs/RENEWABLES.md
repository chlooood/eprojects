# Renewables screening assessor

`renewables.html` (built to `dist/` and `deploy/`) screens land beside each pipeline for solar and wind. It is a separate page with its own module (`src/renewables.js`) and its own cached inputs (`data/renewables/<corridor>/inputs.json`). It reads pipeline geometry only. It does not read or change risk scores, tiers, thresholds, work orders, approvals, workflow schedules or saved pipeline data, and neither corridor's IDs change.

It is a screen, not a feasibility study. Land rights, interconnection capacity and queue position, permits and setbacks, Indigenous consultation, Alberta agricultural-land rules, wildlife and wetland surveys, and pipeline-crossing engineering are never assessed, so no candidate is ever labelled feasible.

## Candidate areas

| | Solar | Wind |
| --- | --- | --- |
| Band from the mapped pipeline centreline | 30–230 m each side (outside the 30 m prescribed area) | 300–2,000 m each side (turbine setback is an assumption, not a verified rule) |
| Block length | 1 pipeline segment (1 km) | 2 segments (2 km) |
| Sample grid | 20 m | 50 m |

Sample points sit on one grid per technology, and each point belongs to one candidate only, so totals are not double counted at bends. The solar and wind bands do not overlap. Candidate IDs are `rn_<corridorId>_<tech>_<first segment id>_<L|R>`.

## Score

Each factor is a linear ramp between two stated values, from 0 to 100. The score is the weighted sum. Factors, weights and ramps are in `src/renewables.js` (`FACTORS`) and on the Detail tab.

| Factor | Solar (weight, 0 → 100) | Wind (weight, 0 → 100) |
| --- | --- | --- |
| Resource | 35%, PVOUT 900 → 1,600 kWh/kWp/yr | 40%, 100 m mean speed 5 → 9 m/s over usable land |
| Terrain | 15%, median slope 15% → 3% | 15%, median slope 25% → 5% |
| Usable area | 25%, 0 → 10 ha | 20%, 0 → 100 ha |
| Grid | 25%, nearest mapped substation 15 → 1 km | 25%, 25 → 2 km |

Usable area = eligible ESA WorldCover class, slope at or below 10% (solar) or 20% (wind), and outside CPCAD protected or conserved areas. Eligible classes: solar uses shrubland, grassland, cropland and bare; wind also allows tree cover. Water, wetland and built-up areas are never usable.

Status, in order:
1. **Excluded** if 50% or more of the band is protected, or usable area is under 2 ha (solar) or 20 ha (wind).
2. **Incomplete** if any of the four inputs is unknown. No ranked score. A partial score on the known inputs and the input coverage are shown, labelled as not ranked. An unknown grid distance gives no connection cost, so no capital cost, payback or NPV. It never counts as zero cost.
3. **Strong** at 70 or more, **moderate** at 45 or more, otherwise **weak**. A candidate whose resource scores under 70 is capped at moderate, so flat land next to a substation cannot make up for a weak resource.

"No mapped substation within 30 km" is a known worst case (grid score 0), not unknown.

## Money (scenario, not prediction)

Per candidate, and pooled into one project per technology and pipeline with one connection to the nearest mapped substation. Every assumption is editable on the Money tab and names its source or says "placeholder".

- Price: Alberta uses the [AESO 2025 average pool price, $43.68/MWh](https://www.aeso.ca/assets/Annual-Market-Stats-2025.pdf). BC uses the [BC Hydro 2024 Call for Power weighted average, $74/MWh (2024$)](https://www.bchydro.com/news/press_centre/news_releases/2025/statement-bcuc-accepts-bc-hydro-2024-call-for-power-electricity-purchase-agreements.html), which only awarded projects receive.
- Wind cost: [NREL ATB 2025](https://atb.nlr.gov/electricity/2025/Land-Based_Wind) 2023 market average, US$1,968/kW capex and US$43/kW/yr opex. Grid connection: [NREL ATB 2024](https://atb.nrel.gov/electricity/2024/definitions) US$100/kW.
- Placeholders: solar capex ($1.50/Wdc), solar O&M, densities, turbine rating, losses, FX, discount rate, life, and spur line cost ($1M/km). Land cost is blank by default, and results say "before land cost" rather than assuming land is free.
- Not modelled: collector lines between strips, storage, curtailment, taxes and credits, financing structure.

Result with the defaults (2026-11-15 inputs): Edmonton pools about 196 MW of solar and 104 MW of wind on land that passes screening. That is about $12.6M and $11.6M a year of gross revenue. Neither pays back at the 2025 Alberta pool price. The break-even price is about $113/MWh for solar and $119/MWh for wind at these costs. The Coquihalla is a steep, forested valley inside protected or conserved areas: every solar strip and 11 of 12 wind blocks are excluded, and the last one is weak.

## Data sources

| Input | Source | Resolution | Licence |
| --- | --- | --- | --- |
| Wind speed at 100 m, gross capacity factor (IEC class II) | [Global Wind Atlas v4](https://globalwindatlas.info), Canada GeoTIFFs read by HTTP range | 0.0025° (~250 m) | CC BY 4.0 |
| Solar PVOUT, GHI | [Global Solar Atlas 2.0](https://globalsolaratlas.info) point API (Solargis) at each strip centre | ~250 m model grid, one value per strip | CC BY 4.0 |
| Land cover | [ESA WorldCover 2021 v200](https://esa-worldcover.org) | 10 m | CC BY 4.0 |
| Slope | [Copernicus DEM GLO-30](https://registry.opendata.aws/copernicus-dem/) | 30 m | Copernicus DEM licence |
| Protected and conserved areas | [CPCAD, ECCC](https://maps-cartes.ec.gc.ca/arcgis/rest/services/CWS_SCF/CPCAD/MapServer) | Generalised by server to ~30–45 m | OGL-Canada |
| Power lines, transformer stations | [CanVec 1:50 000 Res_MGT, NRCan](https://ftp.maps.canada.ca/pub/nrcan_rncan/vector/canvec/shp/Res_MGT/) | 1:50 000 | OGL-Canada |

Each source in `inputs.json` records its URL, retrieval time, licence, resolution, HTTP Last-Modified/ETag where given, and a SHA-256 of the raw response (raster windows: of the window read). The full CPCAD response for BC was 16 MB because of province-wide Old Growth Management Areas, so the stored copy is clipped to the study box (`raw/cpcad-clipped.geojson`). Both hashes are recorded.

## Known gaps

- **Grid is mapped, not verified.** CanVec carries no voltage, owner or available capacity, and source dates on the nearest Edmonton stations are from 1977. Hosting capacity and queue (AESO, BC Hydro) are not in the score. To add them, load a utility hosting-capacity or connection-queue layer into `scripts/fetch-renewables.py` and add a factor in `FACTORS`.
- **Land rights are unknown.** Pipeline operators usually hold an easement, not the land. Add parcels (Alberta land titles via AltaLIS, BC ParcelMap BC) as a gate, not as a score.
- **Regional resource data.** One solar value per strip. Wind is averaged over the GWA cells in each block. Neither is a site measurement.
- **Alberta agricultural-land rules** for renewables on high-class farmland are not checked. Cropland counts as eligible for solar here.
- **CPCAD only.** Provincial wildlife, wetland and Crown-land constraints outside CPCAD are not applied.

## Refresh

```sh
pip install -r scripts/renewables-requirements.txt
npm run fetch-renewables      # both corridors; writes data/renewables/<id>/inputs.json and raw/
npm run build
npm test
CHROMIUM_PATH=<chrome> npm run test:renewables-browser
```

Review the changed inputs and hashes before committing. The fetch refuses to run if a snapshot's corridor ID does not match.
