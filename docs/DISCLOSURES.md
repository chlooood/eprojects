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
- AI models, called through n8n AI gateway credits: Claude Haiku 5.5 (W2 risk explanations), OpenAI gpt-5.4-mini (WF4 work order summaries), OpenAI gpt-5-mini (W5 weekly report narrative). Each output is checked against the computed numbers and falls back to fixed template text if the check fails or the call errors.
- n8n templates used as patterns: list template numbers here

## What is real and what is not
- Demo corridor in `data/demo/`: SYNTHETIC. Illustrative route, simulated climate and humidity series, illustrative waterways and river flows, run through the real engine. Labelled on the dashboard.
- Wildfire weather is a simple hot-dry-rainless day count, not a Canadian Fire Weather Index. Drought is soil dryness and dry spells, not a drought index. Both are provisional, for expert review.
- Live n8n run: real climate, elevation, irradiance and Sentinel-2 NDVI data. The route comes from OpenStreetMap through W1, and falls back to an embedded fixture route (labelled synthetic on the dashboard) if Overpass fails.
- Weather history and CMIP6 responses are cached in the `corridor_climate_cells` Data table. The cache was filled by `scripts/fetch-climate-cells.js` run from a laptop, because Open-Meteo's free tier refuses n8n Cloud's shared IP. The cache stores the response hash of every download.
- Operator names in the demo are fictional. We make no claims about any real company or community.

## Assumptions (editable on the dashboard)
Base failure rate per km-year, risk multiplier, mitigation effectiveness, inspection cost, inspection cycle, program cost, lease rate per acre (default $400, conservative), panel strip width (default 60 m total, outside the 30 m exclusion; the 200 m-each-side study area is used only for scoring, never counted as leasable), acres per MW, performance ratio, grid emission factor, risk weights and tier thresholds, fire-weather day definition (no rain, 25 °C or hotter, minimum humidity 35% or lower), dry-soil percentile (10th), full-exposure points (20 fire-weather days a year, 200 m³/s peak flow), crossing size weights, and the per-hazard weights. Sourced values: $430k average ground-movement failure damage (AWWA Opflow via LA County), $11.7M one geohazard gas rupture (WSB). Thresholds and weights are provisional, for expert review.

## Not claimed
- Not a weather forecast past 16 days. 5 to 10 year outputs are projected frequencies from climate models.
- The learned model, if shipped, is trained on US data and applied to Alberta. First calibration, not validated.
- Clean energy figures are reported on their own and never as an offset of pipeline emissions.
