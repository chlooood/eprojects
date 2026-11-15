# Dataset attribution

- Route and waterways: © OpenStreetMap contributors, ODbL. https://www.openstreetmap.org/copyright. Way 103560579 version 23, mapping source tags retained in `raw/osm-way.json`. This is public mapping and has not been verified by the named operator.
- Contains modified Copernicus Sentinel data (2021, 2023–2025), accessed 2026-11-15 through Element84 Earth Search Collection 1 and the AWS Open Data Registry: https://registry.opendata.aws/sentinel-2-l2a-cogs/. Individual STAC item/asset metadata, file checksums and derived-window hashes are retained in `raw/ndvi-*.json`.
- Copernicus Digital Elevation Model, accessed 2026-11-15 from https://registry.opendata.aws/copernicus-dem/. The linked Copernicus licence applies to the source data. Surface-elevation samples are not surveyed pipeline elevations.
- Climate/history/forecast: Open-Meteo archive, climate and forecast APIs, with three named CMIP6 models. Endpoint URLs, dates and response hashes are retained in the cache records. https://open-meteo.com/.
- Irradiance: NASA POWER climatology, https://power.larc.nasa.gov/. Its source response and annual value are retained in `solar.json`.
- Historical context: Canada Energy Regulator and BC Ministry of Transportation sources linked in `evidence.json`. No regulator route geometry, reports or photographs were copied into the app. Context is paraphrased and linked, not a claim of asset damage.
