# Disclosures

## Outside services and data
- n8n (workflow engine)
- Open-Meteo: Historical Weather API (ERA5 / ERA5-Land), Climate API (CMIP6 HighResMIP: MRI-AGCM3-2-S, EC-Earth3P-HR, MPI-ESM1-2-XR), Elevation API, Forecast API. Free tier, non-commercial. Credit: CMIP6 programme and Open-Meteo.
- NASA POWER climatology (ALLSKY_SFC_SW_DWN)
- Copernicus Data Space Ecosystem, Sentinel-2 Statistical API (NDVI), if connected by submission time
- OpenStreetMap via Overpass (route, substations, rivers, streams and canals for crossings), ODbL
- Open-Meteo Flood API (GloFAS river discharge, 1995 to 2025) for peak flow at river crossings. Historical only: there is no projected river flow, so future flood pressure at a crossing uses the projected heavy-rain change.
- Esri World Imagery tiles (basemap), Leaflet
- PHMSA hazardous liquid accident data (ML training labels), if training is completed
- AI models: Google Gemini 3.5 Flash through a free AI Studio key in the live n8n (W2 risk explanations, WF4 work order summaries, W5 weekly report narrative). Each output is checked against the computed numbers and falls back to fixed template text if the check fails or the call errors.
- n8n templates used as patterns: list template numbers here

## What is real and what is not
- Demo corridor in `data/demo/`: SYNTHETIC. Illustrative route, simulated climate and humidity series, illustrative waterways and river flows, run through the real engine. Labelled on the dashboard.
- Wildfire weather is a simple hot-dry-rainless day count, not a Canadian Fire Weather Index. Drought is soil dryness and dry spells, not a drought index. Both are provisional, for expert review.
- Live n8n run: real climate, elevation and Sentinel-2 NDVI data. The route is 22 km of a pipeline way from OpenStreetMap near Edmonton, cached from a laptop because Overpass times out from n8n Cloud. OSM tags it as a Trans-Northern line; we have not verified the tag, have no relationship with any operator, and the corridor id `ab-strathcona-demo` is our own label. If the cache is missing W1 falls back to an embedded fixture route, labelled synthetic on the dashboard.
- Offline snapshot: `deploy/index.html` carries a saved copy of a real n8n run and shows it, labelled "Offline snapshot", when n8n cannot be reached. Approvals made in that mode stay in the browser.
- River crossings on the live corridor are OSM waterways intersected with the centreline on a laptop (`scripts/fetch-crossings.js`): 6 of 23 segments cross a mapped stream, none crosses a river, so no river-flow data is used there.
- Climate inputs are on a 10 km grid. The 23 segments share 4 cells, so neighbouring kilometres have the same climate numbers. Slope, vegetation and crossings are what differ per kilometre.
- Humidity (for wildfire weather) comes from Open-Meteo's archive and from the climate models that report it. Cells cached before humidity was added show wildfire and drought as unavailable, with the reason, until they are refetched.
- Weather history and CMIP6 responses are cached in the `corridor_climate_cells` Data table. The cache was filled by `scripts/fetch-climate-cells.js` run from a laptop, because Open-Meteo's free tier refuses n8n Cloud's shared IP. The cache stores the response hash of every download.
- Operator names in the demo are fictional. We make no claims about any real company or community.

## Assumptions (editable on the dashboard)
Base failure rate per km-year, risk multiplier, mitigation effectiveness, inspection cost, inspection cycle, program cost, lease rate per acre (default $400, conservative), panel strip width (default 60 m total, outside the 30 m exclusion; the 200 m-each-side study area is used only for scoring, never counted as leasable), acres per MW, performance ratio, grid emission factor, risk weights and tier thresholds, fire-weather day definition (no rain, 25 °C or hotter, minimum humidity 35% or lower), dry-soil percentile (10th), full-exposure points (20 fire-weather days a year, 200 m³/s peak flow), crossing size weights, and the per-hazard weights. Sourced values: $430k average ground-movement failure damage (AWWA Opflow via LA County), $11.7M one geohazard gas rupture (WSB). Thresholds and weights are provisional, for expert review.

## Not claimed
- No failures prevented, no measured cost or labour savings, no regulatory compliance, no real deployment. The 0-100 score is a priority index, not a validated failure probability.
- No email, Slack, SAP or Maximo delivery and no crew dispatch. An approved work order is a row in an n8n Data table and a CSV export.
- The $430k figure is an average ground-movement failure cost for water mains, not an oil and gas number. The $11.7M figure is one incident. Base failure rate, mitigation effectiveness, inspection costs and the idea of extending inspection cycles (which needs regulator approval) are assumptions.
- Solar is a screening layer. The operator may not hold the land rights, and nothing is contracted. Solar income is never counted in the pipeline-protection result.
- Any subscription price for the tool is hypothetical and is not a customer saving.
- Not a weather forecast past 16 days. 5 to 10 year outputs are projected frequencies from climate models.
- The learned model, if shipped, is trained on US data and applied to Alberta. First calibration, not validated.
- Clean energy figures are reported on their own and never as an offset of pipeline emissions.

## Platform rewrite (2026-11-16)

- Class location on the Edmonton line uses real City of Edmonton open data (building permits, development permits, 2019 rooflines, plans in effect), fetched 2026-11-16. Contains information licensed under the Open Government Licence - City of Edmonton.
- The route is a public OpenStreetMap pipeline way. No operator is involved, and nothing claims the line has a class location obligation.
- Dwelling counts are estimates (one roof of 60 m2 or more counts as one dwelling) until a crew counts. Class change dates rest on an assumed construction lag.
- The replay result (2 of 2 changes, 9 months) is not a measured lead time. It restates the lag assumption.
- CSA Z662 counting rules were not verified; thresholds follow 49 CFR 192.5.
- Every cost in the decision comparison is a placeholder. The page and the draft PDF say so.
- The land obligation rows and the commitment table excerpt are invented examples. No real agreement, landowner or filing is in the repo.
- The draft plan PDF is a draft for an engineer, not a filing.
- The four new n8n workflows have not been run in n8n.
- Built with Claude (Anthropic) on 2026-11-16.
